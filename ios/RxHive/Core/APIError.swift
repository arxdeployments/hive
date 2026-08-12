import Foundation

/// A failed API call, classified by what the user (or the caller) should do about it.
enum APIError: Error, Equatable {
    /// No usable session, *proven* — the server was reached and refused the
    /// refresh token. Only this warrants returning to sign-in. A refresh that
    /// could not be delivered is `.transport`, because it establishes nothing
    /// about the session and must never cost the user their credentials.
    case unauthorized
    /// A 401 from an endpoint where it means "the credentials you just typed are
    /// wrong" rather than "your session lapsed": /login, /refresh, /change-password.
    /// Separate from `.unauthorized` so the sign-in screen can say what the server
    /// said ("Invalid email or password") instead of asserting an expiry that
    /// never happened — the single most confusing symptom of the old behaviour.
    case credentials(detail: String)
    /// Authenticated, but this client/account is not allowed. Carries the server's
    /// `detail`, which for the mobile gate is a sentence written to be shown as-is,
    /// and — when the server sent one — the stable code saying *which* refusal it is.
    /// `denial` is nil for every 403 that is not the mobile gate.
    case forbidden(detail: String, denial: MobileDenialKind?)
    /// A *delivered* refresh rejected with a 403: the server was reached, was given
    /// the refresh token, and refused it. Terminal by construction — the same
    /// evidence as `.unauthorized`, which is why it is a case and not a flavour of
    /// `.forbidden`.
    ///
    /// The distinction earns its keep because the two arrive from opposite places. An
    /// ordinary `.forbidden` is one endpoint refusing one resource ("You are not a
    /// member of this group") and must never cost the user their session. This is the
    /// session itself being refused. They were the same case until a 403 with no
    /// denial code — an older backend, or a denial this build has not heard of — left
    /// a provably-dead credential in the jar: `endsSession` was reading the routing
    /// code, which says which screen to show and nothing about whether the session
    /// survived. Every relaunch then spent another doomed refresh on it.
    ///
    /// `denial` still carries the code when there is one, so routing is unchanged.
    case sessionRefused(detail: String, denial: MobileDenialKind?)
    case notFound
    /// 400/409/422 — the server explained what was wrong with the request.
    case validation(detail: String)
    /// 429. `retryAfter` is seconds, when the server said.
    case rateLimited(retryAfter: TimeInterval?)
    /// 5xx.
    case server(status: Int, detail: String?)
    /// The request never completed (offline, DNS, TLS, timeout).
    case transport(underlying: String)
    /// 200, but the body was not what the contract promised.
    case decoding(underlying: String)

    /// Copy safe to put in front of a user.
    var userMessage: String {
        switch self {
        case .unauthorized:
            return "Your session expired. Please sign in again."
        case .credentials(let detail):
            return detail.isEmpty ? "Those details didn't work. Please try again." : detail
        case .forbidden(let detail, _):
            // The backend's mobile-gate messages are already user-facing prose
            // ("Mobile access has not been enabled for this account…"), so they
            // are shown verbatim rather than replaced with something vaguer.
            return detail.isEmpty ? "You don't have access to this." : detail
        case .sessionRefused(let detail, _):
            // Same prose when the server sent some. With none, this is an expiry the
            // user has to act on, not a resource they cannot reach.
            return detail.isEmpty ? "Your session expired. Please sign in again." : detail
        case .notFound:
            return "That's no longer available."
        case .validation(let detail):
            return detail.isEmpty ? "That didn't look right. Check and try again." : detail
        case .rateLimited(let retryAfter):
            if let seconds = retryAfter, seconds > 0 {
                return "Too many attempts. Try again in \(Int(seconds.rounded())) seconds."
            }
            return "Too many attempts. Try again shortly."
        case .server:
            return "Something went wrong on our end. Please try again."
        case .transport:
            return "No connection. Check your network and try again."
        case .decoding:
            return "Something went wrong. Please try again."
        }
    }

    /// True when retrying the identical request could plausibly succeed.
    var isRetryable: Bool {
        switch self {
        case .transport, .server, .rateLimited: return true
        case .unauthorized, .credentials, .forbidden, .sessionRefused, .notFound, .validation, .decoding:
            return false
        }
    }

    /// True when the session is over as a matter of fact, not of guesswork — the
    /// only condition under which stored credentials may be discarded.
    var endsSession: Bool {
        switch self {
        // Both mean the same thing: the server was reached, was handed the refresh
        // token, and refused it. Nothing else about the response can change that, and
        // in particular the denial code cannot — it selects a screen.
        case .unauthorized, .sessionRefused: return true
        // An ordinary 403 is about one resource and must never end a session. A coded
        // mobile denial is the exception: it says this account cannot use the app at
        // all, so a credential for it is worth dropping wherever it turned up.
        case .forbidden: return isMobileAccessDenied
        default: return false
        }
    }

    /// True when the failure means "this account cannot use the mobile app",
    /// as opposed to any other 403. Drives the dedicated sign-in denial screen.
    ///
    /// A 403 counts only if the server named it with a denial code. This was
    /// previously a substring test on `detail` ("mobile access", "web app"), which
    /// made every wording decision on the backend an authorization decision here:
    /// a copy edit could drop an account out of this screen and into "session
    /// expired", and an unrelated 403 that happened to mention the web app could
    /// fall into it. Requiring the code errs the safe way — an unrecognised 403 is
    /// simply not treated as the mobile gate.
    var isMobileAccessDenied: Bool {
        mobileDenial != nil
    }

    /// Which mobile denial this is, if it is one at all.
    ///
    /// Both cases that can carry a code are read here, so callers choosing a screen
    /// never have to care whether the refusal arrived on a login response or on a
    /// refresh rejection.
    var mobileDenial: MobileDenialKind? {
        switch self {
        case .forbidden(_, let denial), .sessionRefused(_, let denial): return denial
        default: return nil
        }
    }
}

/// Which of the two mobile 403s a denial is, and therefore which remedy to offer.
///
/// The raw values are the backend's own denial codes (`api/auth.py`:
/// `SUPERADMIN_MOBILE_DENIED_CODE`, `MOBILE_NOT_APPROVED_CODE`), and that is the
/// entire point of the type. This used to be decided by looking for phrases in the
/// user-facing sentence, and the two sentences are not reliably distinguishable:
/// `MOBILE_NOT_APPROVED` ends "Ask your super admin to approve mobile sign-in" — it
/// names the person who can fix it — so a test for "super admin" matched *both*
/// 403s and sent every un-granted member to the superadmin screen: titled "Use the
/// web app", with the panel naming their actual remedy suppressed, directly above
/// the server's own sentence telling them to ask an admin. A code cannot be
/// reworded by an edit to the copy.
///
/// Lives in Core, beside the error it arrives on, because it is a wire contract
/// rather than a detail of the screen that renders it.
enum MobileDenialKind: String, Equatable {
    /// A super admin account. Nothing can be granted — the portal is web-only.
    case superadminWebOnly = "SUPERADMIN_MOBILE_DENIED"
    /// A member who simply has not been approved yet. A super admin can fix it.
    case notApproved = "MOBILE_NOT_APPROVED"
}

/// FastAPI's error envelope: `{"detail": ...}`.
///
/// `detail` is a string for `HTTPException`, but an *array* of per-field objects
/// for a 422 validation error. Decoding it as `String` blindly turns every 422
/// into a decoding failure, which hides the real problem, so both shapes are
/// handled.
struct APIErrorBody: Decodable {
    let detail: String
    /// Present only where the server has committed to a stable code for a refusal
    /// the client must branch on (`core/errors.py`: `CodedHTTPException`). Optional
    /// because the ordinary envelope has no such field, and absence must decode
    /// cleanly rather than turning an error response into a decoding failure.
    let code: String?

    private struct ValidationItem: Decodable {
        let loc: [LocComponent]?
        let msg: String?

        /// `loc` entries are strings or integers ("body", 0, "email").
        enum LocComponent: Decodable {
            case string(String), int(Int)

            init(from decoder: Decoder) throws {
                let container = try decoder.singleValueContainer()
                if let value = try? container.decode(String.self) {
                    self = .string(value)
                } else if let value = try? container.decode(Int.self) {
                    self = .int(value)
                } else {
                    self = .string("?")
                }
            }

            var text: String {
                switch self {
                case .string(let value): return value
                case .int(let value): return String(value)
                }
            }
        }

        /// "email: value is not a valid email address"
        var described: String {
            // Drop the leading "body"/"query" — it names the transport, not a field.
            let field = (loc ?? []).map(\.text).drop(while: { $0 == "body" || $0 == "query" })
            let name = field.joined(separator: ".")
            let message = msg ?? "is invalid"
            return name.isEmpty ? message : "\(name): \(message)"
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if let text = try? container.decode(String.self, forKey: .detail) {
            detail = text
        } else if let items = try? container.decode([ValidationItem].self, forKey: .detail) {
            detail = items.map(\.described).joined(separator: "\n")
        } else {
            detail = ""
        }
        code = try? container.decodeIfPresent(String.self, forKey: .code)
    }

    private enum CodingKeys: String, CodingKey { case detail, code }
}

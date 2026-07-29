import Foundation

/// A failed API call, classified by what the user (or the caller) should do about it.
enum APIError: Error, Equatable {
    /// No usable session. The caller should return to sign-in.
    case unauthorized
    /// Authenticated, but this client/account is not allowed. Carries the server's
    /// `detail`, which for the mobile gate is a sentence written to be shown as-is.
    case forbidden(detail: String)
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
        case .forbidden(let detail):
            // The backend's mobile-gate messages are already user-facing prose
            // ("Mobile access has not been enabled for this account…"), so they
            // are shown verbatim rather than replaced with something vaguer.
            return detail.isEmpty ? "You don't have access to this." : detail
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
        case .unauthorized, .forbidden, .notFound, .validation, .decoding: return false
        }
    }

    /// True when the failure means "this account cannot use the mobile app",
    /// as opposed to any other 403. Drives the dedicated sign-in denial screen.
    var isMobileAccessDenied: Bool {
        guard case .forbidden(let detail) = self else { return false }
        let lowered = detail.lowercased()
        return lowered.contains("mobile access") || lowered.contains("web app")
    }
}

/// FastAPI's error envelope: `{"detail": ...}`.
///
/// `detail` is a string for `HTTPException`, but an *array* of per-field objects
/// for a 422 validation error. Decoding it as `String` blindly turns every 422
/// into a decoding failure, which hides the real problem, so both shapes are
/// handled.
struct APIErrorBody: Decodable {
    let detail: String

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
    }

    private enum CodingKeys: String, CodingKey { case detail }
}

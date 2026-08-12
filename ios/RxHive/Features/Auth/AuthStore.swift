import Foundation
import os
import SwiftUI

/// Owns "who is signed in", and the only thing allowed to decide that nobody is.
@MainActor
final class AuthStore: ObservableObject {

    enum Phase: Equatable {
        /// Splash is on screen; we haven't decided anything yet.
        case launching
        /// No session — show sign-in.
        case signedOut
        /// Signed in and cleared for mobile.
        case signedIn(CurrentUser)
        /// Authenticated, but this account may not use the mobile app. A separate
        /// phase from `signedOut` because the copy has to explain *why*, or the
        /// user will simply retype their password until they give up.
        ///
        /// `reason` is the server's sentence, shown as-is; `denial` is its code, and
        /// the only thing that selects between the two screens. Carried together so
        /// the view never has to read the prose to work out which one it is.
        case accessDenied(reason: String, denial: MobileDenialKind)
    }

    @Published private(set) var phase: Phase = .launching
    /// Sign-in form error, shown inline under the fields.
    @Published var signInError: String?
    @Published var isSigningIn = false

    let realtime = RealtimeClient()

    private let api: APIClient
    private let log = Logger(subsystem: "ai.rhythmrx.rxhive", category: "auth")
    private var expiryObserver: NSObjectProtocol?

    /// Incremented by every sign-in and every completed sign-out. A teardown that
    /// began under an older generation is stale and must not clear the cookies of
    /// the session that replaced it — the failure mode being "it signed me out
    /// immediately after I signed back in", which is unreproducible on demand.
    private var sessionGeneration = 0

    /// Set when a launch could not reach the server. The session was never
    /// disproved, so the app stays signed in optimistically and retries; without
    /// this, opening the app in a lift or on a plane is a one-way trip to sign-in.
    private var pendingRevalidation: Task<Void, Never>?

    /// What a session re-check established. Same three-way distinction as
    /// `RefreshOutcome`, for the same reason: the socket must not treat a dead
    /// radio as a dead session.
    enum SessionCheck { case valid, rejected, unreachable }

    var currentUser: CurrentUser? {
        if case .signedIn(let user) = phase { return user }
        return nil
    }

    /// `api` is injectable for tests only — the app builds this with the default.
    /// Without a seam the launch path cannot be driven at all: it reaches the network
    /// through the shared client, which no `MockURLProtocol` session can stand in for.
    init(api: APIClient = .shared) {
        self.api = api

        expiryObserver = NotificationCenter.default.addObserver(
            forName: APIClient.sessionExpiredNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            let detail = note.userInfo?[APIClient.detailKey] as? String ?? ""
            let status = note.userInfo?[APIClient.statusKey] as? Int ?? 401
            let denial = (note.userInfo?[APIClient.denialKey] as? String)
                .flatMap(MobileDenialKind.init(rawValue:))
            Task { @MainActor in
                await self?.handleSessionLost(status: status, detail: detail, denial: denial)
            }
        }

        // The socket's token-expiry path asks us to refresh; a plain /me is the
        // cheapest way to force the client through its own refresh-and-replay.
        realtime.onTokenExpired = { [weak self] in
            guard let self else { return .unreachable }
            return await self.revalidateSession()
        }
        realtime.onUnauthorized = { [weak self] reason in
            // A close frame carries a code and a reason string, not a JSON envelope,
            // so there is no denial code to pass — as before, this lands on "session
            // expired". A revoked grant still reaches its own screen: the next API
            // call or refresh gets the coded 403.
            Task { @MainActor in
                await self?.handleSessionLost(status: 401, detail: reason, denial: nil)
            }
        }
    }

    // MARK: - Launch

    /// Decide the opening screen. Called once, behind the splash animation.
    ///
    /// The splash is not a fake delay to look busy — it is the window in which
    /// this runs. A returning user gets the chat list with no sign-in flash;
    /// only if there is no usable session do we fall through to sign-in.
    func restoreSession(minimumSplash: Duration = .milliseconds(1600)) async {
        let splash = Task { try? await Task.sleep(for: minimumSplash) }

        var restored: CurrentUser?
        var unreachable = false

        if await api.hasPersistedSession() {
            do {
                // A 401 here is expected and healthy: the access cookie carries a
                // 15-minute Max-Age, so any launch after a coffee break starts
                // without one. `APIClient` refreshes and replays underneath this
                // call — which it could not do while `/api/auth/me` was lumped in
                // with `/login` as a path that must never refresh.
                restored = try await api.send(.get, "/api/auth/me", as: CurrentUser.self)
            } catch let error as APIError {
                // 403 here means the grant was pulled while the app was closed.
                if case .forbidden(let detail, .some(let denial)) = error {
                    await splash.value
                    await api.clearSessionCookies()
                    sessionGeneration &+= 1
                    phase = .accessDenied(reason: detail, denial: denial)
                    return
                }
                // Reached and refused, so the cookie in the jar is provably dead.
                // `handleSessionLost` cannot do this for us — it is gated on
                // `.signedIn` and we are still `.launching`, so the notification
                // `APIClient` posted on the way here was a no-op. Left alone the dead
                // cookie survives every relaunch, and `hasPersistedSession()` keeps
                // sending the splash through a refresh that can only be refused again.
                //
                // `endsSession` rather than a second hand-rolled test: it is the
                // predicate written for this decision, and the only one with a test
                // pinning the permissive direction shut.
                if error.endsSession {
                    await api.clearSessionCookies()
                    RememberedUser.clear()
                }
                unreachable = error.isRetryable
                log.notice("Session restore failed: \(String(describing: error), privacy: .public)")
            } catch {
                unreachable = true
                log.notice("Session restore failed: \(error.localizedDescription, privacy: .public)")
            }
        }

        await splash.value

        if let restored {
            enterSignedIn(restored)
        } else if unreachable, let remembered = RememberedUser.load() {
            // Could not ask, and we know who was signed in. Come up signed in and
            // keep checking: every screen already handles a failed load, whereas
            // sign-in is a dead end that costs a password for a session that is
            // very probably still valid. The cookies are untouched either way.
            log.notice("Restoring offline; will revalidate when the server answers")
            enterSignedIn(remembered)
            scheduleRevalidation()
        } else {
            phase = .signedOut
        }
    }

    /// Retry `/me` on a bounded backoff after an offline launch, so the app
    /// self-corrects — whether that means confirming the session or discovering it
    /// really is gone — without the user having to relaunch.
    private func scheduleRevalidation() {
        pendingRevalidation?.cancel()
        pendingRevalidation = Task { [weak self] in
            for delay in [2, 5, 15, 30, 60] {
                try? await Task.sleep(for: .seconds(delay))
                guard let self, !Task.isCancelled else { return }
                if await self.revalidateSession() != .unreachable { return }
            }
        }
    }

    // MARK: - Sign in

    func signIn(email: String, password: String) async {
        guard !isSigningIn else { return }
        isSigningIn = true
        signInError = nil
        defer { isSigningIn = false }

        // A stale rx_refresh from a previous account would otherwise still be in
        // the jar; login overwrites it, but clearing first keeps a failed login
        // from leaving two identities' cookies side by side.
        struct Body: Encodable {
            let email: String
            let password: String
            /// The field that triggers the server-side mobile gate.
            let client: String
        }

        do {
            let response: LoginResponse = try await api.send(
                .post,
                "/api/auth/login",
                body: Body(email: email.trimmed, password: password, client: AppConfig.clientKind),
                as: LoginResponse.self
            )
            // Superadmins are rejected server-side, so this should be unreachable.
            // Checked anyway: if the gate is ever relaxed, this app still must not
            // present a portal it does not implement.
            guard response.user.role != .superadmin else {
                await api.clearSessionCookies()
                phase = .accessDenied(reason: AuthCopy.superadminWebOnly, denial: .superadminWebOnly)
                return
            }
            // Fetch /me for the fields login omits (avatar, about, presence).
            let full = (try? await api.send(.get, "/api/auth/me", as: CurrentUser.self)) ?? response.user
            enterSignedIn(full)
        } catch let error as APIError {
            if case .forbidden(let detail, .some(let denial)) = error {
                phase = .accessDenied(reason: detail, denial: denial)
                return
            }
            signInError = error.userMessage
        } catch {
            signInError = APIError.transport(underlying: error.localizedDescription).userMessage
        }
    }

    // MARK: - Sign out

    func signOut() async {
        realtime.disconnect()
        pendingRevalidation?.cancel()
        // Best-effort: the point is to revoke the refresh token server-side, but a
        // user on a plane still expects the button to work.
        _ = try? await api.sendIgnoringResponse(.post, "/api/auth/logout")
        await api.clearSessionCookies()
        sessionGeneration &+= 1
        RememberedUser.clear()
        phase = .signedOut
        signInError = nil
    }

    /// Leave the access-denied screen and go back to the form.
    func dismissAccessDenied() {
        phase = .signedOut
    }

    // MARK: - Internals

    private func enterSignedIn(_ user: CurrentUser) {
        sessionGeneration &+= 1
        RememberedUser.save(user)
        phase = .signedIn(user)
        realtime.connect()
    }

    /// Re-check the session, letting `APIClient` do its refresh-and-replay.
    ///
    /// Returns `.unreachable` — not `.rejected` — when the check could not be
    /// delivered. The socket calls this every time the server closes 4001, which is
    /// every 15 minutes for every connected user, so this method samples network
    /// health constantly. Reporting a missed sample as a rejection is what turned
    /// one bad moment on a lift ride into a forced re-login.
    private func revalidateSession() async -> SessionCheck {
        do {
            let user = try await api.send(.get, "/api/auth/me", as: CurrentUser.self)
            if case .signedIn = phase {
                phase = .signedIn(user)
                RememberedUser.save(user)
            }
            return .valid
        } catch let error as APIError where error.isMobileAccessDenied {
            if case .forbidden(let detail, .some(let denial)) = error {
                await api.clearSessionCookies()
                sessionGeneration &+= 1
                RememberedUser.clear()
                realtime.disconnect()
                phase = .accessDenied(reason: detail, denial: denial)
            }
            return .rejected
        } catch let error as APIError {
            return error.isRetryable ? .unreachable : .rejected
        } catch {
            return .unreachable
        }
    }

    /// End the session for real. Only reached when the server was contacted and
    /// refused — never for a transport failure, a 5xx or a 429.
    private func handleSessionLost(status: Int, detail: String, denial: MobileDenialKind?) async {
        guard case .signedIn = phase else { return }
        let generation = sessionGeneration

        realtime.disconnect()
        pendingRevalidation?.cancel()

        // Awaited, and generation-checked, before the phase flips. As a detached
        // `Task` this could land after a subsequent successful sign-in and delete
        // the *new* session's cookies, producing a second spurious sign-out that
        // looks like a loop.
        await api.clearSessionCookies()
        guard generation == sessionGeneration, case .signedIn = phase else { return }
        sessionGeneration &+= 1
        RememberedUser.clear()

        // A withdrawn mobile grant has its own screen and its own sentence, written
        // precisely so the user does not sit there retyping a password that will
        // never work. Route to it instead of flattening it into "session expired".
        //
        // Gated on the denial code, not on `status == 403` plus a non-empty sentence:
        // any 403 the refresh path reports would otherwise land on a screen that
        // asserts this is the mobile gate and tells the user to ask a super admin.
        if let denial {
            phase = .accessDenied(reason: detail, denial: denial)
        } else {
            phase = .signedOut
            signInError = AuthCopy.sessionExpired
        }
    }

    // MARK: - Foreground / background

    func applicationDidEnterBackground() {
        realtime.applicationDidEnterBackground()
    }

    func applicationWillEnterForeground() {
        guard case .signedIn = phase else { return }
        realtime.applicationWillEnterForeground()
        // Cheap liveness check: catches a grant revoked while backgrounded. If it
        // cannot be delivered, keep retrying rather than shrugging — this is also
        // the path that recovers a session restored offline at launch.
        Task { [weak self] in
            guard let self else { return }
            if await self.revalidateSession() == .unreachable { self.scheduleRevalidation() }
        }
    }
}

enum AuthCopy {
    static let superadminWebOnly = "Super admin accounts can only sign in on the web app."
    static let sessionExpired = "Your session expired. Please sign in again."
}

/// The last account known to be signed in, so a launch with no network can bring
/// the app up instead of demanding a password for a session that is still valid.
///
/// Deliberately not the Keychain and deliberately not a credential: this is the
/// same identity `/api/auth/me` returns and holds no secret. The actual session
/// still lives only in the httpOnly cookies, so a copy of this file grants
/// nothing — and every request still has to satisfy the server.
/// Stored in the server's own wire shape and read back through
/// `CurrentUser.init(from:)`, rather than by making `CurrentUser` `Encodable`.
/// That type is `Decodable`-only on purpose — its `CodingKeys` carry a
/// `display_name` alias with no stored property — and round-tripping through the
/// real decoder also guarantees the restored value is one the decoder could
/// actually have produced. Only the fields needed to render the app shell are
/// kept; the rest are optional on the wire and arrive with the next `/me`.
enum RememberedUser {
    private static let key = "rxhive.rememberedUser"

    static func save(_ user: CurrentUser) {
        var payload: [String: Any] = [
            "id": user.id,
            "email": user.email,
            "name": user.name,
            "role": user.role.rawValue,
        ]
        payload["org_id"] = user.orgId
        payload["dept_id"] = user.deptId
        payload["avatar_url"] = user.avatarURL
        payload["about"] = user.about
        payload["mobile_access"] = user.mobileAccess
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        UserDefaults.standard.set(data, forKey: key)
    }

    static func load() -> CurrentUser? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(CurrentUser.self, from: data)
    }

    static func clear() {
        UserDefaults.standard.removeObject(forKey: key)
    }
}

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}

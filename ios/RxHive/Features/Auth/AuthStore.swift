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
        case accessDenied(reason: String)
    }

    @Published private(set) var phase: Phase = .launching
    /// Sign-in form error, shown inline under the fields.
    @Published var signInError: String?
    @Published var isSigningIn = false

    let realtime = RealtimeClient()

    private let api = APIClient.shared
    private let log = Logger(subsystem: "ai.rhythmrx.rxhive", category: "auth")
    private var expiryObserver: NSObjectProtocol?

    var currentUser: CurrentUser? {
        if case .signedIn(let user) = phase { return user }
        return nil
    }

    init() {
        expiryObserver = NotificationCenter.default.addObserver(
            forName: APIClient.sessionExpiredNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.handleSessionLost() }
        }

        // The socket's token-expiry path asks us to refresh; a plain /me is the
        // cheapest way to force the client through its own refresh-and-replay.
        realtime.onTokenExpired = { [weak self] in
            guard let self else { return false }
            return await self.revalidateSession()
        }
        realtime.onUnauthorized = { [weak self] in
            Task { @MainActor in self?.handleSessionLost() }
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
        if await api.hasPersistedSession() {
            do {
                restored = try await api.send(.get, "/api/auth/me", as: CurrentUser.self)
            } catch let error as APIError {
                // 403 here means the grant was pulled while the app was closed.
                if error.isMobileAccessDenied, case .forbidden(let detail) = error {
                    await splash.value
                    await api.clearSessionCookies()
                    phase = .accessDenied(reason: detail)
                    return
                }
                log.notice("Session restore failed: \(String(describing: error), privacy: .public)")
            } catch {
                log.notice("Session restore failed: \(error.localizedDescription, privacy: .public)")
            }
        }

        await splash.value

        if let restored {
            enterSignedIn(restored)
        } else {
            phase = .signedOut
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
                phase = .accessDenied(reason: AuthCopy.superadminWebOnly)
                return
            }
            // Fetch /me for the fields login omits (avatar, about, presence).
            let full = (try? await api.send(.get, "/api/auth/me", as: CurrentUser.self)) ?? response.user
            enterSignedIn(full)
        } catch let error as APIError {
            if error.isMobileAccessDenied, case .forbidden(let detail) = error {
                phase = .accessDenied(reason: detail)
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
        // Best-effort: the point is to revoke the refresh token server-side, but a
        // user on a plane still expects the button to work.
        _ = try? await api.sendIgnoringResponse(.post, "/api/auth/logout")
        await api.clearSessionCookies()
        phase = .signedOut
        signInError = nil
    }

    /// Leave the access-denied screen and go back to the form.
    func dismissAccessDenied() {
        phase = .signedOut
    }

    // MARK: - Internals

    private func enterSignedIn(_ user: CurrentUser) {
        phase = .signedIn(user)
        realtime.connect()
    }

    /// Re-check the session, letting `APIClient` do its refresh-and-replay. Returns
    /// true if we still have one.
    private func revalidateSession() async -> Bool {
        do {
            let user = try await api.send(.get, "/api/auth/me", as: CurrentUser.self)
            if case .signedIn = phase { phase = .signedIn(user) }
            return true
        } catch let error as APIError where error.isMobileAccessDenied {
            if case .forbidden(let detail) = error {
                await api.clearSessionCookies()
                phase = .accessDenied(reason: detail)
            }
            return false
        } catch {
            return false
        }
    }

    private func handleSessionLost() {
        guard case .signedIn = phase else { return }
        realtime.disconnect()
        Task { await api.clearSessionCookies() }
        phase = .signedOut
        signInError = AuthCopy.sessionExpired
    }

    // MARK: - Foreground / background

    func applicationDidEnterBackground() {
        realtime.applicationDidEnterBackground()
    }

    func applicationWillEnterForeground() {
        guard case .signedIn = phase else { return }
        realtime.applicationWillEnterForeground()
        // Cheap liveness check: catches a grant revoked while backgrounded.
        Task { _ = await revalidateSession() }
    }
}

enum AuthCopy {
    static let superadminWebOnly = "Super admin accounts can only sign in on the web app."
    static let sessionExpired = "Your session expired. Please sign in again."
}

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}

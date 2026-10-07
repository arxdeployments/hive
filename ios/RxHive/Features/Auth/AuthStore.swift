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
        /// Signed in, but an administrator reset this account's password and the
        /// server refuses everything except changing it (batch 73). Only the
        /// change-password screen is shown, and nothing session-scoped runs: no
        /// socket, no lists, no call reconcile. A phase of its own rather than a
        /// flag read inside `.signedIn`, because `currentUser` is nil here — and
        /// every store that starts work for a signed-in user asks that question, so
        /// none of them can start it by forgetting to ask a second one.
        ///
        /// The cookies are kept: this session is the one the change is made with.
        case passwordChangeRequired(CurrentUser)
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
    /// The forced change-password form's request state (batch 73). Owned here, not
    /// by the view, because the outcome is a phase change only this class may make.
    @Published private(set) var isChangingPassword = false
    @Published private(set) var passwordChangeError: String?
    /// True from the moment Sign Out is pressed until it has finished (batch 73
    /// review). `signOut` waits for an in-flight password change before it logs
    /// out, which can take as long as that request does, and the change form stays
    /// on screen meanwhile. A second change started in that window would have
    /// nothing waiting for it, so the form is refused while this is set.
    @Published private(set) var isSigningOut = false

    let realtime = RealtimeClient()

    private let api: APIClient
    private let log = Logger(subsystem: "ai.rhythmrx.rxhive", category: "auth")
    private var expiryObserver: NSObjectProtocol?
    private var passwordChangeObserver: NSObjectProtocol?

    /// Incremented by every sign-in and every completed sign-out. A teardown that
    /// began under an older generation is stale and must not clear the cookies of
    /// the session that replaced it — the failure mode being "it signed me out
    /// immediately after I signed back in", which is unreproducible on demand.
    private var sessionGeneration = 0

    /// The forced password change in flight, if any (batch 73 review). Kept so that
    /// `signOut` can wait for it. Once `change-password` is on the wire the server
    /// may commit it and answer with a new session's cookies, and cancelling the
    /// `URLSession` task does not undo that commit; it only stops this device from
    /// hearing about it. A logout sent before that answer landed would revoke the
    /// old session, and the answer would then store the new one on a phone that
    /// shows itself signed out.
    private var passwordChangeTask: Task<Void, Never>?

    /// The `sessionGeneration` in which this device's own `change-password` was
    /// answered 200, if one was (batch 73 review). That answer re-issued this
    /// device's session, so when `/me` later reports the flag clear the session can
    /// start as it is. When the flag clears without it, the change was made
    /// somewhere else, which revoked this device's refresh token; see
    /// `releaseAfterChangeElsewhere`. Tied to the generation rather than reset by
    /// hand, so every boundary that bumps it (a new hold, a sign-out, a refused
    /// session) forgets it without each having to remember to.
    private var passwordChangedHereInGeneration: Int?

    private var passwordChangedHere: Bool {
        passwordChangedHereInGeneration == sessionGeneration
    }

    /// The stores holding the signed-in person's data, so a session ending can
    /// clear them. Weak, and registered by the stores themselves in their own
    /// `attach` — mirroring how each already takes its reference to this one, and
    /// keeping this class from having to know when they are built.
    private weak var chat: ChatStore?
    private weak var calls: CallStore?

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

        // An admin reset the password (batch 73). Either half can hear it first — a
        // request refused with the coded 403, or the socket closed 4403 — and both
        // land on the same transition, which keeps the cookies.
        passwordChangeObserver = NotificationCenter.default.addObserver(
            forName: APIClient.passwordChangeRequiredNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.handlePasswordChangeRequired() }
        }
        realtime.onPasswordChangeRequired = { [weak self] in
            Task { @MainActor in self?.handlePasswordChangeRequired() }
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
                // 403 here means the grant was pulled while the app was closed. Read
                // through `mobileDenial` so it does not matter whether the refusal
                // arrived on this response or on the refresh underneath it — and note
                // an *uncoded* 403 deliberately falls through to `endsSession` below,
                // which still discards the cookie the server just refused.
                if let denial = error.mobileDenial {
                    await splash.value
                    await api.clearSessionCookies()
                    // Returning early skips the `endsSession` cleanup below, so this
                    // branch has to do its own — and a refusal this definite is the
                    // last place to keep a copy of the account. The record holds the
                    // user's email, display name, avatar, "about" text and their org
                    // and department ids; `revalidateSession` already drops it for the
                    // same denial mid-session.
                    RememberedUser.clear()
                    endSessionData()
                    sessionGeneration &+= 1
                    phase = .accessDenied(reason: error.userMessage, denial: denial)
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
                    endSessionData()
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
            if let denial = error.mobileDenial {
                phase = .accessDenied(reason: error.userMessage, denial: denial)
                return
            }
            signInError = error.userMessage
        } catch {
            signInError = APIError.transport(underlying: error.localizedDescription).userMessage
        }
    }

    // MARK: - Sign out

    func signOut() async {
        isSigningOut = true
        defer { isSigningOut = false }
        // Bumped first (batch 73 review), so that anything still running for the
        // session being ended, above all a forced password change waiting on its
        // answer, stands down at its next generation check instead of starting the
        // session this is ending. Bumped again below, once the session is gone, as
        // every completed sign-out always has been.
        sessionGeneration &+= 1
        realtime.disconnect()
        pendingRevalidation?.cancel()
        // Waited for, not cancelled (batch 73 review). If `change-password` is on
        // the wire, the server may already have committed it and be answering with
        // a new session's cookies; cancelling only stops this device hearing that
        // answer. Waiting means the logout below carries whichever session the
        // server issued, so that session is the one revoked, and the cookie clear
        // after it removes those cookies rather than running before they arrive.
        if let change = passwordChangeTask {
            await change.value
        }
        // Best-effort: the point is to revoke the refresh token server-side, but a
        // user on a plane still expects the button to work.
        _ = try? await api.sendIgnoringResponse(.post, "/api/auth/logout")
        await api.clearSessionCookies()
        sessionGeneration &+= 1
        RememberedUser.clear()
        endSessionData()
        phase = .signedOut
        signInError = nil
        passwordChangeError = nil
    }

    /// Leave the access-denied screen and go back to the form.
    func dismissAccessDenied() {
        phase = .signedOut
    }

    // MARK: - Forced password change

    /// Finish the change an admin reset demands, and only then start the session.
    ///
    /// Three requests, in this order, through the injected client (not
    /// `RxHiveAPI.changePassword`, which is wired to `.shared`):
    ///
    ///  1. `GET /api/auth/me` first, because it refreshes. `change-password` is a
    ///     no-refresh credential path (`APIClient.nonRefreshablePaths`), so its 401
    ///     can only mean "wrong current password" — and a 15-minute access cookie
    ///     that lapsed while the user read the screen would produce exactly that
    ///     401, telling them a correct temporary password was wrong.
    ///  2. `POST /api/auth/change-password`.
    ///  3. `GET /api/auth/me` again, and the phase leaves only if it says the flag is
    ///     clear. The server is the one that decides the account is usable; a 200
    ///     from step 2 is its word on the password, not on the account.
    ///
    /// The work runs in a stored `Task` (batch 73 review) so that `signOut`, which
    /// the screen offers even mid-request, can wait for it before logging out.
    func completeRequiredPasswordChange(current: String, new: String) async {
        guard case .passwordChangeRequired = phase, !isChangingPassword, !isSigningOut else { return }
        isChangingPassword = true
        passwordChangeError = nil
        let change = Task { await self.performRequiredPasswordChange(current: current, new: new) }
        passwordChangeTask = change
        await change.value
        passwordChangeTask = nil
        isChangingPassword = false
    }

    private func performRequiredPasswordChange(current: String, new: String) async {
        // A sign-out (or a refused refresh) mid-request must not be overruled by the
        // answer to a question asked for the session it ended.
        let generation = sessionGeneration
        var changed = false

        struct Body: Encodable {
            let current_password: String
            let new_password: String
        }

        do {
            let before = try await api.send(.get, "/api/auth/me", as: CurrentUser.self)
            guard generation == sessionGeneration else { return }
            if !before.mustChangePassword {
                // The temporary password is no longer the current one, so posting it
                // would only be refused. Either this device already changed it and
                // lost the confirmation (an earlier press of this button got its 200),
                // and its session was re-issued with that answer; or it was changed
                // somewhere else meanwhile, the web app most likely, which revoked
                // this device's refresh token, and the session has to be checked
                // before it is started (batch 73 review).
                if passwordChangedHere {
                    enterSignedIn(before)
                } else if await releaseAfterChangeElsewhere(before, generation: generation) == .unreachable {
                    // Nothing was learned. Stay held, say why nothing happened, and
                    // keep asking in the background; the next answer decides.
                    passwordChangeError = APIError.transport(underlying: "Refresh undelivered").userMessage
                    scheduleRevalidation()
                }
                return
            }
            try await api.sendIgnoringResponse(
                .post,
                "/api/auth/change-password",
                body: Body(current_password: current, new_password: new)
            )
            // Checked the moment the answer is back (batch 73 review): a sign-out
            // pressed while the change was out is waiting for this, and must find
            // nothing started for the session it is ending, not a `/me` on the wire
            // and a session about to be entered.
            guard generation == sessionGeneration else { return }
            changed = true
            passwordChangedHereInGeneration = generation
            let after = try await api.send(.get, "/api/auth/me", as: CurrentUser.self)
            guard generation == sessionGeneration, case .passwordChangeRequired = phase else { return }
            guard !after.mustChangePassword else {
                RememberedUser.save(after)
                phase = .passwordChangeRequired(after)
                passwordChangeError = AuthCopy.passwordChangeUnconfirmed
                return
            }
            enterSignedIn(after)
        } catch let error as APIError {
            guard generation == sessionGeneration else { return }
            if let denial = error.mobileDenial {
                await endSessionForDenial(reason: error.userMessage, denial: denial)
                return
            }
            if changed, error.isRetryable {
                // The new password is saved; only the confirmation was lost. Retyping
                // the temporary one would now be refused as wrong, so keep asking the
                // server instead — `revalidateSession` lets the session start the
                // moment `/me` reports the flag clear, directly, because the 200 this
                // device got re-issued its session (`passwordChangedHere`).
                passwordChangeError = AuthCopy.passwordChangeSavedUnconfirmed
                scheduleRevalidation()
                return
            }
            switch error {
            case .credentials:
                // The only 401 `change-password` can give, now that step 1 has renewed
                // the access cookie: the temporary password was mistyped. The server's
                // "Current password is incorrect" names a field this screen calls
                // something else.
                passwordChangeError = AuthCopy.temporaryPasswordWrong
            default:
                // A 400 is the policy (or "Choose a password different from your
                // current one."), shown verbatim because the server's numbers are the
                // real ones; a 429 is "Too many attempts".
                passwordChangeError = error.userMessage
            }
        } catch {
            guard generation == sessionGeneration else { return }
            if changed {
                passwordChangeError = AuthCopy.passwordChangeSavedUnconfirmed
                scheduleRevalidation()
                return
            }
            passwordChangeError = APIError.transport(underlying: error.localizedDescription).userMessage
        }
    }

    // MARK: - Internals

    /// Called by each session-scoped store as it attaches at launch.
    func registerSessionStore(chat: ChatStore? = nil, calls: CallStore? = nil) {
        if let chat { self.chat = chat }
        if let calls { self.calls = calls }
    }

    /// Put down everything the ending session was holding in memory.
    ///
    /// Sits beside `RememberedUser.clear()` at every boundary, and for the same
    /// reason: that call has always dropped the persisted account record — email,
    /// display name, avatar, org and department — while the far larger in-memory
    /// copy next to it, the person's threads and the message bodies in them, had
    /// nothing that dropped it and simply carried into whoever signed in next.
    ///
    /// Also called on the pre-sign-in refusal at `signIn`, where there is nothing
    /// to clear. That is deliberate: it makes the guarantee "a session never
    /// begins holding the last one's data" rather than "every exit remembered to
    /// tidy up", which would depend on having found every exit.
    private func endSessionData() {
        chat?.reset()
        calls?.resetSessionState()
    }

    /// The single way into a session, so the single place the forced
    /// change-password phase is decided (batch 73): sign-in, a restore, an offline
    /// restore of a remembered account and a revalidation all come through here.
    private func enterSignedIn(_ user: CurrentUser) {
        if user.mustChangePassword {
            enterPasswordChangeRequired(user)
            return
        }
        sessionGeneration &+= 1
        RememberedUser.save(user)
        passwordChangeError = nil
        phase = .signedIn(user)
        realtime.connect()
    }

    /// A coded 403 or a 4403 socket close. Only a running session moves: anywhere
    /// else either there is no session to hold back, or it is already held.
    private func handlePasswordChangeRequired() {
        guard case .signedIn(let user) = phase else { return }
        enterPasswordChangeRequired(user.applying(mustChangePassword: true))
    }

    /// Hold the session at the change-password screen.
    ///
    /// Everything session-scoped stops, and the cookies stay: unlike every other
    /// exit from `.signedIn`, the session is not over — it is what the change is
    /// made with. Safe to reach with nothing running (a flagged sign-in or
    /// restore), since each step is a no-op then.
    ///
    /// The call goes first, while the socket can still carry its hang-up; see
    /// `CallStore.endForPasswordChange`, which also does the call store's half of
    /// `endSessionData()` once the room is left. Not `endSessionData()` itself: its
    /// call half deliberately leaves a live call alone, and here nothing may be.
    private func enterPasswordChangeRequired(_ user: CurrentUser) {
        calls?.endForPasswordChange()
        realtime.disconnect()
        chat?.reset()
        sessionGeneration &+= 1
        // Saved with the flag, so an offline relaunch comes back up here rather than
        // in an app whose every request would be refused.
        RememberedUser.save(user)
        passwordChangeError = nil
        phase = .passwordChangeRequired(user)
    }

    /// Re-check the session, letting `APIClient` do its refresh-and-replay.
    ///
    /// Returns `.unreachable` — not `.rejected` — when the check could not be
    /// delivered. The socket calls this every time the server closes 4001, which is
    /// every 15 minutes for every connected user, so this method samples network
    /// health constantly. Reporting a missed sample as a rejection is what turned
    /// one bad moment on a lift ride into a forced re-login.
    private func revalidateSession() async -> SessionCheck {
        let generation = sessionGeneration
        do {
            let user = try await api.send(.get, "/api/auth/me", as: CurrentUser.self)
            // The session this asked about may have ended or changed hands while
            // `/me` was out (batch 73 review): a sign-out still waiting on its
            // logout, or a hold that began after this was sent, which a `/me` answered
            // before the reset would otherwise release again. Its answer describes a
            // session that is no longer the current one, so it is not acted on.
            // `.valid` is what the stale cases already returned through `default`
            // below, and the socket checks its own generation before using it.
            guard generation == sessionGeneration else { return .valid }
            switch phase {
            case .signedIn where user.mustChangePassword:
                // Reset by an admin since the last check (batch 73). `.valid`, not
                // `.rejected`, is still the right answer to the socket that asked:
                // the session is good, and the socket has just been stopped, so the
                // reconnect it would make is stranded by the generation bump.
                enterPasswordChangeRequired(user)
            case .signedIn:
                phase = .signedIn(user)
                RememberedUser.save(user)
            case .passwordChangeRequired where !user.mustChangePassword:
                if passwordChangedHere {
                    // This device's own change, whose confirmation was lost on the way
                    // back. Its 200 re-issued this device's session, so the session it
                    // was holding can start as it is.
                    enterSignedIn(user)
                } else {
                    // Changed somewhere else — the web app, another phone. That change
                    // revoked this device's refresh token, so the held session is not
                    // simply released; whether it survived is asked first (batch 73
                    // review). `.unreachable` reaches the caller, which retries.
                    return await releaseAfterChangeElsewhere(user, generation: generation)
                }
            case .passwordChangeRequired:
                phase = .passwordChangeRequired(user)
                RememberedUser.save(user)
            default:
                break
            }
            return .valid
        } catch let error as APIError {
            if let denial = error.mobileDenial {
                await endSessionForDenial(reason: error.userMessage, denial: denial)
                return .rejected
            }
            return error.isRetryable ? .unreachable : .rejected
        } catch {
            return .unreachable
        }
    }

    /// Start a held session whose flag `/me` now reports clear, when this device did
    /// not make the change (batch 73 review).
    ///
    /// A password changed somewhere else revokes every other session's refresh
    /// token, this device's included. The access cookie outlives that by up to its
    /// 15 minutes, which is why `/me` still answered; starting the session on that
    /// answer alone lasts only until the cookie lapses, and then ends as "Your
    /// session expired", which tells the user nothing about why. So one refresh is
    /// forced first, through the client's single-flight coordinator, and its answer
    /// decides:
    ///
    ///  - `.refreshed`: the session survived the change, so it starts.
    ///  - `.rejected`: it did not. End it now and say why, so the user signs in
    ///    with the password they just chose instead of wondering what expired. A
    ///    refusal that names a mobile denial goes to that screen, as everywhere else.
    ///  - `.unreachable`: nothing was learned. Stay held and return it, so the caller
    ///    retries; the cookies are not touched for a delivery failure.
    private func releaseAfterChangeElsewhere(_ user: CurrentUser, generation: Int) async -> SessionCheck {
        let outcome = await api.refreshSession()
        // A sign-out (or a refused session) while the refresh was out must not be
        // overruled by its answer — least of all by starting the session it ended.
        guard generation == sessionGeneration, case .passwordChangeRequired = phase else { return .valid }
        switch outcome {
        case .refreshed:
            enterSignedIn(user)
            return .valid
        case .rejected(_, let detail, let denial?):
            await endSessionForDenial(reason: detail, denial: denial)
            return .rejected
        case .rejected:
            await endSessionForPasswordChangedElsewhere()
            return .rejected
        case .unreachable:
            return .unreachable
        }
    }

    /// The password was changed somewhere else and this device's session did not
    /// survive it (batch 73 review). Ends the session as a refusal does, with the
    /// sentence that explains it shown on the sign-in form.
    private func endSessionForPasswordChangedElsewhere() async {
        await api.clearSessionCookies()
        sessionGeneration &+= 1
        RememberedUser.clear()
        endSessionData()
        realtime.disconnect()
        pendingRevalidation?.cancel()
        passwordChangeError = nil
        phase = .signedOut
        signInError = AuthCopy.passwordChangedElsewhere
    }

    /// The mobile grant was withdrawn: drop the session and show the denial.
    private func endSessionForDenial(reason: String, denial: MobileDenialKind) async {
        await api.clearSessionCookies()
        sessionGeneration &+= 1
        RememberedUser.clear()
        endSessionData()
        realtime.disconnect()
        phase = .accessDenied(reason: reason, denial: denial)
    }

    /// True while a session exists — running, or held at the change-password
    /// screen. Either can be refused, and a refusal ends either (batch 73).
    private var hasSession: Bool {
        switch phase {
        case .signedIn, .passwordChangeRequired: return true
        case .launching, .signedOut, .accessDenied: return false
        }
    }

    /// End the session for real. Only reached when the server was contacted and
    /// refused — never for a transport failure, a 5xx or a 429.
    private func handleSessionLost(status: Int, detail: String, denial: MobileDenialKind?) async {
        guard hasSession else { return }
        let generation = sessionGeneration

        realtime.disconnect()
        pendingRevalidation?.cancel()

        // Awaited, and generation-checked, before the phase flips. As a detached
        // `Task` this could land after a subsequent successful sign-in and delete
        // the *new* session's cookies, producing a second spurious sign-out that
        // looks like a loop.
        await api.clearSessionCookies()
        guard generation == sessionGeneration, hasSession else { return }
        sessionGeneration &+= 1
        RememberedUser.clear()
        endSessionData()

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
        switch phase {
        case .signedIn:
            realtime.applicationWillEnterForeground()
        case .passwordChangeRequired:
            // No socket while held (batch 73), but `/me` is allowed, and it is how
            // this phone learns of a password changed on the web while it sat on the
            // screen. That change revoked this phone's session, so what follows is
            // a forced refresh that either starts the session (it survived) or ends
            // it with a sentence saying why (batch 73 review), not a silent release
            // into a session that dies when its access cookie lapses.
            break
        default:
            return
        }
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
    /// Forced change-password screen (batch 73).
    static let temporaryPasswordWrong = "That temporary password is not right."
    static let passwordChangeUnconfirmed =
        "Your password change could not be confirmed. Please try again."
    static let passwordChangeSavedUnconfirmed =
        "Your new password was saved, but the app could not confirm it yet. "
        + "It will keep trying — or sign out and sign in with your new password."
    /// Shown on the sign-in form, where `sessionExpired` is, when the password was
    /// changed on another device and this one's session did not survive it (batch
    /// 73 review). "Session expired" would leave the user guessing; this tells them
    /// which password to use.
    static let passwordChangedElsewhere = "Your password was changed. Sign in with your new password."
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
        // Kept so an offline relaunch of a held account comes back up at the
        // change-password screen, not in the app (batch 73).
        payload["must_change_password"] = user.mustChangePassword
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

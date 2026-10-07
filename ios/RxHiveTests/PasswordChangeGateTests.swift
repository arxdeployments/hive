import Combine
import XCTest

@testable import RxHive

/// The forced change-password phase (batch 73).
///
/// An admin password reset sets `users.must_change_password`, and the admin is shown
/// the temporary password. Until this pass nothing read the flag, so the account
/// stayed fully usable with a password somebody else knew. The server now refuses
/// every route but changing it; these tests pin the client's half: that each way
/// into a session honours the flag, that the session is held — not ended — while
/// it is set, and that the only way out is a change the server confirms.
///
/// `RealtimeClient` cannot be injected, so any test that reaches `.signedIn` opens a
/// real socket to the Debug origin. Every `AuthStore` built here is registered for
/// teardown, which stops that socket; a test that leaves a revalidation scheduled
/// signs out before it ends so the retry cannot land in a later test's script.
@MainActor
final class PasswordChangeGateTests: XCTestCase {

    private var jar: HTTPCookieStorage!
    private var built: [AuthStore] = []
    private var expiryNotices: NotificationRecorder!
    private var passwordNotices: NotificationRecorder!

    private static let codedRefusal =
        #"{"detail":"You must change your password before continuing.","code":"PASSWORD_CHANGE_REQUIRED"}"#
    private static let notAuthenticated = #"{"detail":"Not authenticated"}"#
    private static let temporary = "Temp0rary-pass"
    private static let chosen = "Brand-new-pass-42"

    override func setUp() {
        super.setUp()
        MockURLProtocol.reset()
        jar = Self.isolatedCookieJar()
        RememberedUser.clear()
        expiryNotices = NotificationRecorder(name: APIClient.sessionExpiredNotification)
        passwordNotices = NotificationRecorder(name: APIClient.passwordChangeRequiredNotification)
    }

    override func tearDown() {
        for auth in built { auth.realtime.disconnect() }
        built = []
        expiryNotices.stop()
        passwordNotices.stop()
        MockURLProtocol.reset()
        for cookie in jar.cookies ?? [] { jar.deleteCookie(cookie) }
        jar = nil
        RememberedUser.clear()
        super.tearDown()
    }

    // MARK: - Fixture

    private static func isolatedCookieJar() -> HTTPCookieStorage {
        if let jar = URLSessionConfiguration.ephemeral.httpCookieStorage,
           jar !== HTTPCookieStorage.shared {
            return jar
        }
        return HTTPCookieStorage.sharedCookieStorage(
            forGroupContainerIdentifier: "ai.rhythmrx.rxhive.tests.\(UUID().uuidString)"
        )
    }

    private func makeClient() -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        config.httpCookieStorage = jar
        config.httpCookieAcceptPolicy = .always
        config.httpShouldSetCookies = true
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return APIClient(session: URLSession(configuration: config))
    }

    private func makeAuth(api: APIClient? = nil) -> AuthStore {
        let auth = AuthStore(api: api ?? makeClient())
        built.append(auth)
        return auth
    }

    private func plantRefreshCookie(file: StaticString = #filePath, line: UInt = #line) {
        guard
            let host = AppConfig.apiBaseURL.host,
            let cookie = HTTPCookie(properties: [
                .domain: host,
                .path: "/",
                .name: "rx_refresh",
                .value: "refresh-token-v1",
                .expires: Date().addingTimeInterval(30 * 24 * 3600),
            ])
        else {
            XCTFail("Could not plant rx_refresh for \(AppConfig.apiBaseURL)", file: file, line: line)
            return
        }
        jar.setCookie(cookie)
        XCTAssertTrue(hasRefreshCookie, "Test fixture: planting rx_refresh did not take", file: file, line: line)
    }

    private var hasRefreshCookie: Bool {
        (jar.cookies(for: AppConfig.apiBaseURL) ?? []).contains { $0.name == "rx_refresh" }
    }

    private static let sessionCookieNames: Set<String> = ["rx_access", "rx_refresh"]

    /// The session cookies in the jar, by name, sorted.
    private var sessionCookiesInJar: [String] {
        (jar.cookies(for: AppConfig.apiBaseURL) ?? [])
            .map(\.name)
            .filter(Self.sessionCookieNames.contains)
            .sorted()
    }

    /// Store a session's cookies, as the `Set-Cookie` on a login, refresh or
    /// change-password answer would; each value is `<name>-<version>`. Static, and
    /// handed the jar, because a `MockURLProtocol` delivery hook calls it from
    /// URLSession's own thread.
    private static func plantSession(_ version: String, in jar: HTTPCookieStorage) {
        guard let host = AppConfig.apiBaseURL.host else { return }
        for name in sessionCookieNames {
            let cookie = HTTPCookie(properties: [
                .domain: host,
                .path: "/",
                .name: name,
                .value: "\(name)-\(version)",
                .expires: Date().addingTimeInterval(3600),
            ])
            if let cookie { jar.setCookie(cookie) }
        }
    }

    private static func cookieValue(_ name: String, in jar: HTTPCookieStorage) -> String? {
        jar.cookies(for: AppConfig.apiBaseURL)?.first { $0.name == name }?.value
    }

    // Refresh answers, by what each establishes (`APIClient.postRefresh`).
    private static let refreshed = MockURLProtocol.Reply.json(200, #"{"message":"Token refreshed"}"#)
    private static let refreshRefused = MockURLProtocol.Reply.json(401, #"{"detail":"Invalid refresh token"}"#)
    private static let refreshUnreachable = MockURLProtocol.Reply.json(503, #"{"detail":"Service unavailable"}"#)

    /// The password was changed on another device while this one was held: `/me`
    /// reports the flag at the restore and clear from then on, and `refresh` — the
    /// question of whether this device's session survived — answers as given, by its
    /// ordinal.
    private func installChangedElsewhere(refresh: @escaping (Int) -> MockURLProtocol.Reply) {
        MockURLProtocol.install { request, ordinal in
            switch request.url?.path {
            case "/api/auth/me": return .json(200, Self.userJSON(flag: ordinal == 1))
            case "/api/auth/refresh": return refresh(ordinal)
            default: return .json(404, #"{"detail":"Not found"}"#)
            }
        }
    }

    /// The `/me` payload as `auth.py` sends it. `flag: nil` leaves the key out, the
    /// shape of every backend before batch 73 and of the profile `PUT` response.
    private static func userJSON(flag: Bool?, flagJSON: String? = nil) -> String {
        var fields = [
            #""id": "user-1""#,
            #""email": "nurse@example.com""#,
            #""name": "Ada Nurse""#,
            #""role": "member""#,
            #""org_id": "org-1""#,
            #""dept_id": "dept-1""#,
            #""mobile_access": true"#,
        ]
        if let flagJSON {
            fields.append(#""must_change_password": "# + flagJSON)
        } else if let flag {
            fields.append(#""must_change_password": "# + (flag ? "true" : "false"))
        }
        return "{" + fields.joined(separator: ", ") + "}"
    }

    private static func loginJSON(flag: Bool) -> String {
        #"{"user": "# + userJSON(flag: flag) + "}"
    }

    private func user(flag: Bool?) throws -> CurrentUser {
        try JSONDecoder().decode(CurrentUser.self, from: Data(Self.userJSON(flag: flag).utf8))
    }

    private func plantRememberedUser(flag: Bool, file: StaticString = #filePath, line: UInt = #line) throws {
        RememberedUser.save(try user(flag: flag))
        XCTAssertNotNil(RememberedUser.load(), "Test fixture: remembering the user did not take",
                        file: file, line: line)
    }

    /// The method and path of every request after the first `skip`.
    private func traffic(after skip: Int) -> [String] {
        MockURLProtocol.requests.dropFirst(skip).map { "\($0.method) \($0.path)" }
    }

    /// Poll for a state reached through a notification or a callback, both of which
    /// hop through a `Task` and so land a turn or two after the request returns.
    private func waitUntil(
        _ what: String,
        timeout: TimeInterval = 3,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ condition: () -> Bool
    ) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline {
                XCTFail("Timed out waiting for \(what)", file: file, line: line)
                return
            }
            try? await Task.sleep(for: .milliseconds(10))
        }
    }

    private func isHeld(_ auth: AuthStore) -> Bool {
        if case .passwordChangeRequired = auth.phase { return true }
        return false
    }

    private func isSignedIn(_ auth: AuthStore) -> Bool {
        if case .signedIn = auth.phase { return true }
        return false
    }

    /// Restore a session through the real launch path, against whatever is scripted.
    private func restored() async -> AuthStore {
        let auth = makeAuth()
        await auth.restoreSession(minimumSplash: .zero)
        return auth
    }

    // MARK: - The wire field

    func test_currentUser_flagDefaultsToFalseWhenAbsentOrNull_andReadsTrue() throws {
        let decode = { (json: String) in
            try JSONDecoder().decode(CurrentUser.self, from: Data(json.utf8)).mustChangePassword
        }
        XCTAssertFalse(try decode(Self.userJSON(flag: nil)),
                       "a payload without the key — an older backend, the profile PUT — is not held")
        XCTAssertFalse(try decode(Self.userJSON(flag: nil, flagJSON: "null")))
        XCTAssertFalse(try decode(Self.userJSON(flag: false)))
        XCTAssertTrue(try decode(Self.userJSON(flag: true)))
    }

    func test_rememberedUser_keepsTheFlag() throws {
        try plantRememberedUser(flag: true)
        XCTAssertEqual(RememberedUser.load()?.mustChangePassword, true,
                       "an offline relaunch would come back up in the app it was taken out of")
        try plantRememberedUser(flag: false)
        XCTAssertEqual(RememberedUser.load()?.mustChangePassword, false)
    }

    /// A record written before batch 73 has no key at all, and must still load —
    /// a strict decode would send every offline launch on an upgraded phone to sign-in.
    func test_rememberedUser_aRecordFromBeforeTheFlagStillLoads() throws {
        let legacy = Data(Self.userJSON(flag: nil).utf8)
        UserDefaults.standard.set(legacy, forKey: "rxhive.rememberedUser")
        let loaded = try XCTUnwrap(RememberedUser.load(), "the pre-batch-73 record no longer decodes")
        XCTAssertFalse(loaded.mustChangePassword)
    }

    // MARK: - Every way in honours the flag

    func test_flaggedSignIn_landsHeld_withNoSocket() async {
        MockURLProtocol.install { request, _ in
            switch request.url?.path {
            case "/api/auth/login": return .json(200, Self.loginJSON(flag: true))
            case "/api/auth/me": return .json(200, Self.userJSON(flag: true))
            default: return .json(404, #"{"detail":"Not found"}"#)
            }
        }
        let auth = makeAuth()

        await auth.signIn(email: "nurse@example.com", password: Self.temporary)

        guard case .passwordChangeRequired(let held) = auth.phase else {
            return XCTFail("a flagged sign-in reached \(auth.phase)")
        }
        XCTAssertEqual(held.email, "nurse@example.com")
        XCTAssertNil(auth.currentUser, "every store would see a signed-in user and start its work")
        XCTAssertEqual(auth.realtime.state, .idle, "the socket was opened for a held account")
        XCTAssertEqual(RememberedUser.load()?.mustChangePassword, true)
    }

    func test_flaggedRestore_landsHeld_withNoSocket_andKeepsTheCookie() async {
        plantRefreshCookie()
        MockURLProtocol.install { _, _ in .json(200, Self.userJSON(flag: true)) }

        let auth = await restored()

        XCTAssertTrue(isHeld(auth), "a flagged restore reached \(auth.phase)")
        XCTAssertEqual(auth.realtime.state, .idle)
        XCTAssertTrue(hasRefreshCookie, "the session the change has to be made with was discarded")
    }

    func test_offlineRestoreOfAHeldAccount_landsHeld() async throws {
        plantRefreshCookie()
        try plantRememberedUser(flag: true)
        MockURLProtocol.install { _, _ in .failing(URLError(.notConnectedToInternet)) }

        let auth = await restored()

        XCTAssertTrue(isHeld(auth), "an offline relaunch of a held account reached \(auth.phase)")
        XCTAssertEqual(auth.realtime.state, .idle)
        // Cancels the revalidation the offline launch scheduled.
        await auth.signOut()
    }

    // MARK: - The way out

    func test_completingTheChange_asksMe_changesOnce_asksMeAgain_thenStartsTheSession() async throws {
        plantRefreshCookie()
        let bodies = BodyRecorder()
        MockURLProtocol.install { request, ordinal in
            switch request.url?.path {
            case "/api/auth/me":
                // The restore and the pre-change check see the flag; the confirmation does not.
                return .json(200, Self.userJSON(flag: ordinal < 3))
            case "/api/auth/change-password":
                bodies.record(request)
                return .json(200, #"{"message":"Password changed"}"#)
            default:
                return .json(404, #"{"detail":"Not found"}"#)
            }
        }
        let auth = await restored()
        XCTAssertTrue(isHeld(auth), "precondition: held")
        let before = MockURLProtocol.requests.count

        await auth.completeRequiredPasswordChange(current: Self.temporary, new: Self.chosen)

        XCTAssertEqual(traffic(after: before), [
            "GET /api/auth/me",
            "POST /api/auth/change-password",
            "GET /api/auth/me",
        ])
        let body = try XCTUnwrap(bodies.last, "the change-password body was not captured")
        XCTAssertEqual(body["current_password"] as? String, Self.temporary)
        XCTAssertEqual(body["new_password"] as? String, Self.chosen)
        XCTAssertTrue(isSignedIn(auth), "a confirmed change left the session at \(auth.phase)")
        XCTAssertEqual(auth.currentUser?.mustChangePassword, false)
        XCTAssertNil(auth.passwordChangeError)
        XCTAssertEqual(RememberedUser.load()?.mustChangePassword, false)
        XCTAssertNotEqual(auth.realtime.state, .idle, "the session started without its socket")
    }

    /// The server is the one that says the account is usable. A 200 from the change
    /// is its word on the password; only `/me` is its word on the account.
    func test_completingTheChange_staysHeld_whenTheConfirmationStillReportsTheFlag() async {
        plantRefreshCookie()
        MockURLProtocol.install { request, _ in
            request.url?.path == "/api/auth/change-password"
                ? .json(200, #"{"message":"Password changed"}"#)
                : .json(200, Self.userJSON(flag: true))
        }
        let auth = await restored()

        await auth.completeRequiredPasswordChange(current: Self.temporary, new: Self.chosen)

        XCTAssertTrue(isHeld(auth))
        XCTAssertEqual(auth.passwordChangeError, AuthCopy.passwordChangeUnconfirmed)
        XCTAssertEqual(auth.realtime.state, .idle)
    }

    func test_completingTheChange_wrongTemporaryPassword_staysHeld_withItsOwnSentence() async {
        plantRefreshCookie()
        MockURLProtocol.install { request, _ in
            request.url?.path == "/api/auth/change-password"
                ? .json(401, #"{"detail":"Current password is incorrect"}"#)
                : .json(200, Self.userJSON(flag: true))
        }
        let auth = await restored()

        await auth.completeRequiredPasswordChange(current: "not-it-1234", new: Self.chosen)

        XCTAssertTrue(isHeld(auth))
        XCTAssertEqual(auth.passwordChangeError, AuthCopy.temporaryPasswordWrong)
        XCTAssertEqual(MockURLProtocol.count(path: "/api/auth/change-password", method: "POST"), 1)
        XCTAssertEqual(MockURLProtocol.count(path: "/api/auth/refresh", method: "POST"), 0,
                       "a wrong password was read as an expired session")
        XCTAssertEqual(expiryNotices.count, 0)
        XCTAssertTrue(hasRefreshCookie)
    }

    func test_completingTheChange_policyRefusal_showsTheServersSentenceVerbatim() async {
        plantRefreshCookie()
        let refusal = "Choose a password different from your current one."
        MockURLProtocol.install { request, _ in
            request.url?.path == "/api/auth/change-password"
                ? .json(400, #"{"detail":"\#(refusal)"}"#)
                : .json(200, Self.userJSON(flag: true))
        }
        let auth = await restored()

        await auth.completeRequiredPasswordChange(current: Self.temporary, new: Self.chosen)

        XCTAssertTrue(isHeld(auth))
        XCTAssertEqual(auth.passwordChangeError, refusal)
    }

    func test_completingTheChange_rateLimited_saysTooManyAttempts() async {
        plantRefreshCookie()
        MockURLProtocol.install { request, _ in
            request.url?.path == "/api/auth/change-password"
                ? .json(429, #"{"detail":"Too many requests"}"#, headers: ["Retry-After": "30"])
                : .json(200, Self.userJSON(flag: true))
        }
        let auth = await restored()

        await auth.completeRequiredPasswordChange(current: Self.temporary, new: Self.chosen)

        XCTAssertTrue(isHeld(auth))
        XCTAssertEqual(auth.passwordChangeError, "Too many attempts. Try again in 30 seconds.")
    }

    /// Changed, but the confirmation never arrived. Retyping the temporary password
    /// would now be refused as wrong, so the screen must not invite that.
    func test_completingTheChange_lostConfirmation_saysTheNewPasswordIsSaved() async {
        plantRefreshCookie()
        MockURLProtocol.install { request, ordinal in
            switch request.url?.path {
            case "/api/auth/change-password":
                return .json(200, #"{"message":"Password changed"}"#)
            case "/api/auth/me" where ordinal >= 3:
                return .failing(URLError(.networkConnectionLost))
            default:
                return .json(200, Self.userJSON(flag: true))
            }
        }
        let auth = await restored()

        await auth.completeRequiredPasswordChange(current: Self.temporary, new: Self.chosen)

        XCTAssertTrue(isHeld(auth))
        XCTAssertEqual(auth.passwordChangeError, AuthCopy.passwordChangeSavedUnconfirmed)
        await auth.signOut()
    }

    /// Changed on the web while this phone sat on the screen: the temporary password
    /// is no longer current, so posting it would only be refused. That change revoked
    /// this phone's refresh token, so the session starts only once a forced refresh
    /// shows it survived (batch 73 review).
    func test_completingTheChange_alreadyClearedElsewhere_sessionSurvived_startsWithoutPosting() async {
        plantRefreshCookie()
        installChangedElsewhere { _ in Self.refreshed }
        let auth = await restored()
        XCTAssertTrue(isHeld(auth), "precondition: held")
        let before = MockURLProtocol.requests.count

        await auth.completeRequiredPasswordChange(current: Self.temporary, new: Self.chosen)

        XCTAssertTrue(isSignedIn(auth), "a session that survived the change was left at \(auth.phase)")
        XCTAssertEqual(traffic(after: before), [
            "GET /api/auth/me",
            "POST /api/auth/refresh",
        ], "the session was started without asking whether it survived the change")
    }

    /// Changed elsewhere, and this phone's session did not survive it: end it now,
    /// saying which password to use, rather than start a session that signs out as
    /// "expired" when its access cookie lapses (batch 73 review).
    func test_completingTheChange_alreadyClearedElsewhere_sessionRevoked_endsIt_sayingWhy() async {
        plantRefreshCookie()
        installChangedElsewhere { _ in Self.refreshRefused }
        let auth = await restored()
        XCTAssertTrue(isHeld(auth), "precondition: held")
        let phases = PhaseRecorder(auth)
        let before = MockURLProtocol.requests.count

        await auth.completeRequiredPasswordChange(current: Self.temporary, new: Self.chosen)

        XCTAssertEqual(auth.phase, .signedOut)
        XCTAssertEqual(auth.signInError, AuthCopy.passwordChangedElsewhere)
        XCTAssertFalse(phases.everSignedIn, "the revoked session was started")
        XCTAssertEqual(traffic(after: before), ["GET /api/auth/me", "POST /api/auth/refresh"])
        XCTAssertEqual(sessionCookiesInJar, [], "the revoked session's cookies were kept")
        XCTAssertNil(RememberedUser.load())
        XCTAssertEqual(expiryNotices.count, 0, "announced as an expiry, which would show the wrong sentence")
    }

    /// Changed elsewhere, and the refresh could not be delivered: nothing was learned,
    /// so the session stays held, cookies and all, and is asked about again.
    func test_completingTheChange_alreadyClearedElsewhere_refreshUnreachable_staysHeld_andRetries() async {
        plantRefreshCookie()
        installChangedElsewhere { ordinal in ordinal == 1 ? Self.refreshUnreachable : Self.refreshed }
        let auth = await restored()
        XCTAssertTrue(isHeld(auth), "precondition: held")

        await auth.completeRequiredPasswordChange(current: Self.temporary, new: Self.chosen)

        XCTAssertTrue(isHeld(auth), "an undelivered refresh moved the session to \(auth.phase)")
        XCTAssertEqual(auth.passwordChangeError, APIError.transport(underlying: "").userMessage)
        XCTAssertTrue(hasRefreshCookie, "a delivery failure discarded the cookies")
        XCTAssertEqual(MockURLProtocol.count(path: "/api/auth/change-password"), 0)

        await waitUntil("the retry to start the session", timeout: 6) { self.isSignedIn(auth) }
        XCTAssertEqual(MockURLProtocol.count(path: "/api/auth/refresh", method: "POST"), 2)
    }

    /// The form can only act for a held session; anywhere else there is nothing to
    /// change, and a stray submit must not reach the wire.
    func test_completingTheChange_outsideTheHeldPhase_sendsNothing() async {
        MockURLProtocol.install { _, _ in .json(200, Self.userJSON(flag: false)) }
        let auth = makeAuth()
        await auth.restoreSession(minimumSplash: .zero)
        XCTAssertEqual(auth.phase, .signedOut, "precondition: no session")

        await auth.completeRequiredPasswordChange(current: Self.temporary, new: Self.chosen)

        XCTAssertEqual(auth.phase, .signedOut)
        XCTAssertTrue(MockURLProtocol.requests.isEmpty, "a submit outside the held phase reached the wire")
    }

    // MARK: - Leaving without changing it

    func test_signOutFromTheHeldPhase_endsTheSession() async throws {
        plantRefreshCookie()
        MockURLProtocol.install { request, _ in
            request.url?.path == "/api/auth/logout"
                ? .json(200, #"{"message":"Logged out successfully"}"#)
                : .json(200, Self.userJSON(flag: true))
        }
        let auth = await restored()
        XCTAssertTrue(isHeld(auth), "precondition: held")

        await auth.signOut()

        XCTAssertEqual(auth.phase, .signedOut)
        XCTAssertEqual(MockURLProtocol.count(path: "/api/auth/logout", method: "POST"), 1)
        XCTAssertFalse(hasRefreshCookie)
        XCTAssertNil(RememberedUser.load())
    }

    // MARK: - Signing out while something is out (batch 73 review)

    /// Sign Out is offered mid-request. The server can commit the change and answer
    /// with a new session's cookies after it was pressed, and cancelling cannot undo
    /// that commit. So the logout waits for the answer and carries the session it
    /// issued; otherwise the phone shows itself signed out while holding a live one.
    func test_signOutDuringTheChange_waitsForItsAnswer_thenRevokesAndClearsTheSessionItIssued() async {
        plantRefreshCookie()
        let jar: HTTPCookieStorage = self.jar
        let events = EventLog()
        MockURLProtocol.install { request, ordinal in
            switch request.url?.path {
            case "/api/auth/change-password":
                // Out long enough for Sign Out to be pressed, and answered as the server
                // answers it: with the cookies of the session it re-issued.
                return MockURLProtocol.Reply
                    .json(200, #"{"message":"Password changed"}"#, delay: 0.5)
                    .whenDelivered {
                        Self.plantSession("v2", in: jar)
                        events.record("change-password answered")
                    }
            case "/api/auth/logout":
                events.record("logout sent holding \(Self.cookieValue("rx_refresh", in: jar) ?? "nothing")")
                return .json(200, #"{"message":"Logged out successfully"}"#)
            case "/api/auth/me":
                // Clear after the change, so a change that carried on past the sign-out
                // would start the session rather than merely ask about it.
                return .json(200, Self.userJSON(flag: ordinal <= 2))
            default:
                return .json(404, #"{"detail":"Not found"}"#)
            }
        }
        let auth = await restored()
        XCTAssertTrue(isHeld(auth), "precondition: held")
        let phases = PhaseRecorder(auth)
        let before = MockURLProtocol.requests.count

        let change = Task { await auth.completeRequiredPasswordChange(current: Self.temporary, new: Self.chosen) }
        await waitUntil("the change to be on the wire") {
            MockURLProtocol.count(path: "/api/auth/change-password") == 1
        }
        await auth.signOut()
        await change.value

        XCTAssertEqual(events.all, [
            "change-password answered",
            "logout sent holding rx_refresh-v2",
        ], "the logout overtook the change's answer, so the session it issued was never revoked")
        XCTAssertEqual(traffic(after: before), [
            "GET /api/auth/me",
            "POST /api/auth/change-password",
            "POST /api/auth/logout",
        ], "the change carried on for the session being signed out")
        XCTAssertEqual(sessionCookiesInJar, [], "the signed-out phone kept the session the change issued")
        XCTAssertEqual(auth.phase, .signedOut)
        XCTAssertFalse(phases.everSignedIn, "the session being signed out was started")
        XCTAssertEqual(auth.realtime.state, .idle, "a socket was left open on a signed-out phone")
        XCTAssertNil(RememberedUser.load())
        XCTAssertFalse(auth.isChangingPassword)
        XCTAssertFalse(auth.isSigningOut)
    }

    /// The form stays up while Sign Out waits on its logout, and nothing would wait
    /// for a change started in that window.
    func test_aChangeCannotStartWhileSigningOut() async {
        plantRefreshCookie()
        MockURLProtocol.install { request, _ in
            switch request.url?.path {
            case "/api/auth/logout":
                return .json(200, #"{"message":"Logged out successfully"}"#, delay: 0.5)
            case "/api/auth/change-password":
                return .json(200, #"{"message":"Password changed"}"#)
            default:
                return .json(200, Self.userJSON(flag: true))
            }
        }
        let auth = await restored()
        XCTAssertTrue(isHeld(auth), "precondition: held")
        let before = MockURLProtocol.requests.count

        let signOut = Task { await auth.signOut() }
        await waitUntil("the logout to be on the wire") {
            MockURLProtocol.count(path: "/api/auth/logout") == 1
        }
        XCTAssertTrue(auth.isSigningOut)
        XCTAssertTrue(isHeld(auth), "precondition: the form is still up while the logout is out")

        await auth.completeRequiredPasswordChange(current: Self.temporary, new: Self.chosen)
        await signOut.value

        XCTAssertEqual(traffic(after: before), ["POST /api/auth/logout"],
                       "a change started during the sign-out reached the wire")
        XCTAssertEqual(auth.phase, .signedOut)
        XCTAssertFalse(auth.isSigningOut)
    }

    /// A `/me` answered while Sign Out waits on its logout describes the session being
    /// ended. Acting on it would send that session's refresh token to be rotated
    /// alongside the logout meant to revoke it.
    func test_aRevalidationAnsweredDuringSignOut_isNotActedOn() async {
        plantRefreshCookie()
        MockURLProtocol.install { request, ordinal in
            switch request.url?.path {
            case "/api/auth/me" where ordinal == 1:
                return .json(200, Self.userJSON(flag: true))
            case "/api/auth/me":
                return .json(200, Self.userJSON(flag: false), delay: 0.3)
            case "/api/auth/logout":
                return .json(200, #"{"message":"Logged out successfully"}"#, delay: 0.8)
            case "/api/auth/refresh":
                return Self.refreshed
            default:
                return .json(404, #"{"detail":"Not found"}"#)
            }
        }
        let auth = await restored()
        XCTAssertTrue(isHeld(auth), "precondition: held")
        let phases = PhaseRecorder(auth)

        auth.applicationWillEnterForeground()
        await waitUntil("the check to be on the wire") { MockURLProtocol.count(path: "/api/auth/me") == 2 }
        await auth.signOut()

        XCTAssertEqual(MockURLProtocol.count(path: "/api/auth/refresh"), 0,
                       "a stale /me set off a refresh for the session being signed out")
        XCTAssertFalse(phases.everSignedIn)
        XCTAssertEqual(auth.phase, .signedOut)
        XCTAssertNil(auth.signInError)
    }

    /// The refresh a change elsewhere sets off can be answered after Sign Out was
    /// pressed; its answer must not start the session being ended.
    func test_aReleaseRefreshAnsweredDuringSignOut_doesNotStartTheSession() async {
        plantRefreshCookie()
        MockURLProtocol.install { request, ordinal in
            switch request.url?.path {
            case "/api/auth/me":
                return .json(200, Self.userJSON(flag: ordinal == 1))
            case "/api/auth/refresh":
                return .json(200, #"{"message":"Token refreshed"}"#, delay: 0.3)
            case "/api/auth/logout":
                return .json(200, #"{"message":"Logged out successfully"}"#, delay: 0.8)
            default:
                return .json(404, #"{"detail":"Not found"}"#)
            }
        }
        let auth = await restored()
        XCTAssertTrue(isHeld(auth), "precondition: held")
        let phases = PhaseRecorder(auth)

        auth.applicationWillEnterForeground()
        await waitUntil("the refresh to be on the wire") { MockURLProtocol.count(path: "/api/auth/refresh") == 1 }
        await auth.signOut()

        XCTAssertFalse(phases.everSignedIn, "the refresh's answer started the session being signed out")
        XCTAssertEqual(auth.realtime.state, .idle, "a socket was opened for a signed-out phone")
        XCTAssertEqual(auth.phase, .signedOut)
        XCTAssertNil(auth.signInError)
    }

    /// Held is still a session, and a refused one ends like any other — otherwise the
    /// screen would sit there forever over a credential the server has thrown away.
    func test_aRefusedSessionWhileHeld_endsSignedOut() async {
        plantRefreshCookie()
        MockURLProtocol.install { request, ordinal in
            switch request.url?.path {
            case "/api/auth/me" where ordinal == 1: return .json(200, Self.userJSON(flag: true))
            default: return .json(401, Self.notAuthenticated)
            }
        }
        let auth = await restored()
        XCTAssertTrue(isHeld(auth), "precondition: held")

        await auth.completeRequiredPasswordChange(current: Self.temporary, new: Self.chosen)
        await waitUntil("the refused session to end") { auth.phase == .signedOut }

        XCTAssertFalse(hasRefreshCookie)
        XCTAssertNil(RememberedUser.load())
        XCTAssertEqual(MockURLProtocol.count(path: "/api/auth/change-password"), 0)
    }

    // MARK: - A running session is taken out of the app

    func test_aCodedRefusalOnAnyRequest_holdsTheSession_withoutClearingCookies() async throws {
        plantRefreshCookie()
        MockURLProtocol.install { request, _ in
            switch request.url?.path {
            case "/api/auth/me": return .json(200, Self.userJSON(flag: false))
            case "/api/conversations": return .json(403, Self.codedRefusal)
            default: return .json(200, "{}")
            }
        }
        let api = makeClient()
        let auth = makeAuth(api: api)
        let chat = ChatStore()
        chat.attach(auth: auth)
        let calls = CallStore()
        calls.attach(auth: auth, chat: chat, toasts: ToastCenter())
        await auth.restoreSession(minimumSplash: .zero)
        XCTAssertTrue(isSignedIn(auth), "precondition: signed in")

        // A call ringing and a list loaded, as a real session would have.
        let conversation = try JSONDecoder().decode(Conversation.self, from: Data("""
        {"_id":"conv-a","type":"direct","cross_org":false,"allowed_org_ids":[],
         "pinned_by":[],"is_active":true,"participants":[],"unread_count":0,
         "is_pinned":false,"is_muted":false}
        """.utf8))
        chat.applyForTesting(conversations: [conversation])
        let ringing = try JSONDecoder().decode(CallSignal.self, from: Data(#"{"call_id":"call-1"}"#.utf8))
        calls.applyForTesting(missedCallCount: 2, phase: .incoming(ringing))

        do {
            _ = try await api.send(.get, "/api/conversations", as: ConversationPage.self)
            XCTFail("the coded 403 was not thrown")
        } catch let error as APIError {
            XCTAssertEqual(error, .passwordChangeRequired(detail: "You must change your password before continuing."))
        }
        await waitUntil("the session to be held") { self.isHeld(auth) }
        await waitUntil("the live call to be ended") { !calls.hasLiveCall }

        XCTAssertTrue(hasRefreshCookie, "a held session lost the cookies it has to change the password with")
        XCTAssertEqual(expiryNotices.count, 0, "a held session was announced as expired")
        XCTAssertEqual(auth.realtime.state, .idle, "the socket kept running behind the change-password screen")
        XCTAssertEqual(RememberedUser.load()?.mustChangePassword, true,
                       "an offline relaunch would come back up in the app")
        XCTAssertTrue(chat.conversations.isEmpty, "the conversation list survived into the held phase")
        XCTAssertEqual(calls.phase, .idle, "the call was left up with its microphone published")
        await waitUntil("the call store's session state to clear") { calls.missedCallCount == 0 }
    }

    func test_aSocketClose4403_holdsTheSession_andStopsTheSocket() async {
        plantRefreshCookie()
        MockURLProtocol.install { _, _ in .json(200, Self.userJSON(flag: false)) }
        let auth = await restored()
        XCTAssertTrue(isSignedIn(auth), "precondition: signed in")
        XCTAssertNotEqual(auth.realtime.state, .idle, "precondition: the socket was started")

        auth.realtime.simulateCloseForTesting(code: RealtimeClient.passwordChangeRequiredCloseCode)

        // Before any hop back through AuthStore: the client stops itself.
        XCTAssertEqual(auth.realtime.state, .idle, "a 4403 close scheduled a reconnect")
        await waitUntil("the session to be held") { self.isHeld(auth) }
        XCTAssertTrue(hasRefreshCookie)
        XCTAssertEqual(expiryNotices.count, 0)
    }

    // MARK: - Revalidation moves both ways

    func test_revalidation_holdsARunningSessionWhoseFlagWasSet() async {
        plantRefreshCookie()
        MockURLProtocol.install { _, ordinal in .json(200, Self.userJSON(flag: ordinal > 1)) }
        let auth = await restored()
        XCTAssertTrue(isSignedIn(auth), "precondition: signed in")

        auth.applicationWillEnterForeground()
        await waitUntil("the session to be held") { self.isHeld(auth) }

        XCTAssertEqual(auth.realtime.state, .idle)
        XCTAssertTrue(hasRefreshCookie)
    }

    /// Cleared somewhere else while held. The change revoked this phone's refresh
    /// token, so the session starts only once a forced refresh shows it survived
    /// (batch 73 review).
    func test_revalidation_changedElsewhere_sessionSurvived_startsIt() async {
        plantRefreshCookie()
        installChangedElsewhere { _ in Self.refreshed }
        let auth = await restored()
        XCTAssertTrue(isHeld(auth), "precondition: held")
        let before = MockURLProtocol.requests.count

        auth.applicationWillEnterForeground()
        await waitUntil("the session to start") { self.isSignedIn(auth) }

        XCTAssertEqual(auth.currentUser?.mustChangePassword, false)
        XCTAssertEqual(traffic(after: before), [
            "GET /api/auth/me",
            "POST /api/auth/refresh",
        ], "the session was started without asking whether it survived the change")
    }

    func test_revalidation_changedElsewhere_sessionRevoked_endsIt_sayingWhy() async {
        plantRefreshCookie()
        installChangedElsewhere { _ in Self.refreshRefused }
        let auth = await restored()
        XCTAssertTrue(isHeld(auth), "precondition: held")
        let phases = PhaseRecorder(auth)

        auth.applicationWillEnterForeground()
        await waitUntil("the session to end") { auth.phase == .signedOut }

        XCTAssertEqual(auth.signInError, AuthCopy.passwordChangedElsewhere)
        XCTAssertFalse(phases.everSignedIn,
                       "the session was started on the word of an access cookie about to lapse")
        XCTAssertEqual(sessionCookiesInJar, [])
        XCTAssertNil(RememberedUser.load())
        XCTAssertEqual(MockURLProtocol.count(path: "/api/auth/refresh", method: "POST"), 1)
        XCTAssertEqual(expiryNotices.count, 0, "announced as an expiry, which would show the wrong sentence")
    }

    /// A refusal that names a mobile denial goes to that screen, as it does on every
    /// other path, not to the password sentence.
    func test_revalidation_changedElsewhere_refreshRefusedWithADenial_showsTheDenial() async {
        plantRefreshCookie()
        let detail = "Mobile access has not been enabled for this account."
        installChangedElsewhere { _ in
            .json(403, #"{"detail":"\#(detail)","code":"MOBILE_NOT_APPROVED"}"#)
        }
        let auth = await restored()
        XCTAssertTrue(isHeld(auth), "precondition: held")

        auth.applicationWillEnterForeground()
        await waitUntil("the session to end") { !self.isHeld(auth) }

        XCTAssertEqual(auth.phase, .accessDenied(reason: detail, denial: .notApproved))
        XCTAssertNil(auth.signInError)
        XCTAssertEqual(sessionCookiesInJar, [])
        XCTAssertNil(RememberedUser.load())
    }

    func test_revalidation_changedElsewhere_refreshUnreachable_staysHeld_andRetries() async {
        plantRefreshCookie()
        installChangedElsewhere { ordinal in ordinal == 1 ? Self.refreshUnreachable : Self.refreshed }
        let auth = await restored()
        XCTAssertTrue(isHeld(auth), "precondition: held")
        let phases = PhaseRecorder(auth)
        let before = MockURLProtocol.requests.count

        auth.applicationWillEnterForeground()
        await waitUntil("the retry to start the session", timeout: 6) { self.isSignedIn(auth) }

        XCTAssertEqual(traffic(after: before), [
            "GET /api/auth/me",
            "POST /api/auth/refresh",
            "GET /api/auth/me",
            "POST /api/auth/refresh",
        ], "the session left the hold before a refresh was answered")
        XCTAssertFalse(phases.phases.contains(.signedOut), "an undelivered refresh ended the session")
        XCTAssertNil(auth.signInError)
    }

    // MARK: - This device's own change (batch 73 review)

    /// Changes here, but loses the confirmation; every later `/me` reports the flag
    /// clear. The refresh is refused, so one that should not have been made shows up
    /// as a sign-out rather than passing unnoticed.
    private func installOwnChangeWithLostConfirmation() {
        MockURLProtocol.install { request, ordinal in
            switch request.url?.path {
            case "/api/auth/change-password":
                return .json(200, #"{"message":"Password changed"}"#)
            case "/api/auth/me" where ordinal <= 2:
                return .json(200, Self.userJSON(flag: true))
            case "/api/auth/me" where ordinal == 3:
                return .failing(URLError(.networkConnectionLost))
            case "/api/auth/me":
                return .json(200, Self.userJSON(flag: false))
            case "/api/auth/refresh":
                return Self.refreshRefused
            default:
                return .json(404, #"{"detail":"Not found"}"#)
            }
        }
    }

    /// The 200 this device got re-issued its session, so the revalidation that finds
    /// the flag clear starts it as it is.
    func test_ownChange_lostConfirmation_thenRevalidation_startsWithoutARefresh() async {
        plantRefreshCookie()
        installOwnChangeWithLostConfirmation()
        let auth = await restored()
        await auth.completeRequiredPasswordChange(current: Self.temporary, new: Self.chosen)
        XCTAssertEqual(auth.passwordChangeError, AuthCopy.passwordChangeSavedUnconfirmed,
                       "precondition: the confirmation was lost")

        auth.applicationWillEnterForeground()
        await waitUntil("the session to start") { self.isSignedIn(auth) }

        XCTAssertEqual(MockURLProtocol.count(path: "/api/auth/refresh"), 0,
                       "this device's own change was treated as one made elsewhere")
        // Cancels the revalidation the lost confirmation scheduled.
        await auth.signOut()
    }

    /// Pressed again after the lost confirmation: the flag is already clear, and this
    /// device cleared it, so neither a refresh nor a second change is sent.
    func test_ownChange_lostConfirmation_thenPressedAgain_startsWithoutARefresh() async {
        plantRefreshCookie()
        installOwnChangeWithLostConfirmation()
        let auth = await restored()
        await auth.completeRequiredPasswordChange(current: Self.temporary, new: Self.chosen)
        XCTAssertEqual(auth.passwordChangeError, AuthCopy.passwordChangeSavedUnconfirmed,
                       "precondition: the confirmation was lost")
        let before = MockURLProtocol.requests.count

        await auth.completeRequiredPasswordChange(current: Self.temporary, new: Self.chosen)

        XCTAssertTrue(isSignedIn(auth), "this device's own confirmed change left the session at \(auth.phase)")
        XCTAssertEqual(traffic(after: before), ["GET /api/auth/me"])
        await auth.signOut()
    }

    // MARK: - APIClient

    func test_aCodedRefusal_isItsOwnError_andIsAnnouncedOnce() async throws {
        plantRefreshCookie()
        MockURLProtocol.install { _, _ in .json(403, Self.codedRefusal) }

        do {
            _ = try await makeClient().send(.get, "/api/conversations", as: ConversationPage.self)
            XCTFail("expected a throw")
        } catch let error as APIError {
            XCTAssertEqual(error, .passwordChangeRequired(detail: "You must change your password before continuing."))
            XCTAssertFalse(error.endsSession)
            XCTAssertNil(error.mobileDenial)
        }
        XCTAssertEqual(passwordNotices.count, 1)
        XCTAssertEqual(expiryNotices.count, 0)
        XCTAssertEqual(MockURLProtocol.count(path: "/api/auth/refresh"), 0)
        XCTAssertTrue(hasRefreshCookie)
    }

    /// Any other 403 is unchanged: a mobile denial keeps its own case, and an
    /// ordinary refusal is still one endpoint saying no.
    func test_otherForbiddens_areNotAnnounced() async {
        let replies = [
            #"{"detail":"Mobile access has not been enabled for this account.","code":"MOBILE_NOT_APPROVED"}"#,
            #"{"detail":"You are not a member of this group"}"#,
        ]
        for reply in replies {
            MockURLProtocol.install { _, _ in .json(403, reply) }
            do {
                _ = try await makeClient().send(.get, "/api/conversations", as: ConversationPage.self)
                XCTFail("expected a throw for \(reply)")
            } catch let error as APIError {
                if case .passwordChangeRequired = error { XCTFail("\(reply) was read as the password gate") }
            } catch {
                XCTFail("unexpected \(error)")
            }
        }
        XCTAssertEqual(passwordNotices.count, 0)
    }

    /// Object storage is not the server speaking about this account.
    func test_aCodedRefusalFromAnotherOrigin_isNotAnnounced() async throws {
        MockURLProtocol.install { _, _ in .json(403, Self.codedRefusal) }
        let elsewhere = try XCTUnwrap(URL(string: "https://storage.example.net/bucket/object"))

        do {
            _ = try await makeClient().data(fromAbsoluteURL: elsewhere)
            XCTFail("expected a throw")
        } catch let error as APIError {
            if case .passwordChangeRequired = error { XCTFail("a foreign 403 was read as the password gate") }
        }
        XCTAssertEqual(passwordNotices.count, 0)
    }

    // MARK: - RealtimeClient

    func test_theCloseCodeIsPinned() {
        // Literal on purpose: copied from `hub.py` (`WS_CLOSE_PASSWORD_CHANGE_REQUIRED`),
        // so a change on this side fails here instead of silently missing the close.
        XCTAssertEqual(RealtimeClient.passwordChangeRequiredCloseCode, 4403)
    }

    func test_a4403Close_stopsAPendingReconnect_andReportsOnce() {
        let client = RealtimeClient()
        defer { client.disconnect() }
        var reports = 0
        client.onPasswordChangeRequired = { reports += 1 }

        // An ordinary drop first, so there is a reconnect waiting to be stopped.
        client.simulateCloseForTesting(code: 1006)
        XCTAssertEqual(client.state, .reconnecting(attempt: 1), "precondition: a reconnect is pending")
        XCTAssertEqual(reports, 0, "an ordinary drop was reported as the password gate")

        client.simulateCloseForTesting(code: 4403)
        XCTAssertEqual(reports, 1)
        XCTAssertEqual(client.state, .idle, "a 4403 close left the reconnect pending")

        // Stopped, not merely idle: nothing reopens it until `connect()`.
        client.simulateCloseForTesting(code: 1006)
        XCTAssertEqual(client.state, .idle, "the client kept reacting to closes after a 4403")
        client.applicationWillEnterForeground()
        XCTAssertEqual(client.state, .idle, "foregrounding reopened a socket the server had closed 4403")
    }

    // MARK: - CallStore

    /// A sign-out leaves a live call alone; the held phase must not, or the room keeps
    /// the microphone published with nobody able to hang up.
    func test_endForPasswordChange_endsALiveCall_thenClearsTheSessionState() async throws {
        let calls = CallStore()
        let ringing = try JSONDecoder().decode(CallSignal.self, from: Data(#"{"call_id":"call-1"}"#.utf8))
        calls.applyForTesting(missedCallCount: 3, phase: .incoming(ringing))

        await calls.endForPasswordChange().value

        XCTAssertEqual(calls.phase, .idle)
        XCTAssertFalse(calls.hasLiveCall)
        XCTAssertEqual(calls.missedCallCount, 0)
    }

    // MARK: - The form's own checks

    func test_passwordPolicy_mirrorsTheServerRules() {
        func check(_ new: String, current: String = "Temp0rary-pass", confirmation: String? = nil)
            -> PasswordPolicy.Problem? {
            PasswordPolicy.problem(current: current, new: new, confirmation: confirmation ?? new)
        }
        XCTAssertNil(check("Brand-new-pass-42"))
        XCTAssertEqual(PasswordPolicy.problem(current: "", new: "", confirmation: ""), .incomplete)
        XCTAssertEqual(check("Brand-new-pass-42", current: ""), .incomplete)
        XCTAssertEqual(check("Brand-new-pass-42", confirmation: ""), .incomplete)
        XCTAssertEqual(check("Short-1"), .tooShort)
        XCTAssertEqual(check("abcdefghijk"), .needsLetterAndDigit)
        XCTAssertEqual(check("12345678901"), .needsLetterAndDigit)
        // `[A-Za-z]` on the server: an accented letter is not one.
        XCTAssertEqual(check(String(repeating: "\u{E9}", count: 8) + "12"), .needsLetterAndDigit)
        XCTAssertEqual(check("Brand-new-pass-42", confirmation: "Brand-new-pass-43"), .mismatch)
        XCTAssertEqual(check("Temp0rary-pass"), .sameAsCurrent)
    }

    /// Measured as the server measures it: Python's `len` counts code points, and the
    /// ceiling is bcrypt's 72 bytes.
    func test_passwordPolicy_countsLengthAndBytesLikeTheServer() {
        // Ten code points, six graphemes: long enough for the server.
        let decomposed = "a1" + String(repeating: "e\u{301}", count: 4)
        XCTAssertEqual(decomposed.unicodeScalars.count, 10, "precondition")
        XCTAssertLessThan(decomposed.count, 10, "precondition")
        XCTAssertNil(PasswordPolicy.problem(current: "Temp0rary-pass", new: decomposed, confirmation: decomposed))

        let tooManyBytes = "a1" + String(repeating: "€", count: 24)  // 2 + 72 bytes
        XCTAssertEqual(PasswordPolicy.problem(current: "x", new: tooManyBytes, confirmation: tooManyBytes),
                       .tooLong)
    }

    /// Typing the new password gets feedback on it before the other fields are full.
    func test_passwordPolicy_judgesTheNewPasswordBeforeAskingForTheRest() {
        XCTAssertEqual(PasswordPolicy.problem(current: "", new: "short1", confirmation: ""), .tooShort)
    }

    // MARK: - Wiring that has no seam

    private func source(_ path: String) throws -> String {
        let url = URL(fileURLWithPath: "\(#filePath)")
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("RxHive/\(path)")
        return try String(contentsOf: url, encoding: .utf8)
    }

    func test_theRootShowsTheChangeScreen_andTheForegroundReconcileNeedsARunningSession() throws {
        let app = try source("RxHiveApp.swift")
        let held = try XCTUnwrap(app.range(of: "case .passwordChangeRequired(let user):"),
                                 "RootView has no screen for the held phase")
        XCTAssertTrue(app[held.upperBound...].prefix(300).contains("ForcedPasswordChangeView(email: user.email)"))

        let reconcile = try XCTUnwrap(app.range(of: "Task { await calls.reconcileWithServer() }"))
        let gate = try XCTUnwrap(app.range(of: "if auth.currentUser != nil {"),
                                 "the foreground reconcile runs for a held account")
        XCTAssertLessThan(gate.lowerBound, reconcile.lowerBound)
        XCTAssertLessThan(app.distance(from: gate.upperBound, to: reconcile.lowerBound), 80,
                          "the gate no longer guards the reconcile")
    }

    func test_theChangeScreenLoadsNoMedia() throws {
        let view = try source("Features/Auth/ForcedPasswordChangeView.swift")
        XCTAssertFalse(view.contains("Avatar("), "an avatar loads from /api/media, which a held account is refused")
        XCTAssertFalse(view.contains("AuthenticatedImage("))
        XCTAssertTrue(view.contains("await auth.signOut()"), "the held screen has no way to sign out")
    }

    /// `AuthStore` refuses a change started while signing out
    /// (`test_aChangeCannotStartWhileSigningOut`); the button should not look as if
    /// it would work (batch 73 review).
    func test_theChangeScreenDimsSubmitWhileSigningOut() throws {
        let view = try source("Features/Auth/ForcedPasswordChangeView.swift")
        XCTAssertTrue(view.contains("problem == nil && !auth.isChangingPassword && !auth.isSigningOut"),
                      "Change Password stays enabled while Sign Out is waiting on the change")
    }

    func test_orgAdminCannotResetTheirOwnPassword() throws {
        let view = try source("Features/OrgAdmin/OrgAdminView.swift")
        XCTAssertTrue(view.contains(".disabled(isSelf || busy != nil)\n\n                if isSelf {"),
                      "Reset Password is offered on the admin's own row")
        XCTAssertTrue(view.contains("guard busy == nil, !isSelf else { return }"),
                      "resetPassword() can still run for the admin's own account")
    }
}

/// Every phase an `AuthStore` passes through, starting with the one it is in, so a
/// test can assert a phase was never reached even briefly (batch 73 review: a
/// session started and then signed out ends looking just like one never started).
@MainActor
private final class PhaseRecorder {
    private(set) var phases: [AuthStore.Phase] = []
    private var subscription: AnyCancellable?

    init(_ auth: AuthStore) {
        subscription = auth.$phase.sink { [weak self] phase in self?.phases.append(phase) }
    }

    var everSignedIn: Bool {
        phases.contains { phase in
            if case .signedIn = phase { return true }
            return false
        }
    }
}

/// What happened on the wire, in order, as the script saw it. Locked because
/// `MockURLProtocol` calls in from URLSession's threads.
private final class EventLog: @unchecked Sendable {
    private let lock = NSLock()
    private var events: [String] = []

    func record(_ event: String) {
        lock.lock()
        events.append(event)
        lock.unlock()
    }

    var all: [String] {
        lock.lock()
        defer { lock.unlock() }
        return events
    }
}

/// The JSON bodies of the requests it was shown. `URLProtocol` sees the body as a
/// stream, not as `httpBody`, so it is read off that here.
private final class BodyRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var bodies: [[String: Any]] = []

    func record(_ request: URLRequest) {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                data.append(buffer, count: read)
            }
        }
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        lock.lock()
        bodies.append(object)
        lock.unlock()
    }

    var last: [String: Any]? {
        lock.lock()
        defer { lock.unlock() }
        return bodies.last
    }
}

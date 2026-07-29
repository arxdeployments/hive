import XCTest
@testable import RxHive

/// Locks in the session-handling behaviour of `APIClient`.
///
/// Every test here corresponds to a way this client previously signed people out of
/// a perfectly good session, or failed to restore one it could have restored. The
/// assertions are deliberately about *observable traffic and notifications* rather
/// than internals: how many times `/api/auth/refresh` was POSTed, whether
/// `sessionExpiredNotification` fired, and whether the refresh cookie is still in
/// the jar afterwards. Those three are what the user experiences.
///
/// Isolation: each test gets a fresh `URLSession` whose `httpCookieStorage` is its
/// own jar, never `HTTPCookieStorage.shared`. The client under test both reads
/// (`refreshCookieValue`) and can delete (`clearSessionCookies`) cookies, so sharing
/// the real jar would let tests corrupt each other and the host app's stored session.
final class APIClientRefreshTests: XCTestCase {

    private var jar: HTTPCookieStorage!
    private var notices: NotificationRecorder!

    /// The `/api/auth/me` payload, in the shape `auth.py` actually sends.
    private static let currentUserJSON = """
    {
      "id": "user-1",
      "email": "nurse@example.com",
      "name": "Ada Nurse",
      "role": "member",
      "org_id": "org-1",
      "dept_id": "dept-1",
      "avatar_url": null,
      "about": "Ward 4",
      "status": "online",
      "last_seen": "2026-07-28T12:00:00Z",
      "mobile_access": true
    }
    """

    private static let notAuthenticated = #"{"detail":"Not authenticated"}"#
    private static let mobileDenied =
        "Mobile access has not been enabled for this account. Please use the web app."

    // MARK: - Fixture

    override func setUp() {
        super.setUp()
        MockURLProtocol.reset()
        jar = Self.isolatedCookieJar()
        notices = NotificationRecorder(name: APIClient.sessionExpiredNotification)
    }

    override func tearDown() {
        notices.stop()
        notices = nil
        MockURLProtocol.reset()
        for cookie in jar.cookies ?? [] { jar.deleteCookie(cookie) }
        jar = nil
        super.tearDown()
    }

    /// A cookie jar that is provably not the process-wide one.
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

    /// Put a 30-day refresh cookie in the jar, as a real sign-in would.
    @discardableResult
    private func plantRefreshCookie(
        value: String = "refresh-token-v1",
        file: StaticString = #filePath,
        line: UInt = #line
    ) -> String {
        guard let host = AppConfig.apiBaseURL.host else {
            XCTFail("AppConfig.apiBaseURL has no host: \(AppConfig.apiBaseURL)", file: file, line: line)
            return value
        }
        guard let cookie = HTTPCookie(properties: [
            .domain: host,
            .path: "/",
            .name: "rx_refresh",
            .value: value,
            .expires: Date().addingTimeInterval(30 * 24 * 3600),
        ]) else {
            XCTFail("Could not build the rx_refresh cookie", file: file, line: line)
            return value
        }
        jar.setCookie(cookie)
        // If planting silently does not work the "cookie survived" assertions below
        // would pass for the wrong reason, so the fixture checks itself.
        assertRefreshCookiePresent("Test fixture: planting rx_refresh did not take",
                                   file: file, line: line)
        return value
    }

    private func assertRefreshCookiePresent(
        _ message: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let names = (jar.cookies(for: AppConfig.apiBaseURL) ?? []).map(\.name)
        XCTAssertTrue(names.contains("rx_refresh"), "\(message) — jar holds \(names)",
                      file: file, line: line)
    }

    /// `announceSessionEnded` hops to the main actor to post, so before asserting a
    /// notification did *not* fire, give a post that was going to happen time to land.
    private func settle() async {
        try? await Task.sleep(nanoseconds: 150_000_000)
        await MainActor.run {}
    }

    private func refreshPOSTCount() -> Int {
        MockURLProtocol.count(path: "/api/auth/refresh", method: "POST")
    }

    // MARK: - Fixture self-check

    func test_fixture_usesAnIsolatedCookieJarAndAResolvableAPIBaseURL() {
        XCTAssertFalse(jar === HTTPCookieStorage.shared,
                       "Tests must never read or write the process-wide cookie jar")

        // AppConfig.apiBaseURL comes from Info.plist. In a unit-test bundle hosted by
        // the app, Bundle.main is the app, so RXHIVE_API_URL must resolve; if it does
        // not, AppConfig traps and this is the line that will say so.
        XCTAssertNotNil(AppConfig.apiBaseURL.scheme)
        XCTAssertNotNil(AppConfig.apiBaseURL.host)

        plantRefreshCookie(value: "planted")
        let value = (jar.cookies(for: AppConfig.apiBaseURL) ?? [])
            .first { $0.name == "rx_refresh" }?.value
        XCTAssertEqual(value, "planted", "The jar must round-trip a cookie for the API origin")
    }

    // MARK: - (a) the actual regression

    /// `/api/auth/me` must be refreshable. It used to be excluded along with the rest
    /// of `/api/auth/`, so the one call every cold launch makes could never trigger a
    /// refresh: a user returning after the 15-minute access cookie lapsed was sent to
    /// sign-in while holding a refresh token good for another 30 days.
    func test_401OnMe_refreshesOnceThenReplaysAndReturnsTheUser() async throws {
        plantRefreshCookie()
        MockURLProtocol.install { request, nth in
            switch request.url?.path {
            case "/api/auth/me":
                return nth == 1
                    ? .json(401, Self.notAuthenticated)
                    : .json(200, Self.currentUserJSON)
            case "/api/auth/refresh":
                return .json(200, #"{"message":"refreshed"}"#)
            default:
                return .json(500, #"{"detail":"unscripted request"}"#)
            }
        }

        let client = makeClient()
        let user = try await client.send(.get, "/api/auth/me", as: CurrentUser.self)

        XCTAssertEqual(user.id, "user-1")
        XCTAssertEqual(user.email, "nurse@example.com")
        XCTAssertEqual(user.name, "Ada Nurse")
        XCTAssertEqual(
            refreshPOSTCount(), 1,
            "A 401 on /api/auth/me must trigger exactly one refresh"
        )
        XCTAssertEqual(
            MockURLProtocol.count(path: "/api/auth/me"), 2,
            "/api/auth/me must be replayed after a successful refresh"
        )
        await settle()
        XCTAssertEqual(notices.count, 0, "A recovered session must not announce expiry")
    }

    // MARK: - (b) credentials, not expiry

    /// A 401 from `/api/auth/login` means the password is wrong. Refreshing would be
    /// pointless, and reporting `.unauthorized` puts "your session expired" in front
    /// of someone who never had one.
    func test_401OnLogin_neverRefreshesAndSurfacesTheServersDetail() async throws {
        plantRefreshCookie()
        MockURLProtocol.install { request, _ in
            request.url?.path == "/api/auth/login"
                ? .json(401, #"{"detail":"Invalid email or password"}"#)
                : .json(200, "{}")
        }

        let client = makeClient()
        struct LoginBody: Encodable {
            let email: String
            let password: String
            let client_kind: String
        }

        do {
            _ = try await client.send(
                .post, "/api/auth/login",
                body: LoginBody(email: "nurse@example.com", password: "wrong",
                                client_kind: AppConfig.clientKind),
                as: EmptyResponse.self
            )
            XCTFail("Expected the login to fail")
        } catch let error as APIError {
            XCTAssertEqual(
                error, .credentials(detail: "Invalid email or password"),
                "A bad password must surface as .credentials carrying the server's sentence"
            )
            XCTAssertFalse(error.endsSession, "A bad password does not end an existing session")
        }

        XCTAssertEqual(refreshPOSTCount(), 0, "/api/auth/login must not trigger a refresh")
        await settle()
        XCTAssertEqual(notices.count, 0)
    }

    // MARK: - (c)(d)(e) reached-and-refused vs never-asked

    /// Shared body for "the refresh never established anything". Each of these must
    /// fail as `.transport`, announce nothing, and leave the credential alone.
    private func assertUndeliverableRefreshKeepsTheSession(
        refresh: MockURLProtocol.Reply,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        plantRefreshCookie(file: file, line: line)
        MockURLProtocol.install { request, _ in
            switch request.url?.path {
            case "/api/auth/me": return .json(401, Self.notAuthenticated)
            case "/api/auth/refresh": return refresh
            default: return .json(500, #"{"detail":"unscripted request"}"#)
            }
        }

        let client = makeClient()
        do {
            _ = try await client.send(.get, "/api/auth/me", as: CurrentUser.self)
            XCTFail("Expected the request to fail", file: file, line: line)
        } catch let error as APIError {
            guard case .transport = error else {
                XCTFail(
                    "Expected .transport, got \(error). A refresh that established nothing "
                    + "must not be read as proof the session is over.",
                    file: file, line: line
                )
                return
            }
            XCTAssertTrue(error.isRetryable, file: file, line: line)
            XCTAssertFalse(error.endsSession, file: file, line: line)
        } catch {
            XCTFail("Expected an APIError, got \(error)", file: file, line: line)
        }

        await settle()
        XCTAssertEqual(
            notices.count, 0,
            "An undeliverable refresh must not post sessionExpiredNotification",
            file: file, line: line
        )
        assertRefreshCookiePresent(
            "An undeliverable refresh must not cost the user their refresh cookie",
            file: file, line: line
        )
    }

    /// (c) Offline: the refresh request never completes.
    func test_401_whenRefreshCannotBeDelivered_isTransportAndKeepsEverything() async {
        await assertUndeliverableRefreshKeepsTheSession(
            refresh: .failing(URLError(.notConnectedToInternet))
        )
    }

    /// (d) A proxy 502 mid-deploy says nothing about the token we hold.
    func test_401_whenRefreshAnswers502_isTransportAndKeepsEverything() async {
        await assertUndeliverableRefreshKeepsTheSession(
            refresh: .json(502, "<html>Bad Gateway</html>", headers: ["Content-Type": "text/html"])
        )
    }

    /// (e) A 429 keyed on a shared clinic IP is a full bucket, not an expiry — every
    /// phone on that NAT would otherwise be signed out at shift change.
    func test_401_whenRefreshAnswers429_isTransportAndKeepsEverything() async {
        await assertUndeliverableRefreshKeepsTheSession(
            refresh: .json(429, #"{"detail":"Too many requests"}"#, headers: ["Retry-After": "30"])
        )
    }

    // MARK: - (f)(g) reached and refused: the only branch that may end a session

    /// (f) The server was reached and rejected the token. This one really is over.
    func test_401_whenRefreshIsRejectedWith401_announcesExpiryAndThrowsUnauthorized() async throws {
        plantRefreshCookie()
        MockURLProtocol.install { request, _ in
            switch request.url?.path {
            case "/api/auth/me": return .json(401, Self.notAuthenticated)
            case "/api/auth/refresh":
                return .json(401, #"{"detail":"Refresh token is invalid or expired"}"#)
            default: return .json(500, #"{"detail":"unscripted request"}"#)
            }
        }

        let client = makeClient()
        do {
            _ = try await client.send(.get, "/api/auth/me", as: CurrentUser.self)
            XCTFail("Expected the request to fail")
        } catch let error as APIError {
            XCTAssertEqual(error, .unauthorized,
                           "A refresh the server refused is a proven expiry")
            XCTAssertTrue(error.endsSession)
        }

        await settle()
        XCTAssertEqual(notices.count, 1,
                       "A proven expiry must post sessionExpiredNotification exactly once")
        XCTAssertEqual(notices.posts.first?[APIClient.statusKey] as? Int, 401)
        XCTAssertEqual(refreshPOSTCount(), 1,
                       "A rejected refresh must not be retried against an unchanged jar")
    }

    /// (g) The mobile grant was withdrawn mid-session. The backend's own sentence has
    /// to reach the screen written to explain it, not be flattened into "expired".
    func test_401_whenRefreshIsRejectedWith403_carriesTheMobileDenialDetail() async throws {
        plantRefreshCookie()
        MockURLProtocol.install { request, _ in
            switch request.url?.path {
            case "/api/auth/me": return .json(401, Self.notAuthenticated)
            case "/api/auth/refresh":
                return .json(403, #"{"detail":"\#(Self.mobileDenied)"}"#)
            default: return .json(500, #"{"detail":"unscripted request"}"#)
            }
        }

        let client = makeClient()
        do {
            _ = try await client.send(.get, "/api/auth/me", as: CurrentUser.self)
            XCTFail("Expected the request to fail")
        } catch let error as APIError {
            XCTAssertEqual(error, .forbidden(detail: Self.mobileDenied))
            XCTAssertTrue(error.isMobileAccessDenied)
            XCTAssertTrue(error.endsSession)
        }

        await settle()
        XCTAssertEqual(notices.count, 1)
        XCTAssertEqual(notices.posts.first?[APIClient.statusKey] as? Int, 403)
        XCTAssertEqual(
            notices.posts.first?[APIClient.detailKey] as? String, Self.mobileDenied,
            "The denial sentence must travel with the notification"
        )
    }

    // MARK: - (h) single-flight

    /// The backend rotates refresh tokens single-use. Five parallel refreshes means
    /// four of them present an already-consumed token, get 401, and sign the user out
    /// of a session that was fine.
    func test_concurrent401s_causeExactlyOneRefresh() async {
        plantRefreshCookie()
        let paths = (1...5).map { "/api/conversations/c\($0)/messages" }

        MockURLProtocol.install { request, nth in
            guard let path = request.url?.path else {
                return .json(500, #"{"detail":"no path"}"#)
            }
            if path == "/api/auth/refresh" {
                // Held so every one of the five 401s has arrived and joined this
                // flight; without the single-flight this is where four extra POSTs
                // would show up.
                return .json(200, #"{"message":"refreshed"}"#, delay: 0.3)
            }
            return nth == 1
                ? .json(401, Self.notAuthenticated)
                : .json(200, #"{"items":[]}"#)
        }

        let client = makeClient()
        await withTaskGroup(of: String?.self) { group in
            for path in paths {
                group.addTask {
                    do {
                        _ = try await client.sendIgnoringResponse(.get, path)
                        return nil
                    } catch {
                        return "\(path) failed: \(error)"
                    }
                }
            }
            for await failure in group {
                if let failure { XCTFail(failure) }
            }
        }

        XCTAssertEqual(
            refreshPOSTCount(), 1,
            "Concurrent 401s must share one refresh — the backend rotates the token single-use"
        )
        for path in paths {
            XCTAssertEqual(MockURLProtocol.count(path: path), 2,
                           "\(path) should have been sent once and replayed once")
        }
        await settle()
        XCTAssertEqual(notices.count, 0)
    }

    // MARK: - (i) a 401 that is none of our business

    /// `data(fromAbsoluteURL:)` fetches presigned storage URLs. A 401 from object
    /// storage or a CDN must not drive a session refresh, let alone end the session.
    func test_401FromAnotherHost_neitherRefreshesNorAnnouncesExpiry() async {
        plantRefreshCookie()
        MockURLProtocol.install { _, _ in
            .json(401, #"{"detail":"Request signature has expired"}"#)
        }

        let client = makeClient()
        let storage = URL(
            string: "https://rxhive-media.s3.eu-west-1.amazonaws.com/att/abc.jpg?X-Amz-Signature=dead"
        )!

        do {
            _ = try await client.data(fromAbsoluteURL: storage)
            XCTFail("Expected the storage fetch to fail")
        } catch is APIError {
            // The mapping is not what matters here; the two assertions below are.
        } catch {
            XCTFail("Expected an APIError, got \(error)")
        }

        XCTAssertEqual(
            refreshPOSTCount(), 0,
            "A 401 from a non-API host must not trigger a refresh"
        )
        await settle()
        XCTAssertEqual(
            notices.count, 0,
            "A 401 from object storage must not be able to end the app session"
        )
        assertRefreshCookiePresent("A foreign 401 must not touch our credential")
    }
}

// MARK: - Notification recording

/// Counts `sessionExpiredNotification` posts. `announceSessionEnded` posts from the
/// main actor while the test body is running off it, hence the lock.
final class NotificationRecorder {

    private let lock = NSLock()
    private var recorded: [[AnyHashable: Any]] = []
    private var token: NSObjectProtocol?

    init(name: Notification.Name) {
        token = NotificationCenter.default.addObserver(
            forName: name, object: nil, queue: nil
        ) { [weak self] note in
            guard let self else { return }
            self.lock.lock()
            self.recorded.append(note.userInfo ?? [:])
            self.lock.unlock()
        }
    }

    var posts: [[AnyHashable: Any]] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    var count: Int { posts.count }

    func stop() {
        if let token { NotificationCenter.default.removeObserver(token) }
        token = nil
    }

    deinit { stop() }
}

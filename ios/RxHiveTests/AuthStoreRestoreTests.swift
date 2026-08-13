import XCTest

@testable import RxHive

/// What a cold launch does to the stored credential.
///
/// `APIError.endsSession` is the predicate that authorises discarding it, and until
/// now nothing in production consulted it — `APIErrorSessionTests` proved the
/// predicate was right about each case while no code path asked it anything. These
/// tests cover the launch path specifically, because it is the one place
/// `handleSessionLost` cannot help: that method is gated on `.signedIn`, and during
/// `restoreSession` the phase is still `.launching`, so the notification `APIClient`
/// posts on a refused refresh lands on a no-op.
///
/// Both directions matter and both are here. Failing to clear a proven-dead cookie
/// wastes a doomed refresh on every relaunch; clearing one because the network
/// hiccuped costs the user their password, which is not recoverable.
@MainActor
final class AuthStoreRestoreTests: XCTestCase {

    private var jar: HTTPCookieStorage!

    private static let notAuthenticated = #"{"detail":"Not authenticated"}"#

    override func setUp() {
        super.setUp()
        MockURLProtocol.reset()
        jar = URLSessionConfiguration.ephemeral.httpCookieStorage
        RememberedUser.clear()
    }

    override func tearDown() {
        MockURLProtocol.reset()
        for cookie in jar.cookies ?? [] { jar.deleteCookie(cookie) }
        jar = nil
        RememberedUser.clear()
        super.tearDown()
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

    /// A 30-day refresh cookie, as a real sign-in would leave behind.
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
        // A silently-unplanted cookie would make the "was cleared" assertion pass for
        // entirely the wrong reason, so the fixture checks itself.
        XCTAssertTrue(refreshCookieNames().contains("rx_refresh"),
                      "Test fixture: planting rx_refresh did not take", file: file, line: line)
    }

    private func refreshCookieNames() -> [String] {
        (jar.cookies(for: AppConfig.apiBaseURL) ?? []).map(\.name)
    }

    /// The record a signed-in launch leaves behind, so a later offline launch can
    /// bring the app up. `CurrentUser` is `Decodable`-only, so it is built the one way
    /// production builds it: through the decoder, from the server's own wire shape.
    @discardableResult
    private func plantRememberedUser(file: StaticString = #filePath, line: UInt = #line) -> Bool {
        let json = """
        {
          "id": "user-1",
          "email": "nurse@example.com",
          "name": "Ada Nurse",
          "role": "member",
          "org_id": "org-1",
          "dept_id": "dept-1",
          "avatar_url": null,
          "about": "Ward 4",
          "mobile_access": true
        }
        """
        guard let user = try? JSONDecoder().decode(CurrentUser.self, from: Data(json.utf8)) else {
            XCTFail("Could not build a CurrentUser to remember", file: file, line: line)
            return false
        }
        RememberedUser.save(user)
        XCTAssertNotNil(RememberedUser.load(),
                        "Test fixture: saving the remembered user did not take",
                        file: file, line: line)
        return true
    }

    // MARK: - Proven failure clears

    func test_refreshRefusedAtLaunch_discardsTheDeadCookie() async {
        plantRefreshCookie()
        MockURLProtocol.install { _, _ in
            // Both /me and the refresh it triggers are refused: the server was
            // reached and said no, which is the only thing that proves expiry.
            .json(401, Self.notAuthenticated)
        }

        let auth = AuthStore(api: makeClient())
        await auth.restoreSession(minimumSplash: .zero)

        XCTAssertEqual(auth.phase, .signedOut)
        XCTAssertFalse(
            refreshCookieNames().contains("rx_refresh"),
            "A refresh the server refused leaves a credential that can only ever be "
                + "refused again; it must not survive the launch that disproved it"
        )
        XCTAssertGreaterThan(
            MockURLProtocol.count(path: "/api/auth/refresh", method: "POST"), 0,
            "The fixture never exercised the refresh path, so it proved nothing"
        )
    }

    /// A refresh refused with a 403 that carries no denial code.
    ///
    /// The code decides which *screen* a mobile denial gets. It says nothing about
    /// whether the session is over: the server was reached and refused the refresh
    /// token, which is the whole of the evidence. Tying the two together left a
    /// provably-dead cookie in the jar, so every relaunch spent another doomed
    /// refresh on it and no launch could ever recover.
    func test_refreshRefusedWith403AndNoCode_stillDiscardsTheDeadCookie() async {
        plantRefreshCookie()
        MockURLProtocol.install { request, _ in
            request.url?.path == "/api/auth/refresh"
                ? .json(403, #"{"detail":"Mobile sessions are disabled for this deployment"}"#)
                : .json(401, Self.notAuthenticated)
        }

        let auth = AuthStore(api: makeClient())
        await auth.restoreSession(minimumSplash: .zero)

        XCTAssertFalse(
            refreshCookieNames().contains("rx_refresh"),
            "A delivered refresh rejection is terminal whether or not it named a code"
        )
        XCTAssertGreaterThan(
            MockURLProtocol.count(path: "/api/auth/refresh", method: "POST"), 0,
            "The fixture never exercised the refresh path, so it proved nothing"
        )
    }

    /// The same, for a code this build has never heard of — a backend that grew a
    /// third denial. Unknown means "do not guess at a screen", not "ignore the
    /// refusal".
    func test_refreshRefusedWith403AndAnUnknownCode_stillDiscardsTheDeadCookie() async {
        plantRefreshCookie()
        MockURLProtocol.install { request, _ in
            request.url?.path == "/api/auth/refresh"
                ? .json(403, #"{"detail":"Mobile access is not available in your region","code":"MOBILE_REGION_BLOCKED"}"#)
                : .json(401, Self.notAuthenticated)
        }

        let auth = AuthStore(api: makeClient())
        await auth.restoreSession(minimumSplash: .zero)

        XCTAssertEqual(
            auth.phase, .signedOut,
            "An unrecognised code must not be routed to one of the two screens this "
                + "build has copy for"
        )
        XCTAssertFalse(refreshCookieNames().contains("rx_refresh"))
    }

    /// A coded denial still reaches its own screen, and still clears the cookie.
    func test_refreshRefusedWithACodedDenial_showsTheDenialScreenAndClears() async {
        plantRefreshCookie()
        MockURLProtocol.install { request, _ in
            request.url?.path == "/api/auth/refresh"
                ? .json(403, #"{"detail":"Super admin accounts can only sign in on the web app","code":"SUPERADMIN_MOBILE_DENIED"}"#)
                : .json(401, Self.notAuthenticated)
        }

        let auth = AuthStore(api: makeClient())
        await auth.restoreSession(minimumSplash: .zero)

        XCTAssertEqual(
            auth.phase,
            .accessDenied(
                reason: "Super admin accounts can only sign in on the web app",
                denial: .superadminWebOnly
            )
        )
        XCTAssertFalse(refreshCookieNames().contains("rx_refresh"))
    }

    /// A denial is the most definite refusal the app can get: this account may not
    /// use it at all. The cached copy of that account — email, display name, avatar,
    /// "about", and the org and department it belongs to — must not outlive it in
    /// UserDefaults. The early return for the denial screen skipped the cleanup that
    /// every other terminal path runs.
    func test_codedDenialAtLaunch_alsoDiscardsTheRememberedAccount() async {
        plantRefreshCookie()
        plantRememberedUser()
        MockURLProtocol.install { request, _ in
            request.url?.path == "/api/auth/refresh"
                ? .json(403, #"{"detail":"Mobile access has not been enabled for this account.","code":"MOBILE_NOT_APPROVED"}"#)
                : .json(401, Self.notAuthenticated)
        }

        let auth = AuthStore(api: makeClient())
        await auth.restoreSession(minimumSplash: .zero)

        XCTAssertEqual(
            auth.phase,
            .accessDenied(
                reason: "Mobile access has not been enabled for this account.",
                denial: .notApproved
            )
        )
        XCTAssertNil(
            RememberedUser.load(),
            "A refused account must not leave its profile behind on the device"
        )
        XCTAssertFalse(refreshCookieNames().contains("rx_refresh"))
    }

    /// The same cleanup on the uncoded path, which reaches it via `endsSession`.
    func test_uncodedRefusalAtLaunch_alsoDiscardsTheRememberedAccount() async {
        plantRefreshCookie()
        plantRememberedUser()
        MockURLProtocol.install { _, _ in .json(401, Self.notAuthenticated) }

        let auth = AuthStore(api: makeClient())
        await auth.restoreSession(minimumSplash: .zero)

        XCTAssertEqual(auth.phase, .signedOut)
        XCTAssertNil(RememberedUser.load())
    }

    // MARK: - Unproven failure must not clear

    func test_unreachableAtLaunch_keepsTheCookie() async {
        plantRefreshCookie()
        MockURLProtocol.install { _, _ in
            .failing(URLError(.notConnectedToInternet))
        }

        let auth = AuthStore(api: makeClient())
        await auth.restoreSession(minimumSplash: .zero)

        XCTAssertTrue(
            refreshCookieNames().contains("rx_refresh"),
            "Nothing was established about the session, so the 30-day credential is "
                + "still good — deleting it here costs the user their password"
        )
    }

    /// A 5xx is not evidence either: a proxy 502 mid-deploy says nothing about the
    /// token, and `endsSession` is false for it.
    func test_serverErrorAtLaunch_keepsTheCookie() async {
        plantRefreshCookie()
        MockURLProtocol.install { _, _ in
            .json(502, #"{"detail":"Bad gateway"}"#)
        }

        let auth = AuthStore(api: makeClient())
        await auth.restoreSession(minimumSplash: .zero)

        XCTAssertTrue(
            refreshCookieNames().contains("rx_refresh"),
            "A 5xx proves nothing about the refresh token"
        )
    }
}

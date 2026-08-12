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

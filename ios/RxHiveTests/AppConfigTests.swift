import XCTest
@testable import RxHive

/// The Release configuration ships `RXHIVE_API_URL = https://rxhive.example.com`
/// under a "CHANGE ME before shipping" comment, and nothing enforced it. That URL
/// is well-formed, so `AppConfig.apiBaseURL`'s existing validation accepted it:
/// the app would launch normally and then fail every request against a domain
/// that does not resolve, which reads as an outage rather than as a build that
/// was never configured.
///
/// `apiBaseURL` itself cannot be exercised here — it is a `let` resolved once
/// from the host app's Info.plist, and the test host is the Debug build — so
/// these cover the predicate the release-only guard is built on.
final class AppConfigTests: XCTestCase {

    func testPlaceholderHostsAreRecognised() {
        for raw in [
            "https://rxhive.example.com",
            "https://example.com",
            "http://api.example.com:8000/base",
            "https://RxHive.Example.COM",  // host comparison is case-insensitive
        ] {
            let url = URL(string: raw)!
            XCTAssertTrue(AppConfig.isPlaceholderHost(url), "\(raw) should be rejected as a placeholder")
        }
    }

    func testRealHostsAreNotRecognisedAsPlaceholders() {
        for raw in [
            "https://rxhive.rhythmrx.ai",
            "http://localhost:8000",
            "http://127.0.0.1:8000",
            "https://api.example.org",       // .org, not .com
            "https://notexample.com",        // must not match on a suffix alone
            "https://example.com.rxhive.ai", // example.com as a label, not the host
        ] {
            let url = URL(string: raw)!
            XCTAssertFalse(AppConfig.isPlaceholderHost(url), "\(raw) is a real host and must be allowed")
        }
    }

    /// The Debug host the test bundle actually runs against must itself pass, or
    /// the guard would refuse to launch the very configuration developers use.
    func testTheConfiguredDebugHostIsNotAPlaceholder() {
        XCTAssertFalse(AppConfig.isPlaceholderHost(AppConfig.apiBaseURL))
    }
}

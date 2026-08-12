import XCTest
@testable import RxHive

/// `endsSession` is the single predicate that authorises discarding the user's stored
/// credential. Getting it wrong in the permissive direction costs someone their
/// password for a network hiccup, and that is not recoverable once the cookie is gone.
final class APIErrorSessionTests: XCTestCase {

    private static let mobileDenied =
        "Mobile access has not been enabled for this account. Please use the web app."

    func test_endsSession_trueOnlyForProvenSessionFailures() {
        XCTAssertTrue(
            APIError.unauthorized.endsSession,
            ".unauthorized is only produced when the server refused a delivered refresh token"
        )
        XCTAssertTrue(
            APIError.forbidden(detail: Self.mobileDenied, denial: .notApproved).endsSession,
            "A withdrawn mobile grant ends the session"
        )
    }

    func test_endsSession_falseForEverythingThatProvesNothing() {
        XCTAssertFalse(
            APIError.transport(underlying: "The Internet connection appears to be offline.")
                .endsSession,
            "A request that never completed says nothing about the session"
        )
        XCTAssertFalse(
            APIError.server(status: 502, detail: nil).endsSession,
            "A proxy 502 mid-deploy says nothing about the session"
        )
        XCTAssertFalse(
            APIError.rateLimited(retryAfter: 30).endsSession,
            "A full rate-limit bucket on a shared clinic IP is not an expiry"
        )
        XCTAssertFalse(
            APIError.credentials(detail: "Invalid email or password").endsSession,
            "A wrong password must not tear down a session the user may already have"
        )
    }

    /// Not every 403 is the mobile gate; an ordinary authorisation refusal must not
    /// sign the user out of the app.
    func test_endsSession_falseForAnOrdinary403() {
        XCTAssertFalse(
            APIError.forbidden(detail: "You are not a member of this group", denial: nil).endsSession
        )
        XCTAssertFalse(APIError.forbidden(detail: "", denial: nil).endsSession)
    }

    /// The gate is the code, not the wording. A 403 whose sentence happens to talk
    /// about mobile access or the web app is still an ordinary 403 unless the server
    /// named it — otherwise any endpoint's copy could cost a user their session.
    func test_endsSession_falseFor403ProseThatMerelyLooksLikeTheMobileGate() {
        let lookalikes = [
            "Mobile access to this ward's roster is restricted",
            "Open the web app to manage billing",
            Self.mobileDenied,
        ]
        for detail in lookalikes {
            let error = APIError.forbidden(detail: detail, denial: nil)
            XCTAssertFalse(error.isMobileAccessDenied, "\(detail) carried no denial code")
            XCTAssertFalse(error.endsSession, "\(detail) must not discard the user's credential")
        }
    }

    /// `isRetryable` and `endsSession` must never both be true — retrying a request
    /// whose session is over is pointless, and discarding a credential over something
    /// retryable is the bug this whole classification exists to prevent.
    func test_noErrorIsBothRetryableAndSessionEnding() {
        let all: [APIError] = [
            .unauthorized,
            .credentials(detail: "Invalid email or password"),
            .forbidden(detail: Self.mobileDenied, denial: .notApproved),
            .forbidden(detail: "Not a member", denial: nil),
            .notFound,
            .validation(detail: "email: value is not a valid email address"),
            .rateLimited(retryAfter: nil),
            .rateLimited(retryAfter: 30),
            .server(status: 500, detail: "Redis blinked"),
            .transport(underlying: "offline"),
            .decoding(underlying: "keyNotFound"),
        ]
        for error in all {
            XCTAssertFalse(error.isRetryable && error.endsSession,
                           "\(error) is both retryable and session-ending")
        }
    }
}

import XCTest

@testable import RxHive

/// Pins the two 403 messages `api/auth.py` actually sends against the classifier
/// that decides which denial screen to show.
///
/// Copied verbatim from `SUPERADMIN_MOBILE_DENIED` and `MOBILE_NOT_APPROVED`, so a
/// rewording on either side fails here rather than silently routing people to the
/// wrong screen. That is exactly how the previous match survived: the fixture in
/// `APIErrorSessionTests` had drifted from the real constant and happened not to
/// contain the phrase that broke it.
final class AccessDeniedClassificationTests: XCTestCase {

    /// api/auth.py: SUPERADMIN_MOBILE_DENIED
    private static let superadminDenied =
        "Super admin accounts can only sign in on the web app"

    /// api/auth.py: MOBILE_NOT_APPROVED
    private static let notApproved =
        "Mobile access has not been enabled for this account. "
        + "Ask your super admin to approve mobile sign-in."

    func test_superadminMessageSelectsTheWebOnlyScreen() {
        XCTAssertEqual(MobileDenialKind(reason: Self.superadminDenied), .superadminWebOnly)
    }

    func test_notApprovedMessageSelectsTheRemedyScreen() {
        // Names the super admin as the remedy, so it contains "super admin" and must
        // still not be read as the superadmin case — otherwise the screen suppresses
        // the very panel explaining how to get access.
        XCTAssertEqual(MobileDenialKind(reason: Self.notApproved), .notApproved)
    }

    /// The client-side superadmin guard in `AuthStore.signIn` uses its own copy of
    /// this sentence; it has to classify the same way as the server's.
    func test_clientSideSuperadminCopyClassifiesTheSameWay() {
        XCTAssertEqual(MobileDenialKind(reason: AuthCopy.superadminWebOnly), .superadminWebOnly)
    }

    /// Both must still clear the gate that routes them to this screen at all.
    func test_bothMessagesAreRecognisedAsMobileAccessDenials() {
        XCTAssertTrue(APIError.forbidden(detail: Self.superadminDenied).isMobileAccessDenied)
        XCTAssertTrue(APIError.forbidden(detail: Self.notApproved).isMobileAccessDenied)
    }

    /// An ordinary 403 must not reach this screen, and if it somehow did it should
    /// offer the remedy rather than claim the account is a super admin.
    func test_anUnrelated403IsNotAMobileDenial() {
        let ordinary = "You are not a member of this group"
        XCTAssertFalse(APIError.forbidden(detail: ordinary).isMobileAccessDenied)
        XCTAssertEqual(MobileDenialKind(reason: ordinary), .notApproved)
    }
}

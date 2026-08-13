import XCTest

@testable import RxHive

/// Pins the wire contract that decides which mobile-denial screen a 403 gets.
///
/// The codes below are literals on purpose: they are copied from `api/auth.py`
/// (`SUPERADMIN_MOBILE_DENIED_CODE`, `MOBILE_NOT_APPROVED_CODE`), so renaming a raw
/// value on this side fails here instead of silently classifying every denial as
/// unrecognised. Writing them as `MobileDenialKind.notApproved.rawValue` would
/// assert only that the enum equals itself.
///
/// This suite used to pin the two English sentences instead, which is what the
/// classifier read. That made every wording decision on the backend an
/// authorization decision here — and the sentences do not separate cleanly:
/// `MOBILE_NOT_APPROVED` ends "Ask your super admin to approve mobile sign-in", so
/// a test for "super admin" matched both and routed un-granted members to the
/// superadmin screen, which suppresses the panel naming their actual remedy.
final class AccessDeniedClassificationTests: XCTestCase {

    /// api/auth.py: SUPERADMIN_MOBILE_DENIED_CODE
    private static let superadminCode = "SUPERADMIN_MOBILE_DENIED"
    /// api/auth.py: MOBILE_NOT_APPROVED_CODE
    private static let notApprovedCode = "MOBILE_NOT_APPROVED"

    // MARK: - The codes the backend sends

    func test_theSuperadminCodeSelectsTheWebOnlyScreen() {
        XCTAssertEqual(MobileDenialKind(rawValue: Self.superadminCode), .superadminWebOnly)
    }

    func test_theNotApprovedCodeSelectsTheRemedyScreen() {
        XCTAssertEqual(MobileDenialKind(rawValue: Self.notApprovedCode), .notApproved)
    }

    /// A code from a future backend must not be guessed into one of the two screens
    /// this build actually has copy for.
    func test_anUnknownCodeClassifiesAsNothing() {
        XCTAssertNil(MobileDenialKind(rawValue: "MOBILE_REGION_BLOCKED"))
        XCTAssertNil(MobileDenialKind(rawValue: ""))
    }

    // MARK: - The prose no longer participates

    /// The regression this whole change is about: identical wording, opposite
    /// routing, decided entirely by the code. Under the old classifier both of these
    /// went to the same screen no matter what the server meant.
    func test_identicalProseRoutesByCodeAlone() {
        let sentence = "Ask your super admin about mobile access for this account"
        XCTAssertEqual(
            APIError.forbidden(detail: sentence, denial: .superadminWebOnly).mobileDenial,
            .superadminWebOnly
        )
        XCTAssertEqual(
            APIError.forbidden(detail: sentence, denial: .notApproved).mobileDenial,
            .notApproved
        )
    }

    /// The real not-approved sentence names the super admin as the remedy. That is
    /// exactly the phrase that used to misroute it, so it is worth stating that the
    /// sentence now buys nothing either way.
    func test_theNotApprovedSentenceIsNotReadAsTheSuperadminCase() {
        let notApproved = "Mobile access has not been enabled for this account. "
            + "Ask your super admin to approve mobile sign-in."
        XCTAssertEqual(
            APIError.forbidden(detail: notApproved, denial: .notApproved).mobileDenial,
            .notApproved
        )
    }

    // MARK: - Decoding the envelope

    /// End to end from the bytes on the wire: `{"detail": ..., "code": ...}`.
    func test_theCodedEnvelopeDecodesToADenial() throws {
        let json = #"{"detail":"Super admin accounts can only sign in on the web app","code":"\#(Self.superadminCode)"}"#
        let body = try JSONDecoder().decode(APIErrorBody.self, from: Data(json.utf8))

        XCTAssertEqual(body.code, Self.superadminCode)
        XCTAssertEqual(
            body.code.flatMap(MobileDenialKind.init(rawValue:)), .superadminWebOnly
        )
    }

    /// The ordinary envelope has no `code`, and that must decode cleanly rather than
    /// failing — every other error response in the API still looks like this.
    func test_thePlainEnvelopeStillDecodesWithNoCode() throws {
        let body = try JSONDecoder().decode(
            APIErrorBody.self, from: Data(#"{"detail":"You are not a member of this group"}"#.utf8)
        )
        XCTAssertEqual(body.detail, "You are not a member of this group")
        XCTAssertNil(body.code)
    }

    /// 422s carry `detail` as an array of per-field objects. Adding `code` must not
    /// have disturbed that path.
    func test_validationEnvelopeStillDecodes() throws {
        let json = #"{"detail":[{"loc":["body","email"],"msg":"value is not a valid email address"}]}"#
        let body = try JSONDecoder().decode(APIErrorBody.self, from: Data(json.utf8))
        XCTAssertEqual(body.detail, "email: value is not a valid email address")
        XCTAssertNil(body.code)
    }

    // MARK: - The gate into the screen

    /// Both coded denials must still clear the gate that routes them here at all.
    func test_bothCodedDenialsAreRecognisedAsMobileAccessDenials() {
        for denial in [MobileDenialKind.superadminWebOnly, .notApproved] {
            XCTAssertTrue(APIError.forbidden(detail: "whatever", denial: denial).isMobileAccessDenied)
        }
    }

    /// An ordinary 403 must not reach this screen — and now cannot, whatever it says.
    func test_anUnrelated403IsNotAMobileDenial() {
        let error = APIError.forbidden(detail: "You are not a member of this group", denial: nil)
        XCTAssertFalse(error.isMobileAccessDenied)
        XCTAssertNil(error.mobileDenial)
    }

    /// The client-side superadmin guard in `AuthStore.signIn` fires when the server
    /// gate has been relaxed, so it has no server code to go on and names the kind
    /// itself. Its copy must still be the superadmin copy.
    func test_clientSideSuperadminGuardNamesTheWebOnlyCase() {
        XCTAssertTrue(AuthCopy.superadminWebOnly.localizedCaseInsensitiveContains("web app"))
        XCTAssertEqual(
            MobileDenialKind(rawValue: Self.superadminCode), .superadminWebOnly,
            "AuthStore pairs that copy with .superadminWebOnly"
        )
    }
}

import XCTest

@testable import RxHive

/// The two iOS screens that read the organisation directory, and what they send or show.
///
/// Both went wrong for the same underlying reason: the directory endpoint answers a
/// SEARCH, capped at 200 rows, and each screen treated the list it got back as if it
/// were the whole directory.
///
/// * The member picker ("Add members", and "Add to call" in a live group call) rebuilt
///   who to add from the list on screen at confirm time, so everyone picked under an
///   earlier search was dropped while the button still counted them.
/// * The contact panel looked one person up in the uncapped roster it used to get, and
///   after the cap found nobody who sorts after the 200th name.
final class DirectoryConsumerTests: XCTestCase {

    private func contact(_ id: String, _ name: String, status: PresenceStatus = .online) -> Contact {
        Contact(
            id: id,
            displayName: name,
            email: "\(id)@ward.example",
            avatarURL: nil,
            departmentName: "Ward 4",
            status: status,
            lastSeen: nil
        )
    }

    private lazy var anna = contact("u-anna", "Anna Lee")
    private lazy var raj = contact("u-raj", "Raj Patel")

    // MARK: Member picker — the reported bug

    /// Pick Anna under "anna", search "raj", pick Raj, confirm. The selection never sees
    /// either list, which is the point: both must be sent, in the order they were picked.
    func testPicksMadeUnderAnEarlierSearchAreStillSent() {
        var selection = MemberSelection()
        selection.toggle(anna)   // while the list on screen is the "anna" results
        selection.toggle(raj)    // while the list on screen is the "raj" results

        XCTAssertEqual(selection.toAdd(excluding: []), [anna, raj])
    }

    /// The same person arrives as a fresh `Contact` in every result list, possibly with a
    /// different presence. Tapping them under a later search must un-pick the original,
    /// not add a second copy that sends them twice.
    func testTheSamePersonFromALaterSearchIsTheSamePick() {
        var selection = MemberSelection()
        selection.toggle(anna)
        XCTAssertTrue(selection.contains(anna.id))

        selection.toggle(contact("u-anna", "Anna Lee", status: .offline))

        XCTAssertFalse(selection.contains(anna.id))
        XCTAssertEqual(selection.toAdd(excluding: []), [])
    }

    func testUnpickingRemovesOnlyThatPerson() {
        var selection = MemberSelection()
        selection.toggle(anna)
        selection.toggle(raj)
        selection.toggle(anna)

        XCTAssertEqual(selection.toAdd(excluding: []), [raj])
    }

    /// The caller recomputes `excluded` live, so someone who joins the group — or is rung
    /// into the call by somebody else — while the sheet is open drops out of what is sent
    /// and out of the count, rather than buying a success toast for adding nobody.
    func testSomeoneExcludedAfterBeingPickedIsNotSent() {
        var selection = MemberSelection()
        selection.toggle(anna)
        selection.toggle(raj)

        XCTAssertEqual(selection.toAdd(excluding: [anna.id]), [raj])
    }

    // MARK: Member picker — the wiring

    /// The half the value type cannot test on its own: nothing about `MemberSelection`
    /// stops the view from going back to computing what to send out of the list on
    /// screen, which is exactly how this broke (commit 3898950 changed
    /// `onAdd(Array(selected))` to `onAdd(candidates.filter { selected.contains($0.id) })`
    /// so the callers could name people). The picker has no view harness, so this reads
    /// its source, the way the web suite's wiring guards do.
    ///
    /// The count, the enabled state and the confirm must all read the same value, or
    /// the button can say "Add 2" and send one.
    func testThePickerSendsAndCountsTheSelectionNotTheListOnScreen() throws {
        let source = try pickerSource()

        let sent = matches(of: #"onAdd\(([^)]*)\)"#, in: source)
        XCTAssertEqual(sent, ["toAdd"], "every confirm must send `toAdd`, found \(sent)")

        let counted = matches(of: #""Add \\\((\w+)\.count\)""#, in: source)
        XCTAssertEqual(counted, ["toAdd"], "the button must count `toAdd`, found \(counted)")

        let gated = matches(of: #"\.disabled\((\w+)\.isEmpty"#, in: source)
        XCTAssertEqual(gated, ["toAdd"], "the button must be enabled by `toAdd`, found \(gated)")

        XCTAssertTrue(
            source.contains("selection.toAdd(excluding: excludedUserIDs)"),
            "`toAdd` must come from the selection, not from `candidates`"
        )
    }

    // MARK: Contact panel

    /// The directory by-id endpoint answers `_contact_row`, the shape `Contact` decodes.
    private static let tomJSON = """
    {"id":"u-tom","display_name":"Tom Walsh","email":"tom.walsh@ward.example",
     "avatar_url":null,"department_name":"Pharmacy","status":"online","last_seen":null}
    """

    override func tearDown() {
        MockURLProtocol.reset()
        super.tearDown()
    }

    private func makeClient() -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return APIClient(session: URLSession(configuration: config))
    }

    /// Tom sorts after the 200th name in a large org, so the capped roster's first page
    /// does not contain him — the stub answers it with somebody else, as the server
    /// would. Looking him up in that list found nothing, and the panel showed "Email not
    /// available". He has to be asked for by id.
    func testTheContactPanelAsksForThePersonByIDNotTheRoster() async {
        MockURLProtocol.install { request, _ in
            switch request.url?.path {
            case "/api/users/directory/u-tom":
                return .json(200, Self.tomJSON)
            case "/api/users/contacts":
                return .json(200, """
                [{"id":"u-aaron","display_name":"Aaron Abbott","email":"aaron@ward.example",
                  "avatar_url":null,"department_name":"ICU","status":"online","last_seen":null}]
                """)
            default:
                return .json(404, #"{"detail":"Not Found"}"#)
            }
        }

        let row = await ContactInfoView.directoryRow(userID: "u-tom", client: makeClient())

        XCTAssertEqual(row?.email, "tom.walsh@ward.example")
        XCTAssertEqual(row?.departmentName, "Pharmacy")
        XCTAssertEqual(MockURLProtocol.count(path: "/api/users/directory/u-tom", method: "GET"), 1)
        XCTAssertEqual(MockURLProtocol.count(path: "/api/users/contacts"), 0)
    }

    /// A colleague in another organisation 404s exactly as an unknown id does. The panel
    /// leaves the two rows blank, as it always did for them, rather than failing.
    func testAColleagueTheDirectoryWillNotShowLeavesTheRowsBlank() async {
        MockURLProtocol.install { _, _ in .json(404, #"{"detail":"User not found"}"#) }

        let row = await ContactInfoView.directoryRow(userID: "u-elsewhere", client: makeClient())

        XCTAssertNil(row)
        XCTAssertEqual(MockURLProtocol.count(path: "/api/users/directory/u-elsewhere", method: "GET"), 1)
    }

    // MARK: Helpers

    /// `GroupMemberPickerView`'s declaration, up to the next top-level declaration.
    private func pickerSource(file: StaticString = #filePath, line: UInt = #line) throws -> String {
        let url = URL(fileURLWithPath: "\(#filePath)")
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("RxHive/Features/Chat/GroupInfoView.swift")
        let whole = try String(contentsOf: url, encoding: .utf8)
        guard let start = whole.range(of: "struct GroupMemberPickerView: View {") else {
            XCTFail("GroupMemberPickerView not found in \(url.path)", file: file, line: line)
            return ""
        }
        let rest = whole[start.lowerBound...]
        let end = rest.range(of: "\n}\n")?.upperBound ?? rest.endIndex
        let body = String(rest[..<end])
        // A guard that silently read nothing would pass every "must not" assertion.
        XCTAssertTrue(body.contains("onAdd"), "picker source looks truncated", file: file, line: line)
        return body
    }

    /// The first capture group of every match of `pattern` in `text`.
    private func matches(of pattern: String, in text: String) -> [String] {
        guard let regex = try? NSRegularExpression(pattern: pattern) else {
            XCTFail("bad pattern \(pattern)")
            return []
        }
        let range = NSRange(text.startIndex..., in: text)
        return regex.matches(in: text, range: range).compactMap { match in
            Range(match.range(at: 1), in: text).map { String(text[$0]) }
        }
    }
}

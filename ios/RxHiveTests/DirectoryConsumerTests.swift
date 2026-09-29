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

    /// A directory row as the roster or the by-id endpoint would decode it. `status` is
    /// the one field that varies between two result lists for the same person.
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

    /// Un-picking Anna after picking Raj must leave Raj picked — the removal is by
    /// person, not "the last one" or "all of them".
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

    /// `MockURLProtocol`'s script and request log are process-wide; leaving them set
    /// would answer, and count, the next test's requests.
    override func tearDown() {
        MockURLProtocol.reset()
        super.tearDown()
    }

    /// A client whose every request is answered by `MockURLProtocol`, so the tests can
    /// see which path the panel asked for and never reach a real server.
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

    // MARK: Contact panel — a change of person

    /// Coming back from the panel's own Search or Media screen re-runs its `.task`. The
    /// email already loaded for this person has to survive that, or it blanks on every
    /// return and stays blank whenever the reload fails.
    func testReturningToThePanelKeepsThatPersonsDetails() {
        let tom = contact("u-tom", "Tom Walsh")
        XCTAssertEqual(ContactInfoView.retainedDirectoryRow(tom, for: "u-tom"), tom)
    }

    /// CodeRabbit's case: the panel's person changes under it. The previous person's
    /// email must be gone before the new lookup, not after it — and if that lookup
    /// fails, it must not be left standing under the new name.
    func testAnotherPersonsDetailsAreClearedBeforeTheLookup() {
        let tom = contact("u-tom", "Tom Walsh")
        XCTAssertNil(ContactInfoView.retainedDirectoryRow(tom, for: "u-anna"))
        XCTAssertNil(ContactInfoView.retainedDirectoryRow(tom, for: nil))
        XCTAssertNil(ContactInfoView.retainedDirectoryRow(nil, for: "u-tom"))
    }

    /// "Loaded" is only current for the person it was loaded for.
    func testGroupsLoadedForSomeoneElseAreNotCurrent() {
        XCTAssertTrue(ContactInfoView.groupsAreCurrent(.loaded, loadedFor: "u-tom", userID: "u-tom"))
        XCTAssertFalse(ContactInfoView.groupsAreCurrent(.loaded, loadedFor: "u-tom", userID: "u-anna"))
        XCTAssertFalse(ContactInfoView.groupsAreCurrent(.loaded, loadedFor: nil, userID: "u-anna"))
        XCTAssertFalse(ContactInfoView.groupsAreCurrent(.failed, loadedFor: "u-tom", userID: "u-tom"))
    }

    /// The rules above only help if the panel uses them, and in the right place.
    ///
    /// Everything loaded for somebody else has to be dropped as the FIRST, synchronous
    /// step of the panel's task, before any await: the two loads run one after the
    /// other, so a clear inside either one left the other's stale data on screen for
    /// the whole of the first request (CodeRabbit, review of 8f63ca1). The groups guard
    /// has to be the person-keyed one, with the person recorded when they load.
    func testThePanelDropsSomeoneElsesDetailsBeforeItsFirstAwait() throws {
        let task = try codeLines(
            of: ".task(id: person?.userId) {", in: "ContactInfoView.swift", closingIndent: 8
        )
        let forget = try XCTUnwrap(task.firstIndex(of: "forgetDetailsOfSomeoneElse()"),
                                   "the panel's task no longer drops someone else's details")
        let firstSuspension = try XCTUnwrap(task.firstIndex { $0.contains("await ") },
                                            "the panel's task awaits nothing")
        XCTAssertLessThan(forget, firstSuspension,
                          "someone else's details must be dropped before the first await, not after")

        let dropped = try codeLines(of: "private func forgetDetailsOfSomeoneElse()", in: "ContactInfoView.swift")
        XCTAssertFalse(dropped.first?.contains("async") ?? true, "the drop has to be synchronous")
        XCTAssertTrue(dropped.contains("directoryRow = ContactInfoView.retainedDirectoryRow(directoryRow, for: person?.userId)"),
                      "the directory row loaded for someone else is no longer dropped")
        let owned = try XCTUnwrap(dropped.firstIndex(of: "if groupsUserID != person?.userId {"),
                                  "groups must be dropped only when they belong to someone else")
        XCTAssertTrue(dropped[owned...].contains("groupsState = .idle"),
                      "someone else's groups are no longer hidden")

        let groups = try codeLines(of: "private func loadGroupsInCommon(", in: "ContactInfoView.swift")
        XCTAssertTrue(groups.contains { $0.contains("ContactInfoView.groupsAreCurrent(groupsState, loadedFor: groupsUserID") },
                      "loadGroupsInCommon must decide 'already loaded' per person")
        XCTAssertFalse(groups.contains { $0.contains("groupsState == .loaded &&") },
                       "a bare `.loaded` guard keeps the previous person's groups")
        XCTAssertTrue(groups.contains("groupsUserID = userID"),
                      "a successful load must record whose groups these are")
    }

    // MARK: Helpers

    /// The code lines of one block — a function or a modifier's closure — from the line
    /// that opens it to the first `}` at `closingIndent`, trimmed, with comment lines
    /// dropped so prose such as "before the await" is never read as code.
    private func codeLines(
        of opening: String,
        in file: String,
        closingIndent: Int = 4,
        caller: StaticString = #filePath,
        line: UInt = #line
    ) throws -> [String] {
        let url = URL(fileURLWithPath: "\(#filePath)")
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("RxHive/Features/Chat/\(file)")
        let whole = try String(contentsOf: url, encoding: .utf8)
        let start = try XCTUnwrap(whole.range(of: opening), "\(opening) not found in \(file)",
                                  file: caller, line: line)
        let rest = whole[start.lowerBound...]
        let close = "\n" + String(repeating: " ", count: closingIndent) + "}\n"
        let end = rest.range(of: close)?.upperBound ?? rest.endIndex
        return rest[..<end]
            .split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.hasPrefix("//") }
    }

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

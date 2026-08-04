import XCTest
@testable import RxHive

/// Undo granularity for the image editor, tested directly.
///
/// The point of `MediaEditHistory` being a plain value type is that this file can exist
/// at all. While the edit and its undo stack were two separate `@State`s mutated from a
/// closure handed down to a child view, the only way to find out what Undo did was to
/// draw on a phone and look — and both failure modes look identical to a dead button:
/// a commit recorded after the change makes Undo restore the state it already has, and
/// a commit that never lands leaves the stack empty and the button disabled.
///
/// Each test below asserts the property a user would describe, in the order they would
/// hit it.
final class MediaEditHistoryTests: XCTestCase {

    // `id` is `let id = UUID()` on the model, so it is not an init parameter.
    private func stroke(y: CGFloat) -> EditStroke {
        EditStroke(
            colorHex: "#FF0000",
            width: 0.01,
            points: [CGPoint(x: 0.1, y: y), CGPoint(x: 0.9, y: y)]
        )
    }

    /// Commit-then-change, the way every call site does it.
    private func addStroke(_ history: inout MediaEditHistory, y: CGFloat) {
        history.commit()
        history.apply { $0.strokes.append(stroke(y: y)) }
    }

    // MARK: The reported bug

    func testUndoRemovesOneStrokeAndKeepsTheRest() {
        var history = MediaEditHistory()
        addStroke(&history, y: 0.3)
        addStroke(&history, y: 0.5)
        addStroke(&history, y: 0.7)
        XCTAssertEqual(history.present.strokes.count, 3)

        XCTAssertTrue(history.undo())
        XCTAssertEqual(history.present.strokes.count, 2, "undo removed more than the last stroke")

        XCTAssertTrue(history.undo())
        XCTAssertEqual(history.present.strokes.count, 1)

        XCTAssertTrue(history.undo())
        XCTAssertEqual(history.present.strokes.count, 0)
    }

    func testUndoActuallyChangesSomething() {
        // The "nothing happens" shape: if a commit recorded the state AFTER the change,
        // the first undo would assign a model identical to the current one.
        var history = MediaEditHistory()
        addStroke(&history, y: 0.5)
        let before = history.present
        XCTAssertTrue(history.undo())
        XCTAssertNotEqual(history.present, before, "undo restored the state it already had")
    }

    func testUndoIsOfferedExactlyWhenItCanDoSomething() {
        var history = MediaEditHistory()
        XCTAssertFalse(history.canUndo, "Undo offered on an untouched edit")

        addStroke(&history, y: 0.4)
        XCTAssertTrue(history.canUndo)

        history.undo()
        XCTAssertFalse(history.canUndo, "Undo still offered with an empty stack")
        XCTAssertFalse(history.undo(), "undo on an empty stack reported success")
    }

    // MARK: Granularity

    func testDragSamplesDoNotEachBecomeAnUndoStep() {
        var history = MediaEditHistory()
        // Every stored property carries a default, so the memberwise init needs nothing.
        var text = EditText()
        text.text = "caption"
        text.centre = CGPoint(x: 0.5, y: 0.5)
        history.commit()
        history.apply { $0.texts.append(text) }

        // One gesture: commit once, then move on every sample.
        history.commit()
        for i in 1...25 {
            history.apply { $0.texts[0].centre = CGPoint(x: 0.5 + CGFloat(i) / 500, y: 0.5) }
        }

        XCTAssertEqual(history.past.count, 2, "a drag became more than one undo step")
        history.undo()
        XCTAssertEqual(history.present.texts.count, 1, "undoing a move deleted the box")
        XCTAssertEqual(history.present.texts[0].centre.x, 0.5, accuracy: 0.0001,
                       "undo did not restore the pre-drag position")
    }

    /// The "nothing happened" report, reproduced.
    ///
    /// A gesture that commits and then changes nothing — tapping the resize handle
    /// without dragging, touching a crop control and letting go — leaves a snapshot equal
    /// to the present. One Undo press must still undo the last REAL change rather than
    /// silently restoring the state already on screen.
    func testACommitThatChangedNothingDoesNotEatAnUndoPress() {
        var history = MediaEditHistory()
        addStroke(&history, y: 0.5)

        history.commit()   // a gesture that went nowhere
        history.commit()   // and another

        XCTAssertTrue(history.canUndo, "Undo was disabled while a real change was still pending")
        XCTAssertTrue(history.undo())
        XCTAssertTrue(history.present.strokes.isEmpty,
                      "one press did not reach the last real change")
        XCTAssertFalse(history.canUndo)
    }

    func testUndoIsNotOfferedWhenOnlyNoOpCommitsRemain() {
        var history = MediaEditHistory()
        history.commit()
        history.commit()
        XCTAssertFalse(history.canUndo, "Undo lit up for a stack of no-ops")
        XCTAssertFalse(history.undo())
    }

    // MARK: Interaction with the rest of the model

    func testUndoingAStrokeLeavesCropAndRotationAlone() {
        var history = MediaEditHistory()
        history.commit()
        history.apply { $0.rotation = 90; $0.crop = CGRect(x: 0.1, y: 0.1, width: 0.8, height: 0.8) }
        addStroke(&history, y: 0.5)
        addStroke(&history, y: 0.6)

        history.undo()
        XCTAssertEqual(history.present.strokes.count, 1)
        XCTAssertEqual(history.present.rotation, 90, "undoing a stroke reverted the rotation")
        XCTAssertNotNil(history.present.crop, "undoing a stroke reverted the crop")
    }

    func testRevertIsItselfUndoable() {
        // Revert sits next to Undo. Pressing it by mistake must cost one Undo, not the
        // whole session.
        var history = MediaEditHistory()
        addStroke(&history, y: 0.3)
        addStroke(&history, y: 0.6)

        history.reset()
        XCTAssertFalse(history.present.hasEdits, "revert left edits behind")

        XCTAssertTrue(history.undo())
        XCTAssertEqual(history.present.strokes.count, 2, "revert could not be undone")
    }

    func testHistoryIsBounded() {
        var history = MediaEditHistory()
        for i in 0..<(MediaEditHistory.limit + 15) {
            addStroke(&history, y: CGFloat(i) / 100)
        }
        XCTAssertEqual(history.past.count, MediaEditHistory.limit, "the undo stack grew past its limit")
        // The OLDEST entries are the ones dropped, so the most recent steps still undo.
        let strokesNow = history.present.strokes.count
        history.undo()
        XCTAssertEqual(history.present.strokes.count, strokesNow - 1)
    }

    func testStartingFromAPreviousEditKeepsItAsTheFloor() {
        // Re-opening the editor on an item that was already edited must not let Undo
        // reach back past what was saved.
        var existing = MediaEdit()
        existing.strokes = [stroke(y: 0.2)]
        var history = MediaEditHistory(existing)

        XCTAssertFalse(history.canUndo)
        addStroke(&history, y: 0.8)
        history.undo()
        XCTAssertEqual(history.present.strokes.count, 1, "undo went past the saved edit")
        XCTAssertFalse(history.canUndo)
    }
}

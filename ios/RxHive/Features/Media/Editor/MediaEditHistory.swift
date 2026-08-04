import Foundation

/// The edit and its undo stack, as one value.
///
/// RECONSTRUCTED. The original file was lost before it was ever committed; this is
/// rebuilt from `MediaEditHistoryTests`, which survived and specifies every behaviour
/// below, and from the call sites in `MediaEditorView`. The public surface matches the
/// original exactly — `present`, `past`, `limit`, `canUndo`, `init()`, `init(_:)`,
/// `set(_:)`, `apply(_:)`, `commit()`, `undo()`, `reset(to:)`.
///
/// ## Why one value and not two `@State`s
/// While the edit and its stack were separate state mutated through a closure handed to
/// a child view, ordering was not guaranteed: a commit could land after the change it
/// was supposed to snapshot. Both failure modes look identical to a dead Undo button —
/// a late commit makes Undo restore the state already on screen, and a commit that never
/// lands leaves the stack empty and the button disabled. Keeping them in one value type
/// makes the pairing atomic, and makes the whole thing testable without a device.
struct MediaEditHistory {

    /// How many steps back Undo can reach. Oldest entries are dropped past this.
    static var limit = 50

    /// What is on screen now.
    private(set) var present: MediaEdit

    /// Snapshots taken BEFORE each change, oldest first.
    private(set) var past: [MediaEdit] = []

    init() {
        present = MediaEdit()
    }

    /// Re-opening the editor on an item that was already edited. The saved edit is the
    /// FLOOR: `past` starts empty, so Undo cannot reach back past what was saved.
    init(_ present: MediaEdit) {
        self.present = present
    }

    /// Whether Undo would visibly change anything.
    ///
    /// Not `!past.isEmpty`. A gesture that commits and then changes nothing — tapping a
    /// resize handle without dragging, touching a crop control and letting go — leaves a
    /// snapshot equal to `present`. A stack of only those can do nothing, so offering
    /// Undo for them lights up a button that would appear broken when pressed.
    var canUndo: Bool {
        past.contains { $0 != present }
    }

    /// Replace the model wholesale. The binding the stages write through.
    mutating func set(_ next: MediaEdit) {
        present = next
    }

    /// Mutate the model in place.
    mutating func apply(_ change: (inout MediaEdit) -> Void) {
        change(&present)
    }

    /// Snapshot the current state as an undo point.
    ///
    /// Called BEFORE the change it protects, which is the whole ordering contract: the
    /// snapshot has to be the state to return to, not the state just arrived at.
    ///
    /// Committing once per GESTURE rather than per sample is what keeps a 25-sample drag
    /// from becoming 25 undo steps.
    mutating func commit() {
        past.append(present)
        if past.count > Self.limit {
            // Drop the OLDEST, so the most recent steps stay reachable.
            past.removeFirst(past.count - Self.limit)
        }
    }

    /// Step back to the last state that actually differs from the current one.
    ///
    /// Skips no-op snapshots rather than consuming a press for each: one Undo press must
    /// reach the last REAL change, not silently restore what is already on screen.
    ///
    /// - Returns: whether anything changed.
    @discardableResult
    mutating func undo() -> Bool {
        while let previous = past.popLast() {
            if previous != present {
                present = previous
                return true
            }
        }
        return false
    }

    /// Revert every edit — and make that itself undoable.
    ///
    /// Revert sits next to Undo, so pressing it by mistake must cost one Undo press
    /// rather than the whole session.
    mutating func reset(to base: MediaEdit = MediaEdit()) {
        commit()
        present = base
    }
}

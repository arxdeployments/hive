import Foundation

/// The people picked in `GroupMemberPickerView`, kept as whole contacts in pick order.
///
/// ## Why not a set of ids
/// The picker searches server-side: every keystroke replaces the list on screen with
/// that query's matches. A set of ids survives those replacements, but ids alone cannot
/// be turned back into the `Contact`s the callers need for their messages ("Ringing
/// Priya now"), so the confirm used to rebuild them from the list on screen —
/// `candidates.filter { selected.contains($0.id) }`. That quietly dropped everyone
/// picked under an earlier search: pick Anna under "anna", search "raj", pick Raj, and
/// the button read "Add 2" while only Raj was added to the group or rung into the call.
///
/// Holding the contact itself at the moment it is picked means the answer to "who did
/// I pick" never depends on what the search box says now.
struct MemberSelection: Equatable {

    /// Everyone picked, oldest pick first.
    private(set) var picked: [Contact] = []

    /// Whether `contact` is picked. Keyed on id, so a row from a later search result
    /// for the same person still shows its checkmark.
    func contains(_ id: String) -> Bool {
        picked.contains { $0.id == id }
    }

    /// Picks `contact`, or un-picks it if it already was.
    mutating func toggle(_ contact: Contact) {
        if let index = picked.firstIndex(where: { $0.id == contact.id }) {
            picked.remove(at: index)
        } else {
            picked.append(contact)
        }
    }

    /// What the confirm button sends, and therefore also what its count shows.
    ///
    /// `excluded` is applied here rather than at pick time because the caller computes
    /// it live — a person who joins the group, or is rung into the call by someone else,
    /// while the sheet is open is excluded from then on. The server skips people who are
    /// already members silently, so sending them anyway would buy a success toast for
    /// having added nobody.
    func toAdd(excluding excluded: Set<String>) -> [Contact] {
        picked.filter { !excluded.contains($0.id) }
    }
}

import Foundation

/// Wire-datetime handling for the RX HIVE API.
///
/// The backend formats every timestamp with `utils.iso_z()`, which is
/// `datetime.isoformat()` with `+00:00` rewritten to `Z`. The trap: Python's
/// `isoformat()` emits fractional seconds **only when `microsecond != 0`**. So the
/// same endpoint returns
///
///     "2026-07-28T12:00:00Z"          (row saved on a whole second)
///     "2026-07-28T12:00:00.123456Z"   (every other row)
///
/// A single fixed `DateFormatter` therefore fails on a minority of records —
/// intermittently, per row, and only in production data. Both shapes are parsed
/// here, and `ISO8601DateFormatter` is not used for this because its
/// `withFractionalSeconds` option is likewise all-or-nothing.
enum RxDate {

    /// Fractional-seconds variant, e.g. `2026-07-28T12:00:00.123456Z`.
    /// `SSSSSS` tolerates 1–6 digits; the API emits 6.
    private static let fractional: DateFormatter = make("yyyy-MM-dd'T'HH:mm:ss.SSSSSSXXXXX")
    /// Whole-second variant, e.g. `2026-07-28T12:00:00Z`.
    private static let whole: DateFormatter = make("yyyy-MM-dd'T'HH:mm:ssXXXXX")
    /// Emitting format. Whole seconds are enough for anything the client sends.
    private static let outgoing: DateFormatter = make("yyyy-MM-dd'T'HH:mm:ss'Z'")

    private static func make(_ format: String) -> DateFormatter {
        let formatter = DateFormatter()
        // POSIX locale + UTC: without them, a device set to a non-Gregorian
        // calendar (Buddhist, Japanese) or a 12-hour locale parses these wrong.
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.dateFormat = format
        return formatter
    }

    /// Parse a wire timestamp, or nil if it matches no known shape.
    static func parse(_ text: String) -> Date? {
        // Ordered by expected frequency: most rows carry microseconds.
        if let date = fractional.date(from: text) { return date }
        if let date = whole.date(from: text) { return date }
        // Last resort: a `+00:00`-style offset that never passed through iso_z.
        return ISO8601DateFormatter().date(from: text)
    }

    static func format(_ date: Date) -> String {
        outgoing.string(from: date)
    }
}

// MARK: - Display

extension Date {

    /// Conversation-list timestamp: time today, "Yesterday", weekday this week,
    /// else a short date. Mirrors what the web sidebar shows.
    var conversationListLabel: String {
        let calendar = Calendar.current
        if calendar.isDateInToday(self) {
            return formatted(date: .omitted, time: .shortened)
        }
        if calendar.isDateInYesterday(self) {
            return "Yesterday"
        }
        if let weekAgo = calendar.date(byAdding: .day, value: -6, to: Date()), self > weekAgo {
            return formatted(.dateTime.weekday(.abbreviated))
        }
        return formatted(.dateTime.day().month(.numeric).year(.twoDigits))
    }

    /// The time inside a message bubble.
    var bubbleTimeLabel: String {
        formatted(date: .omitted, time: .shortened)
    }

    /// A date-separator heading in the message list.
    var dateSeparatorLabel: String {
        let calendar = Calendar.current
        if calendar.isDateInToday(self) { return "Today" }
        if calendar.isDateInYesterday(self) { return "Yesterday" }
        if let weekAgo = calendar.date(byAdding: .day, value: -6, to: Date()), self > weekAgo {
            return formatted(.dateTime.weekday(.wide))
        }
        return formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated).year())
    }

    /// "last seen" phrasing for a contact header.
    var lastSeenLabel: String {
        let calendar = Calendar.current
        if calendar.isDateInToday(self) {
            return "last seen today at \(formatted(date: .omitted, time: .shortened))"
        }
        if calendar.isDateInYesterday(self) {
            return "last seen yesterday at \(formatted(date: .omitted, time: .shortened))"
        }
        return "last seen \(formatted(.dateTime.day().month(.abbreviated)))"
    }
}

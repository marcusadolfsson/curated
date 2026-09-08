import Foundation

enum Format {
    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter
    }()

    private static let clock: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter
    }()

    private static let dayAndClock: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "d MMM, HH:mm"
        return formatter
    }()

    /// "3 minutes ago", or "never" for a missing date. Anything inside ten
    /// seconds reads as "just now" rather than flickering through the seconds.
    static func relative(_ date: Date?) -> String {
        guard let date else { return "never" }
        let elapsed = Date().timeIntervalSince(date)
        if elapsed < 10 { return "just now" }
        return relativeFormatter.localizedString(for: date, relativeTo: Date())
    }

    static func timestamp(_ date: Date?) -> String {
        guard let date else { return "—" }
        return Calendar.current.isDateInToday(date) ? clock.string(from: date) : dayAndClock.string(from: date)
    }

    /// "3 minutes ago (17:02:11)" for rows where both matter.
    static func relativeWithClock(_ date: Date?) -> String {
        guard let date else { return "never" }
        return "\(relative(date))  ·  \(timestamp(date))"
    }

    static func duration(since date: Date?) -> String {
        guard let date else { return "—" }
        let seconds = Int(Date().timeIntervalSince(date))
        if seconds < 60 { return "\(seconds)s" }
        if seconds < 3600 { return "\(seconds / 60)m" }
        if seconds < 86_400 { return "\(seconds / 3600)h \((seconds % 3600) / 60)m" }
        return "\(seconds / 86_400)d \((seconds % 86_400) / 3600)h"
    }

    static func count(_ value: Int, _ singular: String, _ plural: String? = nil) -> String {
        let word = value == 1 ? singular : (plural ?? singular + "s")
        return "\(value) \(word)"
    }
}

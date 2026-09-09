import Foundation

// MARK: - Wire types
//
// These mirror what the running app already returns. /api/watch, /api/sync,
// /api/session, /api/session/signin and /api/posts all exist and are GET-only
// reads here.
//
// This app used to send no POST at all, because every POST on those routes
// *does* something - starts a sync, starts the watcher, pauses - and a menu is
// too easy to hit for that. There is now exactly one exception, opening the
// sign-in window, and it earns the exception by being the thing you need when
// the app has stopped working: a signed-out Curated cannot fetch anything, and
// the menu bar is where you find out. It still changes state, so it is the
// only item here that asks first. See README.md, "What it deliberately does
// not do".

struct WatchPayload: Decodable {
    var enabled: Bool
    var listening: Bool
    var since: Date?
    var sockets: Int
    var lastEventAt: Date?
    var lastSyncAt: Date?
    var syncsTriggered: Int
    var eventsSeen: Int
    var error: String?
}

struct SyncRun: Decodable {
    var running: Bool
    var phase: String?
    var message: String?
    var startedAt: Date?
    var finishedAt: Date?
    var postsAdded: Int?
    var postsAnalyzed: Int?
    var reactionsSent: Int?
    var error: String?
}

struct LastRun: Decodable {
    var startedAt: Date?
    var finishedAt: Date?
    var status: String?
    var postsAdded: Int?
    var error: String?
}

struct PausePayload: Decodable {
    var paused: Bool
    var until: Date?
    var reason: String?
}

struct SyncPayload: Decodable {
    var state: SyncRun
    var pause: PausePayload
    var lastRun: LastRun?
}

struct SessionPayload: Decodable {
    var connected: Bool
    var username: String?
    var userId: String?
    var checkedAt: Date?
    var verifiedAt: Date?
}

/// Only the counts are read. The `posts` array is ignored, which is why this is
/// polled on a slow timer of its own rather than with the light endpoints.
struct CountsPayload: Decodable {
    var total: Int
    var unread: Int
    var saved: Int
}

// MARK: - Local, non-HTTP status

/// Not tunnel health. Connections, edge locations and connector identity live
/// in the separate Cloudflare tunnel app; the only thing read here is the
/// request counter, because it is the one available signal for whether a real
/// client has been through. See Poller.noteClientTraffic.
struct ClientTraffic {
    var totalRequests: Int
    var metricsPort: Int
}

enum Reachability: Equatable {
    /// Cloudflare answered. For a hostname behind Access an unauthenticated
    /// redirect to the login page is the *correct* answer, not a failure.
    case reachable(status: Int)
    case unreachable(String)
    case notChecked
}

struct AgentStatus {
    var label: String
    var loaded: Bool
    var running: Bool
    var pid: Int?
}

// MARK: - Snapshot

/// The sign-in window's state, while one is standing open.
struct SignInPayload: Decodable {
    var phase: String
    var message: String
    var username: String?
    var startedAt: Date?
    var paused: Bool

    /// A window is up and the app is waiting on a person.
    var working: Bool { ["opening", "waiting", "verifying"].contains(phase) }
}

/// Whether the analysis half of the app has a credential. Never the token.
struct ClaudeTokenPayload: Decodable {
    var ok: Bool
    var source: String
    var detail: String
    var stored: Bool?
    var saved: Bool?
    var message: String?
}

struct Snapshot {
    var takenAt = Date()

    var appReachable = false
    var appError: String?

    var watch: WatchPayload?
    var sync: SyncPayload?
    var session: SessionPayload?
    var signIn: SignInPayload?
    var claude: ClaudeTokenPayload?
    var counts: CountsPayload?

    var traffic: ClientTraffic?
    var site: Reachability = .notChecked
    var agents: [AgentStatus] = []

    /// Derived, not reported by anything. See Poller.noteClientTraffic.
    var lastClientConnect: Date?
    var clientConnectIsSinceLaunch = true
}

// MARK: - Health

enum Health: Int, Comparable {
    case ok = 0
    case degraded = 1
    case attention = 2
    case down = 3

    static func < (a: Health, b: Health) -> Bool { a.rawValue < b.rawValue }

    var symbolName: String {
        switch self {
        case .ok: return "circle.fill"
        case .degraded: return "exclamationmark.triangle.fill"
        case .attention: return "exclamationmark.circle.fill"
        case .down: return "xmark.circle.fill"
        }
    }
}

/// One line saying what is wrong, ranked. The first entry is what the icon shows.
struct Concern: Identifiable {
    var id = UUID()
    var health: Health
    var text: String
}

extension Snapshot {
    /// Ranked worst-first. Empty means everything is fine.
    var concerns: [Concern] {
        var found: [Concern] = []

        guard appReachable else {
            return [Concern(health: .down, text: appError ?? "The app is not answering on localhost.")]
        }

        // Signed out is the loudest thing this app can say. Nothing retries and
        // nothing recovers on its own: a person has to paste a session cookie
        // on the Setup page. Everything else here either heals or backs off.
        if let session, !session.connected {
            found.append(Concern(health: .attention, text: "Signed out of Instagram. Paste a session cookie on the Setup page."))
        }

        if let pause = sync?.pause, pause.paused {
            let reason = pause.reason.map { ": \($0)" } ?? ""
            found.append(Concern(health: .attention, text: "Paused\(reason)"))
        }

        if let error = sync?.state.error, !error.isEmpty {
            found.append(Concern(health: .attention, text: "Last sync failed: \(error)"))
        }

        if let error = watch?.error, !error.isEmpty {
            found.append(Concern(health: .attention, text: "Watcher error: \(error)"))
        }

        if let watch, watch.enabled, !watch.listening {
            found.append(Concern(health: .degraded, text: "Watcher is enabled but not listening."))
        }

        if case .unreachable(let why) = site {
            found.append(Concern(health: .degraded, text: "Public address unreachable: \(why)"))
        }

        return found.sorted { $0.health > $1.health }
    }

    var health: Health { concerns.first?.health ?? .ok }

    var headline: String {
        if let first = concerns.first { return first.text }
        if let session, session.connected, let name = session.username {
            return "Everything healthy, signed in as \(name)."
        }
        return "Everything healthy."
    }
}

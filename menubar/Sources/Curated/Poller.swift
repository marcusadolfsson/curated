import Foundation
import Observation

@MainActor
@Observable
final class Poller {
    /// One instance, observed by both the menu bar label and the panel. The
    /// label exists from launch; the panel is only built on first click.
    static let shared = Poller()

    private(set) var snapshot = Snapshot(appReachable: false)
    private(set) var refreshing = false

    var config = Config.load()

    /// Cadence. The light endpoints are tiny and already cached server-side.
    /// The counts read returns every post, so it gets a slow lane of its own.
    private let lightInterval: TimeInterval = 10
    private let siteInterval: TimeInterval = 60
    private let countsInterval: TimeInterval = 300

    private var lastSiteCheck = Date.distantPast
    private var lastCountsCheck = Date.distantPast
    private var cachedMetricsPort: Int?
    private var loop: Task<Void, Never>?

    /// Backoff while the app is down, so a stopped server is not polled at full
    /// rate all day.
    private var consecutiveFailures = 0

    // Persisted so "last client connect" survives a relaunch of this app.
    private let seenRequestsKey = "lastSeenRequestCount"
    private let lastConnectKey = "lastClientConnectAt"

    init() {
        // Not in start(): --report and --json call refresh() directly and never
        // start the loop, and without this they claim no client has ever
        // connected while the timestamp sits in defaults.
        restoreClientConnect()
    }

    func start() {
        guard loop == nil else { return }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                let delay = self?.currentDelay() ?? 10
                try? await Task.sleep(for: .seconds(delay))
            }
        }
    }

    func stop() {
        loop?.cancel()
        loop = nil
    }

    private func currentDelay() -> TimeInterval {
        guard consecutiveFailures > 0 else { return lightInterval }
        return min(lightInterval * pow(2, Double(min(consecutiveFailures, 3))), 60)
    }

    /// Forces every lane to run, including the slow ones.
    func refreshNow() {
        lastSiteCheck = .distantPast
        lastCountsCheck = .distantPast
        Task { await refresh() }
    }

    /// Open the sign-in window, then look again so the menu shows it standing
    /// open rather than waiting out the next tick.
    func beginSignIn() {
        act { try await $0.beginSignIn() }
    }

    func signOut() {
        act { try await $0.signOut() }
    }

    func setClaudeToken(_ token: String) {
        act { try await $0.setClaudeToken(token) }
    }

    func clearClaudeToken() {
        act { try await $0.clearClaudeToken() }
    }

    /// Do the thing, then look again, so the menu reflects it immediately
    /// rather than at whatever point the next tick lands.
    private func act(_ body: @escaping (CuratedAPI) async throws -> Void) {
        Task {
            try? await body(CuratedAPI(base: config.localBase))
            await refresh()
        }
    }

    func refresh() async {
        refreshing = true
        defer { refreshing = false }

        var next = Snapshot()
        next.lastClientConnect = snapshot.lastClientConnect
        next.clientConnectIsSinceLaunch = snapshot.clientConnectIsSinceLaunch

        let api = CuratedAPI(base: config.localBase)

        // Curated's own endpoints. /api/watch decides whether the app counts as
        // reachable at all; the others are allowed to fail on their own.
        do {
            next.watch = try await api.watch()
            next.appReachable = true
            consecutiveFailures = 0
        } catch {
            next.appReachable = false
            next.appError = friendlyError(error)
            consecutiveFailures += 1
        }

        if next.appReachable {
            next.sync = try? await api.sync()
            next.session = try? await api.session()
            next.signIn = try? await api.signIn()
            next.claude = try? await api.claudeToken()

            if Date().timeIntervalSince(lastCountsCheck) >= countsInterval {
                if let counts = try? await api.counts() {
                    next.counts = counts
                    lastCountsCheck = Date()
                } else {
                    next.counts = snapshot.counts
                }
            } else {
                next.counts = snapshot.counts
            }
        }

        // Discovering cloudflared's port means shelling out, which blocks.
        //
        // This used to ask launchctl about the server's launch agent as well.
        // The app runs the server itself now, so the question answered itself:
        // if the agent were not running there would be no menu to read the
        // answer in. Server.state is the honest version of that row.
        let pinnedPort = config.metricsPort
        let cached = cachedMetricsPort
        let local = await Task.detached(priority: .utility) { () -> Int? in
            pinnedPort ?? cached ?? Cloudflared.discoverMetricsPort()
        }.value

        if let port = local {
            if let traffic = await Cloudflared.requestCount(port: port) {
                next.traffic = traffic
                cachedMetricsPort = port
                noteClientTraffic(requests: traffic.totalRequests, into: &next)
            } else {
                // Either the port moved, most likely a connector restart, or the
                // process found was some other cloudflared. Drop the cache so
                // the next pass rediscovers and re-validates.
                cachedMetricsPort = nil
            }
        }

        if Date().timeIntervalSince(lastSiteCheck) >= siteInterval {
            next.site = await PublicProbe.check(config.publicURL)
            lastSiteCheck = Date()
        } else {
            next.site = snapshot.site
        }

        snapshot = next
    }

    /// cloudflared counts every request that reaches it. An unauthenticated
    /// probe of the public hostname is answered by Cloudflare Access and never
    /// arrives, so any increase here is a real client that got through. The
    /// counter resets whenever the connector restarts, which reads as a
    /// decrease and is ignored rather than treated as traffic.
    private func noteClientTraffic(requests: Int, into snapshot: inout Snapshot) {
        let defaults = UserDefaults.standard
        let previous = defaults.object(forKey: seenRequestsKey) as? Int

        if let previous, requests > previous {
            let now = Date()
            snapshot.lastClientConnect = now
            snapshot.clientConnectIsSinceLaunch = false
            defaults.set(now, forKey: lastConnectKey)
        }
        defaults.set(requests, forKey: seenRequestsKey)
    }

    private func restoreClientConnect() {
        if let stored = UserDefaults.standard.object(forKey: lastConnectKey) as? Date {
            snapshot.lastClientConnect = stored
            snapshot.clientConnectIsSinceLaunch = false
        }
    }

    private func friendlyError(_ error: Error) -> String {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain {
            switch nsError.code {
            case NSURLErrorCannotConnectToHost:
                return "Nothing is listening on \(config.localBase.host() ?? "localhost"):\(config.localBase.port ?? 80)."
            case NSURLErrorTimedOut:
                return "The app did not answer in time."
            default:
                break
            }
        }
        return nsError.localizedDescription
    }

    // MARK: - Clipboard summary

    func statusReport() -> String {
        let snapshot = snapshot
        var lines = ["Curated status at \(Format.timestamp(snapshot.takenAt))"]
        lines.append(snapshot.headline)
        lines.append("")

        lines.append("App:      \(snapshot.appReachable ? "responding on \(config.localBase.absoluteString)" : (snapshot.appError ?? "down"))")

        if let session = snapshot.session {
            lines.append("Session:  \(session.connected ? "signed in as \(session.username ?? "?")" : "SIGNED OUT")")
        }
        if let watch = snapshot.watch {
            lines.append("Watcher:  \(watch.listening ? "listening" : "not listening"), \(watch.sockets) sockets, \(watch.eventsSeen) events seen")
            lines.append("Last sync: \(Format.relative(watch.lastSyncAt))")
        }
        if let sync = snapshot.sync {
            let run = sync.state
            let detail = run.running ? "running, \(run.phase ?? "")" : (sync.lastRun?.status ?? run.phase ?? "idle")
            lines.append("Sync:     \(detail) — \(run.message ?? "")")
            if sync.pause.paused {
                lines.append("PAUSED:   \(sync.pause.reason ?? "no reason given") until \(Format.timestamp(sync.pause.until))")
            }
        }
        if let counts = snapshot.counts {
            lines.append("Posts:    \(counts.unread) unread of \(counts.total), \(counts.saved) saved")
        }
        switch snapshot.site {
        case .reachable(let status):
            lines.append("Public:   \(config.publicURL.host() ?? "") answering (HTTP \(status))")
        case .unreachable(let why):
            lines.append("Public:   unreachable — \(why)")
        case .notChecked:
            lines.append("Public:   not checked yet")
        }
        lines.append("Client:   last connect \(snapshot.lastClientConnect == nil && snapshot.clientConnectIsSinceLaunch ? "none seen yet" : Format.relative(snapshot.lastClientConnect))")

        lines.append("Server:   \(Server.shared.isHost ? "hosted by this app (\(Server.shared.summary))" : "run from somewhere else")")
        lines.append("Login:    \(LoginItem.shared.description)")
        return lines.joined(separator: "\n")
    }
}

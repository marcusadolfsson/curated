import Foundation
import Observation

/// The server, when it is carried inside this app rather than run by launchd.
///
/// A bundled Curated.app has no checkout to run from and no Homebrew node to
/// run with: it carries `Contents/Resources/node` and `Contents/Resources/
/// server`, and this starts one with the other. When those are absent - the
/// menu bar app built on its own, against a server the launch agent is
/// running - everything here stays out of the way and reports `.external`.
///
/// The one rule this has to enforce is the app's oldest one: never two
/// instances against one Instagram session. One session cookie used from two
/// places is the pattern that gets an account flagged. So it refuses to start
/// while anything already answers on the port, rather than racing the launch
/// agent for the same database and the same browser profile.
@MainActor
@Observable
final class Server {
    static let shared = Server()

    enum State: Equatable {
        /// No server inside this bundle; something else runs it.
        case external
        case starting
        case running(pid: Int32)
        /// Waiting out the throttle before trying again.
        case backingOff(until: Date)
        case stopped
        case blocked(String)
    }

    private(set) var state: State = .external {
        didSet { note("state: \(state)") }
    }
    private(set) var lastExit: String?

    /// To stderr, which is where a launchd agent's output goes and where
    /// `open`'s does not - so this is also readable by running the binary
    /// directly. A supervisor that fails silently is not worth having.
    private func note(_ message: String) {
        FileHandle.standardError.write(Data("[server] \(message)\n".utf8))
    }

    /// Thirty seconds, the same as the launch agent's ThrottleInterval and for
    /// the same reason: a server that crashes on boot and is restarted at once
    /// opens a browser at Instagram every time it does.
    private let throttle: TimeInterval = 30
    private var process: Process?
    private var restarting: Task<Void, Never>?
    private var lastStart = Date.distantPast

    private let resources = Bundle.main.resourceURL
    private var nodeBinary: URL? { resources?.appending(path: "node/bin/node") }
    private var serverRoot: URL? { resources?.appending(path: "server") }

    /// One line for the status report.
    var summary: String {
        switch state {
        case .external:
            // --report runs in a second process that never started anything,
            // so its own state says nothing. The pid file is what both
            // processes can agree on.
            guard isHost else { return "run from somewhere else" }
            if let pid = recordedServerPid() { return "pid \(pid)" }
            return "not running"
        case .starting: return "starting"
        case .running(let pid): return "pid \(pid)"
        case .backingOff(let until):
            return "restarting in \(max(0, Int(until.timeIntervalSinceNow)))s"
        case .stopped: return "stopped"
        case .blocked(let why): return why
        }
    }

    /// True when this bundle carries a server to run.
    var isHost: Bool {
        guard let node = nodeBinary, let root = serverRoot else { return false }
        return FileManager.default.isExecutableFile(atPath: node.path)
            && FileManager.default.fileExists(atPath: root.appending(path: "server.js").path)
    }

    func startIfHosted(port: Int) {
        guard isHost else {
            note("no server in this bundle; something else runs it")
            state = .external
            return
        }
        note("hosting the server on port \(port)")
        Task { await start(port: port) }
    }

    private func start(port: Int) async {
        guard case .running = state else {
            await launch(port: port)
            return
        }
    }

    private func launch(port: Int) async {
        guard let node = nodeBinary, let root = serverRoot else { return }

        // Somebody is already there. Usually that is the launch agent or a
        // `npm run dev`, and this does not join in - two servers against one
        // Instagram session is the thing that gets an account flagged.
        //
        // The exception is our own orphan. Killing this app does not kill the
        // node process it started, so a crash or a `pkill` leaves a server
        // holding the port, and every later launch would refuse to start
        // forever. The pid file says which process was ours; nothing else is
        // touched.
        if await somethingAnswers(on: port) {
            guard let orphan = recordedServerPid() else {
                state = .blocked(
                    "Something is already serving on port \(port). Curated will not start a "
                        + "second one against the same Instagram session."
                )
                return
            }
            note("taking over from our own orphan, pid \(orphan)")
            kill(orphan, SIGTERM)
            for _ in 0..<50 where kill(orphan, 0) == 0 {
                usleep(200_000)
            }
            if kill(orphan, 0) == 0 { kill(orphan, SIGKILL) }
            if await somethingAnswers(on: port) {
                state = .blocked("Port \(port) is still held after stopping our own server.")
                return
            }
        }

        state = .starting

        let task = Process()
        task.executableURL = node
        task.arguments = ["server.js"]
        task.currentDirectoryURL = root

        var env = ProcessInfo.processInfo.environment
        env["NODE_ENV"] = "production"
        env["PORT"] = String(port)
        env["HOSTNAME"] = "127.0.0.1"
        env["DATA_DIR"] = Paths.dataDirectory.path
        env["MIGRATIONS_DIR"] = root.appending(path: "drizzle").path
        // Chromium is 356 MB and is not in the bundle; it lives beside the
        // data, fetched once. See Browser.swift.
        env["PLAYWRIGHT_BROWSERS_PATH"] = Paths.browsersDirectory.path
        if let token = Paths.claudeToken() {
            env["CLAUDE_CODE_OAUTH_TOKEN"] = token
        }
        task.environment = env

        let log = Paths.logFile()
        task.standardOutput = log
        task.standardError = log

        task.terminationHandler = { [weak self] finished in
            Task { @MainActor in
                self?.serverExited(finished, port: port)
            }
        }

        do {
            try task.run()
            process = task
            lastStart = Date()
            writePid(task.processIdentifier)
            state = .running(pid: task.processIdentifier)
        } catch {
            state = .blocked("Could not start the server: \(error.localizedDescription)")
        }
    }

    private var pidFile: URL { Paths.dataDirectory.appending(path: "server.pid") }

    private func writePid(_ pid: Int32) {
        try? FileManager.default.createDirectory(
            at: Paths.dataDirectory, withIntermediateDirectories: true
        )
        try? String(pid).write(to: pidFile, atomically: true, encoding: .utf8)
    }

    /// A server we started that outlived us, or nil. Only ever a pid this app
    /// wrote down and that is still alive - it never guesses at a process it
    /// does not recognise, because the other candidate is the launch agent's.
    func recordedServerPid() -> Int32? {
        guard
            let text = try? String(contentsOf: pidFile, encoding: .utf8),
            let pid = Int32(text.trimmingCharacters(in: .whitespacesAndNewlines)),
            pid > 1,
            kill(pid, 0) == 0
        else { return nil }
        return pid
    }

    private func serverExited(_ finished: Process, port: Int) {
        guard process === finished else { return }
        process = nil
        lastExit = "exited with \(finished.terminationStatus) at \(Format.timestamp(Date()))"

        // Deliberate stops do not come back on their own.
        guard case .running = state else { return }

        let waited = Date().timeIntervalSince(lastStart)
        let delay = max(0, throttle - waited)
        state = .backingOff(until: Date().addingTimeInterval(delay))
        restarting?.cancel()
        restarting = Task {
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            await launch(port: port)
        }
    }

    /// Stop it, and give it a moment to put the cookies back on disk and close
    /// the browser before insisting.
    func stop() {
        restarting?.cancel()
        restarting = nil
        guard let task = process else {
            state = isHost ? .stopped : .external
            return
        }
        state = .stopped
        process = nil
        task.terminate()
        let deadline = Date().addingTimeInterval(10)
        while task.isRunning && Date() < deadline {
            usleep(100_000)
        }
        if task.isRunning { kill(task.processIdentifier, SIGKILL) }
    }

    private func somethingAnswers(on port: Int) async -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/watch") else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        do {
            _ = try await HTTP.session.data(for: request)
            return true
        } catch {
            return false
        }
    }
}

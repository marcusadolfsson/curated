import Foundation
import Observation

/// Chromium, fetched once instead of carried.
///
/// It is 356 MB - larger than everything else in the bundle put together - and
/// putting it inside a signed app means signing every helper inside Chromium's
/// own framework, which is a lot of work for something that is really data. So
/// it is downloaded on first run into Application Support, beside the database,
/// and the server is pointed at it with PLAYWRIGHT_BROWSERS_PATH.
///
/// playwright-core ships the installer that does this, so nothing here needs
/// npm - which is the whole point, since a bundled app has no npm.
///
/// It is the full Chromium and not the headless shell, deliberately: the shell
/// announces itself as HeadlessChrome on every request whatever user agent it
/// is given, and this account cannot afford to look like a scraper.
@MainActor
@Observable
final class Browser {
    static let shared = Browser()

    enum State: Equatable {
        case unknown
        case present
        case fetching
        case failed(String)
    }

    private(set) var state: State = .unknown
    private var running: Process?

    /// Playwright puts each build in its own directory under the browsers
    /// path. Any chromium- directory means one has been unpacked.
    func check() {
        let path = Paths.browsersDirectory
        let contents = (try? FileManager.default.contentsOfDirectory(atPath: path.path)) ?? []
        let found = contents.contains { $0.hasPrefix("chromium-") }
        if case .fetching = state { return }
        state = found ? .present : .unknown
    }

    /// Runs playwright's own installer with the bundled node. Nothing is
    /// downloaded silently: this is only called when somebody asks.
    func fetch() {
        if case .fetching = state { return }
        startFetch()
    }

    private func startFetch() {
        guard
            let resources = Bundle.main.resourceURL,
            case let node = resources.appending(path: "node/bin/node"),
            FileManager.default.isExecutableFile(atPath: node.path)
        else {
            state = .failed("This build has no bundled node to run the installer with.")
            return
        }

        let cli = resources.appending(path: "server/node_modules/playwright-core/cli.js")
        guard FileManager.default.fileExists(atPath: cli.path) else {
            state = .failed("playwright-core is missing from the bundle.")
            return
        }

        try? FileManager.default.createDirectory(
            at: Paths.browsersDirectory, withIntermediateDirectories: true
        )

        let task = Process()
        task.executableURL = node
        task.arguments = [cli.path, "install", "chromium"]
        var env = ProcessInfo.processInfo.environment
        env["PLAYWRIGHT_BROWSERS_PATH"] = Paths.browsersDirectory.path
        task.environment = env
        task.standardOutput = Paths.logFile()
        task.standardError = Paths.logFile()

        task.terminationHandler = { [weak self] finished in
            Task { @MainActor in
                self?.running = nil
                if finished.terminationStatus == 0 {
                    self?.check()
                    if case .unknown = self?.state { self?.state = .failed("The download finished but no browser is there.") }
                } else {
                    self?.state = .failed("The download failed - see curated.log.")
                }
            }
        }

        do {
            state = .fetching
            try task.run()
            running = task
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}

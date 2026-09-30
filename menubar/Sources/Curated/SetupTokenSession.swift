import Foundation
import Darwin

/// One run of `claude setup-token` on a pseudo-terminal.
final class SetupTokenSession: @unchecked Sendable {
    private let process = Process()
    private let master: FileHandle
    private let queue = DispatchQueue(label: "curated.setup-token")
    private var raw = ""

    init?(binary: URL) {
        var masterFD: Int32 = -1
        var slaveFD: Int32 = -1
        // Wide enough that neither the sign-in URL nor the token wraps. Ink
        // lays itself out against this, and a line break in the middle of a
        // token is a token that no longer matches.
        var size = winsize(ws_row: 50, ws_col: 1000, ws_xpixel: 0, ws_ypixel: 0)
        guard openpty(&masterFD, &slaveFD, nil, nil, &size) == 0 else { return nil }

        master = FileHandle(fileDescriptor: masterFD, closeOnDealloc: true)
        let slave = FileHandle(fileDescriptor: slaveFD, closeOnDealloc: true)

        process.executableURL = binary
        process.arguments = ["setup-token"]
        process.standardInput = slave
        process.standardOutput = slave
        process.standardError = slave
        var env = ProcessInfo.processInfo.environment
        env["TERM"] = "xterm-256color"
        // A token already in the environment is not what this is asking for.
        env.removeValue(forKey: "CLAUDE_CODE_OAUTH_TOKEN")
        process.environment = env

        master.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            self?.queue.async { self?.raw += String(decoding: data, as: UTF8.self) }
        }

        do {
            try process.run()
        } catch {
            master.readabilityHandler = nil
            return nil
        }
        // The child has its own copy now; holding ours open would stop the
        // master ever seeing the end of the output.
        try? slave.close()
    }

    /// The output so far, with the terminal control sequences taken out.
    var text: String {
        queue.sync { Self.plain(raw) }
    }

    var signInURL: URL? {
        guard let match = text.range(of: #"https://claude\.com/cai/oauth/authorize\?\S+"#, options: .regularExpression)
        else { return nil }
        return URL(string: String(text[match]))
    }

    var token: String? { Self.token(in: text) }

    static func token(in text: String) -> String? {
        guard let match = text.range(of: #"sk-ant-oat01-[A-Za-z0-9_\-]{20,}"#, options: .regularExpression)
        else { return nil }
        return String(text[match])
    }

    /// The last thing it said that looks like a sentence, for an error dialog.
    /// Never used once a token has appeared, so it cannot surface one.
    func lastWords() -> String? {
        let text = self.text
        guard Self.token(in: text) == nil else { return nil }
        return text.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .last { $0.count > 12 && !$0.hasPrefix("http") && !$0.contains("Paste code") }
    }

    func send(_ input: String) {
        try? master.write(contentsOf: Data(input.utf8))
    }

    /// Polls the output until the test passes, the process ends, or time runs
    /// out. True if the test passed.
    func waitFor(timeout: TimeInterval, _ test: @escaping (String) -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if test(text) { return true }
            if !process.isRunning { return test(text) }
            try? await Task.sleep(for: .milliseconds(300))
        }
        return false
    }

    func stop() {
        master.readabilityHandler = nil
        if process.isRunning { process.terminate() }
        queue.sync { raw = "" }
    }

    /// Terminal output as text. Ink moves the cursor rather than printing
    /// spaces, so the words run together - which does not matter for a URL or
    /// a token, the only two things read out of it.
    private static func plain(_ raw: String) -> String {
        var text = raw
        for pattern in [#"\u{1B}\[[0-9;?]*[ -/]*[@-~]"#, #"\u{1B}\][^\u{07}\u{1B}]*(\u{07}|\u{1B}\\)"#, #"\u{1B}[()][A-Z0-9]"#] {
            text = text.replacingOccurrences(of: pattern, with: "", options: .regularExpression)
        }
        return text.replacingOccurrences(of: "\r", with: "\n")
    }
}

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

    var isRunning: Bool { process.isRunning }

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

    /// The most useful thing it said, for an error dialog.
    ///
    /// An error line if there is one, otherwise the last line of any length.
    /// It used to be simply the last line, which after a failed exchange is
    /// "Press Enter to retry." - true, and no help to anybody reading it in a
    /// dialog where there is nothing to press Enter on.
    /// Never used once a token has appeared, so it cannot surface one.
    func lastWords() -> String? {
        let text = self.text
        guard Self.token(in: text) == nil else { return nil }
        let lines = text.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { $0.count > 12 && !$0.hasPrefix("http") && !Self.isAskingForCode($0) }
        return lines.last { $0.localizedCaseInsensitiveContains("error") || $0.localizedCaseInsensitiveContains("timed out") }
            ?? lines.last
    }

    /// The end of the conversation with the CLI, safe to write to a log.
    ///
    /// Tokens are cut out. So is anything long and unbroken, because the code
    /// pasted from the browser is a credential until it has been used, and the
    /// CLI echoes it back masked but not every build is guaranteed to.
    func redactedTail(lines count: Int = 15) -> String {
        let spinner = CharacterSet(charactersIn: "·✢✳✶✻✽* ")
        let kept = text.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.unicodeScalars.allSatisfy(spinner.contains) }
        return kept.suffix(count)
            .map { line in
                line.replacingOccurrences(of: #"sk-ant-[A-Za-z0-9_\-]+"#, with: "sk-ant-<redacted>", options: .regularExpression)
                    .replacingOccurrences(of: #"[A-Za-z0-9_\-#]{24,}"#, with: "<redacted>", options: .regularExpression)
            }
            .joined(separator: "\n")
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
    /// Whether the CLI is waiting for the code from the browser.
    ///
    /// Compared with every bit of whitespace taken out, because what separates
    /// the words on screen is not always a space. The CLI draws its gaps by
    /// moving the cursor, and the first version of this waited for the literal
    /// text "Paste code here" - which never arrived in that form. It gave up
    /// after twenty seconds, killed the sign-in, and reported a failure while
    /// the person was still in the browser signing in.
    static func isAskingForCode(_ text: String) -> Bool {
        text.filter { !$0.isWhitespace }.contains("Pastecodehere")
    }

    private static func plain(_ raw: String) -> String {
        // Cursor-forward moves are how the gaps between words are drawn, so
        // they become spaces rather than vanishing. Everything else that
        // positions or colours is thrown away.
        var text = expandCursorForward(raw)
        for pattern in [#"\u{1B}\[[0-9;?]*[ -/]*[@-~]"#, #"\u{1B}\][^\u{07}\u{1B}]*(\u{07}|\u{1B}\\)"#, #"\u{1B}[()][A-Z0-9]"#] {
            text = text.replacingOccurrences(of: pattern, with: "", options: .regularExpression)
        }
        return text.replacingOccurrences(of: "\r", with: "\n")
    }

    /// `ESC [ n C` - move the cursor n columns right - as n spaces.
    private static func expandCursorForward(_ raw: String) -> String {
        guard let pattern = try? NSRegularExpression(pattern: "\u{1B}\\[([0-9]*)C") else { return raw }
        let source = raw as NSString
        var result = ""
        var last = 0
        for match in pattern.matches(in: raw, range: NSRange(location: 0, length: source.length)) {
            result += source.substring(with: NSRange(location: last, length: match.range.location - last))
            let digits = match.range(at: 1).length > 0 ? source.substring(with: match.range(at: 1)) : "1"
            result += String(repeating: " ", count: min(Int(digits) ?? 1, 200))
            last = match.range.location + match.range.length
        }
        result += source.substring(from: last)
        return result
    }
}

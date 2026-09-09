import Foundation

/// Where a bundled Curated keeps things.
///
/// Everything the server writes goes under one directory, which is what makes
/// the app safe to delete and reinstall: the bundle is disposable, this is not.
/// It matches DATA_DIR in the server's own paths.ts, and the launch-agent
/// deployment points at the same place - so an install that starts as a
/// checkout and becomes an app finds the database it already had.
enum Paths {
    static let support = FileManager.default
        .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appending(path: "Curated")

    static var dataDirectory: URL { support }

    /// Chromium, fetched once rather than carried. It is 356 MB, it is signed
    /// by somebody else, and putting it inside a signed bundle means signing
    /// every helper inside its framework - which is a great deal of work for
    /// something that is really data.
    ///
    /// Playwright's own default location rather than somewhere under this
    /// app's data. It is a cache: shared with any other Playwright on the
    /// machine, safe to delete, and re-downloaded when it goes. Putting a
    /// private copy beside the database would have meant this Mac downloading
    /// a second 356 MB of the identical browser it already had.
    static var browsersDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appending(path: "Library/Caches/ms-playwright")
    }

    /// The analysis credential, outside the bundle and outside the repo, at
    /// mode 600. Written by the menu bar's own token field or by hand.
    static var claudeTokenPath: URL {
        FileManager.default.homeDirectoryForCurrentUser.appending(path: ".curated/claude-token")
    }

    static func claudeToken() -> String? {
        guard let raw = try? String(contentsOf: claudeTokenPath, encoding: .utf8) else { return nil }
        let token = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return token.isEmpty ? nil : token
    }

    /// The server's log, appended to rather than truncated, so a crash loop
    /// leaves the evidence of the first crash and not only the last.
    static func logFile() -> FileHandle {
        try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        let url = support.appending(path: "curated.log")
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
        let handle = (try? FileHandle(forWritingTo: url)) ?? FileHandle.nullDevice
        _ = try? handle.seekToEnd()
        return handle
    }
}

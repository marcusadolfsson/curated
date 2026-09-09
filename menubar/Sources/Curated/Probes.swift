import Foundation

// MARK: - Configuration

struct Config {
    var localBase = URL(string: "http://127.0.0.1:3000")!
    /// The public hostname the app is served on. Set yours with:
    ///   defaults write com.curated.app publicURL https://curated.example.com
    var publicURL = URL(string: "https://curated.example.com")!
    /// Pinned metrics port, or nil to discover it from the running process.
    var metricsPort: Int?

    static func load() -> Config {
        let defaults = UserDefaults.standard
        var config = Config()
        if let raw = defaults.string(forKey: "localBase"), let url = URL(string: raw) {
            config.localBase = url
        }
        if let raw = defaults.string(forKey: "publicURL"), let url = URL(string: raw) {
            config.publicURL = url
        }
        let port = defaults.integer(forKey: "metricsPort")
        if port > 0 { config.metricsPort = port }
        return config
    }
}

// MARK: - JSON

enum JSON {
    /// The app emits ISO-8601 both with and without fractional seconds
    /// depending on the field, so try the strict parser first and fall back.
    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]

        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            if let date = withFraction.date(from: text) { return date }
            if let date = plain.date(from: text) { return date }
            throw DecodingError.dataCorruptedError(
                in: try decoder.singleValueContainer(),
                debugDescription: "Not an ISO-8601 date: \(text)"
            )
        }
        return decoder
    }()
}

// MARK: - HTTP

enum HTTP {
    static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 6
        configuration.waitsForConnectivity = false
        configuration.httpAdditionalHeaders = ["User-Agent": "Curated/1.0"]
        return URLSession(configuration: configuration)
    }()

    static func get<T: Decodable>(_ type: T.Type, from url: URL) async throws -> T {
        let (data, _) = try await session.data(from: url)
        return try JSON.decoder.decode(T.self, from: data)
    }

    static func text(from url: URL) async throws -> String {
        let (data, _) = try await session.data(from: url)
        return String(decoding: data, as: UTF8.self)
    }
}

// MARK: - Curated's own endpoints (all GET, all read-only)

struct CuratedAPI {
    var base: URL

    func watch() async throws -> WatchPayload {
        try await HTTP.get(WatchPayload.self, from: base.appending(path: "api/watch"))
    }

    func sync() async throws -> SyncPayload {
        try await HTTP.get(SyncPayload.self, from: base.appending(path: "api/sync"))
    }

    func session() async throws -> SessionPayload {
        try await HTTP.get(SessionPayload.self, from: base.appending(path: "api/session"))
    }

    func signIn() async throws -> SignInPayload {
        try await HTTP.get(SignInPayload.self, from: base.appending(path: "api/session/signin"))
    }

    func claudeToken() async throws -> ClaudeTokenPayload {
        try await HTTP.get(ClaudeTokenPayload.self, from: base.appending(path: "api/claude/token"))
    }

    // MARK: - The writes
    //
    // Signing in and out, and the analysis credential. Each one is something
    // you reach for when the app has stopped doing its job, which is when the
    // menu bar is where you are looking. Everything else here stays a read.

    /// Opens Instagram's login page in Curated's own browser. The app stops
    /// reading Instagram while the window stands open.
    @discardableResult
    func beginSignIn() async throws -> SignInPayload {
        try await write("api/session/signin", method: "POST", body: nil, as: SignInPayload.self)
    }

    /// Deletes the saved session. The app cannot read anything afterwards
    /// until somebody signs in again.
    func signOut() async throws {
        var request = URLRequest(url: base.appending(path: "api/session"))
        request.httpMethod = "DELETE"
        _ = try await HTTP.session.data(for: request)
    }

    @discardableResult
    func setClaudeToken(_ token: String) async throws -> ClaudeTokenPayload {
        try await write(
            "api/claude/token",
            method: "POST",
            body: try JSONSerialization.data(withJSONObject: ["token": token]),
            as: ClaudeTokenPayload.self
        )
    }

    @discardableResult
    func clearClaudeToken() async throws -> ClaudeTokenPayload {
        try await write("api/claude/token", method: "DELETE", body: nil, as: ClaudeTokenPayload.self)
    }

    private func write<T: Decodable>(
        _ path: String,
        method: String,
        body: Data?,
        as type: T.Type
    ) async throws -> T {
        var request = URLRequest(url: base.appending(path: path))
        request.httpMethod = method
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, _) = try await HTTP.session.data(for: request)
        return try JSON.decoder.decode(T.self, from: data)
    }

    /// Returns every post as well as the counts, so this is deliberately on a
    /// slow timer. It is the only expensive read here.
    func counts() async throws -> CountsPayload {
        var components = URLComponents(url: base.appending(path: "api/posts"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "state", value: "all")]
        return try await HTTP.get(CountsPayload.self, from: components.url!)
    }
}

// MARK: - Shell helpers

enum Shell {
    /// Runs a tool and returns stdout, or nil if it could not be run.
    /// Blocking, so callers hop off the main actor first.
    static func run(_ path: String, _ arguments: [String]) -> String? {
        guard FileManager.default.isExecutableFile(atPath: path) else { return nil }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return nil
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return String(decoding: data, as: UTF8.self)
    }
}

// MARK: - cloudflared

enum Cloudflared {
    /// Every running connector serves a metrics endpoint on loopback. Without an
    /// explicit --metrics flag the port is chosen at random on each start, so it
    /// has to be found from the process rather than assumed.
    ///
    /// The match is on the program name alone, deliberately. It used to require
    /// "tunnel run" adjacent, which broke silently the moment the connector
    /// started being launched as `cloudflared tunnel --no-autoupdate run` and a
    /// flag landed between the two words. Whether a process is the right one is
    /// settled by asking its metrics endpoint for the counter, not by guessing
    /// from an argument order somebody else controls.
    static func discoverMetricsPort() -> Int? {
        guard let pids = Shell.run("/usr/bin/pgrep", ["-f", "cloudflared"])?
            .split(whereSeparator: \.isNewline)
            .compactMap({ Int($0.trimmingCharacters(in: .whitespaces)) }),
            !pids.isEmpty
        else { return nil }

        for pid in pids {
            guard let listing = Shell.run(
                "/usr/sbin/lsof",
                ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", String(pid)]
            ) else { continue }

            for line in listing.split(whereSeparator: \.isNewline) {
                // ... TCP 127.0.0.1:20241 (LISTEN)
                guard let range = line.range(of: "127.0.0.1:") else { continue }
                let rest = line[range.upperBound...]
                let digits = rest.prefix { $0.isNumber }
                if let port = Int(digits) { return port }
            }
        }
        return nil
    }

    /// Reads only the request counter. Tunnel health — connections, edge
    /// locations, connector identity — is the separate Cloudflare tunnel app's
    /// job and is deliberately not shown here. What remains is the one signal
    /// that tells this app whether a real client has been through.
    static func requestCount(port: Int) async -> ClientTraffic? {
        let url = URL(string: "http://127.0.0.1:\(port)/metrics")!
        guard let metrics = try? await HTTP.text(from: url) else { return nil }

        for line in metrics.split(whereSeparator: \.isNewline)
        where line.hasPrefix("cloudflared_tunnel_total_requests ") {
            let value = line.split(separator: " ").last.map(String.init) ?? ""
            guard let count = Double(value) else { continue }
            return ClientTraffic(totalRequests: Int(count), metricsPort: port)
        }
        return nil
    }
}

// MARK: - Public reachability

/// Refuses to follow redirects, so the probe reports what the edge actually
/// answered. Following them would chase the Cloudflare Access login page and
/// report a 200 whether or not Access is still in front of the site.
private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

enum PublicProbe {
    private static let delegate = NoRedirects()

    /// Behind Cloudflare Access this request is answered by Cloudflare's own
    /// login redirect and never reaches the tunnel, which is what makes it safe
    /// to run on a timer: it costs the app nothing and it does not disturb the
    /// tunnel request counter used to spot real client traffic. Verified
    /// against this deployment.
    static func check(_ url: URL) async -> Reachability {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData

        do {
            let (_, response) = try await HTTP.session.data(for: request, delegate: delegate)
            guard let http = response as? HTTPURLResponse else {
                return .unreachable("no HTTP response")
            }
            return .reachable(status: http.statusCode)
        } catch {
            let nsError = error as NSError
            // A refused redirect surfaces as a cancellation on some paths.
            if nsError.domain == NSURLErrorDomain, nsError.code == NSURLErrorCancelled {
                return .reachable(status: 302)
            }
            return .unreachable(describe(nsError, host: url.host() ?? "the host"))
        }
    }

    /// URLSession's own wording is misleading here. An unresolvable hostname
    /// reports as "the Internet connection appears to be offline", which during
    /// a real outage points at the wrong thing entirely.
    private static func describe(_ error: NSError, host: String) -> String {
        guard error.domain == NSURLErrorDomain else { return error.localizedDescription }
        switch error.code {
        case NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed:
            return "\(host) does not resolve"
        case NSURLErrorNotConnectedToInternet:
            return "no route to the internet"
        case NSURLErrorTimedOut:
            return "timed out"
        case NSURLErrorCannotConnectToHost:
            return "connection refused"
        case NSURLErrorSecureConnectionFailed, NSURLErrorServerCertificateUntrusted:
            return "TLS failed"
        default:
            return error.localizedDescription
        }
    }
}


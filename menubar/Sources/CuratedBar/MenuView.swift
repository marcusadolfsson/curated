import SwiftUI

extension Health {
    var tint: Color {
        switch self {
        case .ok: return .green
        case .degraded: return .orange
        case .attention: return .red
        case .down: return .red
        }
    }

    private var barColor: NSColor? {
        switch self {
        // Healthy stays a template image so it takes the menu bar's own colour
        // in light and dark, and does not sit there shouting green all day.
        case .ok: return nil
        case .degraded: return .systemOrange
        case .attention, .down: return .systemRed
        }
    }

    /// The status item image. Colour only when something is wrong, so the eye
    /// is drawn to the bar exactly when it should be.
    func barImage() -> NSImage {
        var configuration = NSImage.SymbolConfiguration(pointSize: 13, weight: .medium)
        if let barColor {
            // Hierarchical, not palette. A flat palette colour floods every
            // layer of a .fill symbol, so the knocked-out glyph disappears and
            // an "error" mark becomes an anonymous solid blob.
            configuration = configuration.applying(NSImage.SymbolConfiguration(hierarchicalColor: barColor))
        }

        guard let symbol = NSImage(systemSymbolName: symbolName, accessibilityDescription: "Curated status"),
              let image = symbol.withSymbolConfiguration(configuration)
        else {
            return NSImage(systemSymbolName: "circle", accessibilityDescription: "Curated status") ?? NSImage()
        }
        image.isTemplate = barColor == nil
        return image
    }
}

struct MenuView: View {
    @Bindable var poller: Poller
    @Environment(\.openURL) private var openURL
    @State private var confirmSignIn = false
    @State private var confirmSignOut = false
    @State private var askForToken = false
    @State private var token = ""

    private var snapshot: Snapshot { poller.snapshot }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().padding(.vertical, 8)
            server
            Divider().padding(.vertical, 8)
            access
            Divider().padding(.vertical, 8)
            actions
        }
        .padding(12)
        .frame(width: 340)
        .alert("Sign in to Instagram?", isPresented: $confirmSignIn) {
            Button("Open the window") { poller.beginSignIn() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                "Curated stops reading Instagram while the window is open - it and the "
                    + "window share one browser. You type into Instagram's own page; your "
                    + "password never reaches Curated."
            )
        }
        .alert("Sign out of Instagram?", isPresented: $confirmSignOut) {
            Button("Sign out", role: .destructive) { poller.signOut() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                "The saved session is deleted and Curated stops reading anything until "
                    + "you sign in again. Signing back in is a fresh login, which is the "
                    + "one thing worth doing rarely."
            )
        }
        .alert("Claude token", isPresented: $askForToken) {
            // A plain field, not SecureField: this is pasted rather than typed
            // from memory, and a row of dots makes a mispaste impossible to see.
            TextField("sk-ant-...", text: $token)
            Button("Save") { poller.setClaudeToken(token); token = "" }
            if snapshot.claude?.stored == true {
                Button("Remove", role: .destructive) { poller.clearClaudeToken(); token = "" }
            }
            Button("Cancel", role: .cancel) { token = "" }
        } message: {
            Text(
                "Make one with `claude setup-token`. It is written to "
                    + "~/.curated/claude-token and used straight away - no restart. "
                    + "Without it Curated still reads and files posts; it just stops "
                    + "describing and categorising them."
            )
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: snapshot.health.symbolName)
                .foregroundStyle(snapshot.health.tint)
                .font(.system(size: 13))
                .padding(.top, 1)

            VStack(alignment: .leading, spacing: 2) {
                Text("Curated")
                    .font(.headline)
                Text(snapshot.headline)
                    .font(.subheadline)
                    .foregroundStyle(snapshot.health == .ok ? .secondary : snapshot.health.tint)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            if poller.refreshing {
                ProgressView().controlSize(.small)
            }
        }
    }

    // MARK: - Server

    @ViewBuilder
    private var server: some View {
        Section(title: "Server") {
            if snapshot.appReachable {
                Row("App", value: "responding", tone: .good)
            } else {
                Row("App", value: "not responding", tone: .bad)
            }

            if let session = snapshot.session {
                Row(
                    "Instagram",
                    value: session.connected ? "signed in as \(session.username ?? "?")" : "signed out",
                    tone: session.connected ? .good : .bad
                )
            }

            if let watch = snapshot.watch {
                Row(
                    "Watcher",
                    value: watch.listening
                        ? "listening · \(Format.count(watch.sockets, "socket"))"
                        : (watch.enabled ? "not listening" : "disabled"),
                    tone: watch.listening ? .good : (watch.enabled ? .bad : .plain)
                )
                Row("Last event", value: Format.relative(watch.lastEventAt))
            }

            if let sync = snapshot.sync {
                if sync.state.running {
                    Row("Sync", value: "running · \(sync.state.phase ?? "")", tone: .busy)
                } else {
                    Row("Last sync", value: Format.relative(snapshot.watch?.lastSyncAt ?? sync.lastRun?.finishedAt))
                    if let message = sync.state.message, !message.isEmpty {
                        Row("Result", value: message, tone: sync.state.error == nil ? .plain : .bad)
                    }
                }
                if sync.pause.paused {
                    Row(
                        "Paused",
                        value: sync.pause.until.map { "until \(Format.timestamp($0))" } ?? "indefinitely",
                        tone: .bad
                    )
                }
            }

            if let counts = snapshot.counts {
                Row("Posts", value: "\(counts.unread) unread of \(counts.total)")
            }
        }
    }

    // MARK: - Access

    @ViewBuilder
    private var access: some View {
        Section(title: "Access") {
            switch snapshot.site {
            case .reachable(let status):
                Row("Public", value: publicDescription(status), tone: .good)
            case .unreachable(let why):
                Row("Public", value: why, tone: .bad)
            case .notChecked:
                Row("Public", value: "checking…", tone: .plain)
            }

            Row(
                "Last client",
                value: snapshot.lastClientConnect == nil && snapshot.clientConnectIsSinceLaunch
                    ? "none seen yet"
                    : Format.relative(snapshot.lastClientConnect)
            )
        }
    }

    /// A hostname behind Cloudflare Access answers an unauthenticated request
    /// with a redirect to the login page. That is the healthy answer, so say so
    /// rather than showing a bare status code that looks like a fault.
    private func publicDescription(_ status: Int) -> String {
        switch status {
        case 200: return "answering"
        case 301, 302, 303, 307, 308: return "answering · Access login"
        default: return "answering · HTTP \(status)"
        }
    }

    // MARK: - Actions

    private var actions: some View {
        VStack(alignment: .leading, spacing: 2) {
            MenuButton("Open Curated", shortcut: nil) {
                openURL(poller.config.publicURL)
            }
            MenuButton("Open on this Mac", shortcut: nil) {
                openURL(poller.config.localBase)
            }
            MenuButton("Copy status", shortcut: nil) {
                let pasteboard = NSPasteboard.general
                pasteboard.clearContents()
                pasteboard.setString(poller.statusReport(), forType: .string)
            }
            MenuButton("Refresh now", shortcut: "r") {
                poller.refreshNow()
            }

            // A toggle rather than a one-way instruction to run pmset with
            // sudo. It holds only while it says it does, and only while this
            // app is running.
            MenuToggle(
                "Prevent sleep",
                isOn: SleepGuard.shared.enabled,
                failed: SleepGuard.shared.enabled && !SleepGuard.shared.holding
            ) {
                SleepGuard.shared.enabled.toggle()
            }

            Divider().padding(.vertical, 4)

            // The writes. Each one asks first: a menu is easy to hit by
            // accident, and every item below costs something to undo.
            if let signIn = snapshot.signIn, signIn.working {
                MenuButton("Signing in - see the window", shortcut: nil) {
                    openURL(poller.config.localBase.appending(path: "setup"))
                }
            } else if snapshot.session?.connected == true {
                MenuButton("Sign out of Instagram...", shortcut: nil) {
                    confirmSignOut = true
                }
            } else {
                MenuButton("Sign in to Instagram...", shortcut: nil) {
                    confirmSignIn = true
                }
            }

            MenuButton(
                snapshot.claude?.ok == true ? "Replace Claude token..." : "Add a Claude token...",
                shortcut: nil
            ) {
                token = ""
                askForToken = true
            }

            // Only in a bundle that carries its own server and has not got a
            // browser yet. 356 MB is not something to start without asking.
            if Server.shared.isHost {
                switch Browser.shared.state {
                case .fetching:
                    MenuButton("Downloading Chromium...", shortcut: nil) {}
                case .present:
                    EmptyView()
                case .failed(let why):
                    MenuButton("Chromium: \(why)", shortcut: nil) { Browser.shared.fetch() }
                case .unknown:
                    MenuButton("Download Chromium (356 MB)...", shortcut: nil) {
                        Browser.shared.fetch()
                    }
                }
            }

            Divider().padding(.vertical, 4)
            MenuButton("Quit", shortcut: "q") {
                NSApplication.shared.terminate(nil)
            }
        }
    }
}

// MARK: - Pieces

private enum Tone {
    case plain, good, bad, busy

    /// Healthy rows stay in the ordinary text colour. If everything is green
    /// then nothing is, and a red row has to compete for attention instead of
    /// being the only coloured thing on the panel. The header dot already says
    /// whether the whole picture is good.
    var color: Color? {
        switch self {
        case .plain, .good: return nil
        case .bad: return .red
        case .busy: return .blue
        }
    }
}

private struct Section<Content: View>: View {
    var title: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title.uppercased())
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.tertiary)
                .padding(.bottom, 2)
            content
        }
    }
}

private struct Row: View {
    var label: String
    var value: String
    var tone: Tone

    init(_ label: String, value: String, tone: Tone = .plain) {
        self.label = label
        self.value = value
        self.tone = tone
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(label)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .frame(width: 78, alignment: .leading)
            Text(value)
                .font(.system(size: 12))
                .foregroundStyle(tone.color ?? .primary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
    }
}

/// A plain button styled like a menu item, since MenuBarExtra in window mode
/// draws ordinary SwiftUI rather than real menu items.
/// A menu row that is on or off, with the checkmark on the left where macOS
/// puts it. `failed` is for the case where the answer is meant to be yes and
/// the system said no - silently showing a tick would be a lie.
private struct MenuToggle: View {
    var title: String
    var isOn: Bool
    var failed: Bool
    var action: () -> Void

    @State private var hovering = false

    init(_ title: String, isOn: Bool, failed: Bool = false, action: @escaping () -> Void) {
        self.title = title
        self.isOn = isOn
        self.failed = failed
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: failed ? "exclamationmark.triangle.fill" : "checkmark")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(failed ? Color.orange : Color.primary)
                    .opacity(isOn ? 1 : 0)
                    .frame(width: 12, alignment: .leading)
                Text(title).font(.system(size: 12))
                Spacer()
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
            .contentShape(Rectangle())
            .background(
                RoundedRectangle(cornerRadius: 5)
                    .fill(hovering ? Color.accentColor.opacity(0.18) : .clear)
            )
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(failed ? "macOS refused the request to stay awake." : "")
    }
}

private struct MenuButton: View {
    var title: String
    var shortcut: Character?
    var action: () -> Void

    @State private var hovering = false

    init(_ title: String, shortcut: Character?, action: @escaping () -> Void) {
        self.title = title
        self.shortcut = shortcut
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack {
                Text(title).font(.system(size: 12))
                Spacer()
                if let shortcut {
                    Text("⌘\(String(shortcut).uppercased())")
                        .font(.system(size: 11))
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
            .contentShape(Rectangle())
            .background(
                RoundedRectangle(cornerRadius: 5)
                    .fill(hovering ? Color.accentColor.opacity(0.18) : .clear)
            )
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .modifier(ShortcutModifier(shortcut: shortcut))
    }
}

private struct ShortcutModifier: ViewModifier {
    var shortcut: Character?

    func body(content: Content) -> some View {
        if let shortcut {
            content.keyboardShortcut(KeyEquivalent(shortcut), modifiers: .command)
        } else {
            content
        }
    }
}

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

            // The only item here that changes anything, so it is the only one
            // that asks. While a window is open it says so instead, because
            // opening a second one is not a thing that can happen.
            if let signIn = snapshot.signIn, signIn.working {
                MenuButton("Signing in - see the window", shortcut: nil) {
                    openURL(poller.config.localBase.appending(path: "setup"))
                }
            } else {
                MenuButton("Sign in to Instagram...", shortcut: nil) {
                    confirmSignIn = true
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

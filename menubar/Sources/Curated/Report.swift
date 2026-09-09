import Foundation
import SwiftUI

@MainActor
private func renderPanel(to path: String, poller: Poller) -> String {
    let renderer = ImageRenderer(content: MenuView(poller: poller).padding(4))
    renderer.scale = 2
    guard let image = renderer.nsImage,
          let tiff = image.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: tiff),
          let png = bitmap.representation(using: .png, properties: [:])
    else {
        return "Could not render the panel."
    }
    do {
        try png.write(to: URL(fileURLWithPath: path))
        return "Wrote \(path)"
    } catch {
        return "Could not write \(path): \(error.localizedDescription)"
    }
}

/// `Curated --report` polls once, prints the same summary the Copy status
/// item puts on the clipboard, and exits. Useful from a shell, from a script,
/// or over SSH where there is no menu bar to look at.
enum CommandLineReport {
    static func runIfRequested() {
        let arguments = CommandLine.arguments
        let snapshotIndex = arguments.firstIndex(of: "--snapshot")
        guard arguments.contains("--report") || arguments.contains("--json") || snapshotIndex != nil else { return }
        let wantsJSON = arguments.contains("--json")

        let done = DispatchSemaphore(value: 0)
        var output = ""

        Task { @MainActor in
            let poller = Poller.shared
            await poller.refresh()

            // Renders the panel to a PNG without needing a click or assistive
            // access. Development aid: it is how the layout gets checked.
            if let snapshotIndex, arguments.indices.contains(snapshotIndex + 1) {
                let path = arguments[snapshotIndex + 1]
                output = renderPanel(to: path, poller: poller)
                done.signal()
                return
            }

            output = wantsJSON ? poller.statusJSON() : poller.statusReport()
            done.signal()
        }

        // The report path runs before any UI exists, so there is no run loop
        // turning yet and the async work needs one.
        while done.wait(timeout: .now()) == .timedOut {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
        }

        print(output)
        exit(0)
    }
}

extension Poller {
    func statusJSON() -> String {
        let snapshot = snapshot
        var root: [String: Any] = [
            "takenAt": ISO8601DateFormatter().string(from: snapshot.takenAt),
            "health": String(describing: snapshot.health),
            "headline": snapshot.headline,
            "appReachable": snapshot.appReachable,
        ]
        if let error = snapshot.appError { root["appError"] = error }

        if let session = snapshot.session {
            root["session"] = [
                "connected": session.connected,
                "username": session.username as Any,
            ]
        }
        if let watch = snapshot.watch {
            root["watcher"] = [
                "listening": watch.listening,
                "sockets": watch.sockets,
                "eventsSeen": watch.eventsSeen,
                "lastEventAt": watch.lastEventAt.map { ISO8601DateFormatter().string(from: $0) } as Any,
                "lastSyncAt": watch.lastSyncAt.map { ISO8601DateFormatter().string(from: $0) } as Any,
            ]
        }
        if let sync = snapshot.sync {
            root["sync"] = [
                "running": sync.state.running,
                "phase": sync.state.phase as Any,
                "message": sync.state.message as Any,
                "paused": sync.pause.paused,
            ]
        }
        if let counts = snapshot.counts {
            root["posts"] = ["total": counts.total, "unread": counts.unread, "saved": counts.saved]
        }
        switch snapshot.site {
        case .reachable(let status): root["public"] = ["reachable": true, "status": status]
        case .unreachable(let why): root["public"] = ["reachable": false, "error": why]
        case .notChecked: root["public"] = ["reachable": false, "error": "not checked"]
        }
        root["lastClientConnect"] = snapshot.lastClientConnect.map { ISO8601DateFormatter().string(from: $0) } as Any

        guard let data = try? JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys]) else {
            return "{}"
        }
        return String(decoding: data, as: UTF8.self)
    }
}

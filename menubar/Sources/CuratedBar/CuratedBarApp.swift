import SwiftUI

/// The menu bar icon has to be right before anyone clicks it, and with
/// `.menuBarExtraStyle(.window)` the content view is not built until the panel
/// opens. So polling is started from the app delegate at launch rather than
/// from a `.task` on the view, and the model is a shared instance both the
/// label and the panel observe.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        MainActor.assumeIsolated {
            Poller.shared.start()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        MainActor.assumeIsolated {
            Poller.shared.stop()
        }
    }
}

@main
struct CuratedBarApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    init() {
        // Exits before any UI is created when --report or --json is passed.
        CommandLineReport.runIfRequested()
    }

    var body: some Scene {
        MenuBarExtra {
            MenuView(poller: Poller.shared)
        } label: {
            // The shape carries the state, and colour arrives only when
            // something is wrong. Anything wordier competes with the clock.
            Image(nsImage: Poller.shared.snapshot.health.barImage())
        }
        .menuBarExtraStyle(.window)
    }
}

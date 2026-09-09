import SwiftUI

/// The menu bar icon has to be right before anyone clicks it, and with
/// `.menuBarExtraStyle(.window)` the content view is not built until the panel
/// opens. So polling is started from the app delegate at launch rather than
/// from a `.task` on the view, and the model is a shared instance both the
/// label and the panel observe.
final class AppDelegate: NSObject, NSApplicationDelegate {
    /// Stop the server when this process is killed rather than quit.
    ///
    /// `applicationWillTerminate` covers Quit from the menu and a logout. It
    /// does not cover a SIGTERM from `pkill` or from launchd replacing the
    /// app - and the node server is a child process, not a thread, so it
    /// carries on holding the port after the thing supervising it has gone.
    /// The next launch then found the port busy and refused to start, which
    /// looked like the app being broken.
    private func trapSignals() {
        for signal in [SIGTERM, SIGINT] {
            let source = DispatchSource.makeSignalSource(signal: signal, queue: .main)
            source.setEventHandler {
                MainActor.assumeIsolated {
                    Server.shared.stop()
                    SleepGuard.shared.release()
                }
                exit(0)
            }
            source.resume()
            signalSources.append(source)
            // The default action still fires unless it is ignored, and it
            // would end the process before the handler above got a turn.
            Darwin.signal(signal, SIG_IGN)
        }
    }

    private var signalSources: [DispatchSourceSignal] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        trapSignals()
        MainActor.assumeIsolated {
            // The server first, when this bundle carries one: everything else
            // is about watching it, so there is nothing to watch until it is
            // up. It declines to start if anything already answers on the port.
            Browser.shared.check()
            Server.shared.startIfHosted(port: Poller.shared.config.localBase.port ?? 3000)
            Poller.shared.start()
            // Takes the assertion back if the toggle was left on.
            SleepGuard.shared.restore()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        MainActor.assumeIsolated {
            Poller.shared.stop()
            SleepGuard.shared.release()
            // Last, and it waits: stopping the server is what gives it the
            // chance to write the cookies back and close the browser tidily.
            Server.shared.stop()
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

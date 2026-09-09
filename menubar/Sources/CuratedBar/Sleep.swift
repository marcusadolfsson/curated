import Foundation
import IOKit.pwr_mgt
import Observation

/// Keeping the Mac awake, while the toggle says to.
///
/// The app holds a browser tab open to hear about new messages, and that stops
/// when the machine idles into sleep - so a sleeping Mac means posts arrive
/// whenever it next wakes rather than when they are sent. The documented
/// answer was `sudo pmset -a sleep 0`, which needs a password, is system-wide,
/// and stays changed long after anyone remembers doing it.
///
/// A power assertion is the same effect held only while this app wants it, and
/// released the moment it does not, or the moment the app quits - even if it
/// crashes, because the assertion belongs to the process. No password.
///
/// Deliberately `PreventUserIdleSystemSleep` and not the display equivalent:
/// the screen going dark costs nothing, and a Mac that will not dim its screen
/// because a menu bar app is watching an inbox is a worse neighbour.
///
/// It does not override closing a lid. On a laptop that still sleeps, which is
/// honest - that gesture means sleep, and no app should argue.
@MainActor
@Observable
final class SleepGuard {
    static let shared = SleepGuard()

    private static let key = "preventSleep"
    private var assertion: IOPMAssertionID = IOPMAssertionID(0)

    /// Restored at launch, so the choice survives a restart the way a setting
    /// should rather than quietly reverting to the default overnight.
    var enabled: Bool {
        didSet {
            guard enabled != oldValue else { return }
            UserDefaults.standard.set(enabled, forKey: Self.key)
            apply()
        }
    }

    private init() {
        enabled = UserDefaults.standard.bool(forKey: Self.key)
    }

    /// Take the assertion back after a restart, if the toggle was left on.
    ///
    /// Separate from `init` and called explicitly by the app delegate. Doing
    /// it in the initialiser meant the only thing forcing the singleton into
    /// existence was a discarded reference, and the assertion was simply never
    /// taken - a setting that looked saved and did nothing.
    func restore() {
        apply()
    }

    /// Whether an assertion is actually held. Not the same as `enabled`: the
    /// call can fail, and a toggle that says on while the Mac sleeps anyway
    /// would be worse than one that admits it.
    private(set) var holding = false

    private func apply() {
        if enabled {
            guard !holding else { return }
            var id = IOPMAssertionID(0)
            let result = IOPMAssertionCreateWithName(
                kIOPMAssertPreventUserIdleSystemSleep as CFString,
                IOPMAssertionLevel(kIOPMAssertionLevelOn),
                "Curated is listening for new posts" as CFString,
                &id
            )
            if result == kIOReturnSuccess {
                assertion = id
                holding = true
                FileHandle.standardError.write(Data("[sleep] holding: the Mac will not idle\n".utf8))
            } else {
                holding = false
                FileHandle.standardError.write(
                    Data("[sleep] macOS refused the assertion (\(result))\n".utf8)
                )
            }
        } else {
            guard holding else { return }
            IOPMAssertionRelease(assertion)
            assertion = IOPMAssertionID(0)
            holding = false
        }
    }

    /// Let go on the way out, without forgetting the setting. macOS would
    /// release it with the process anyway; doing it here means the log and
    /// `pmset -g assertions` agree during a tidy quit.
    func release() {
        guard holding else { return }
        IOPMAssertionRelease(assertion)
        assertion = IOPMAssertionID(0)
        holding = false
    }
}

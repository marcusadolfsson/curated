import Foundation
import Observation
import ServiceManagement

/// Starting at login, registered by the app itself.
///
/// This used to be a LaunchAgent plist written by `make login-item`, which had
/// three problems. It needed the repo, so an app handed to anybody else got no
/// login item at all. It hard-coded the path to the bundle, so moving or
/// renaming the app left an agent launching nothing - silently, with the only
/// symptom being no icon after a reboot. And it did not appear in System
/// Settings, where a person looks for exactly this.
///
/// `SMAppService.mainApp` is macOS tracking the app by its bundle identity
/// instead, which is what the stable signing identity was for. It shows up in
/// System Settings > General > Login Items, it survives the app moving, and the
/// user can turn it off there without knowing this menu exists.
@MainActor
@Observable
final class LoginItem {
    static let shared = LoginItem()

    private static let askedKey = "askedAboutLogin"

    /// Read from macOS rather than from a preference of our own. A checkmark
    /// that reflects what we last asked for would go on saying "on" after
    /// somebody turned it off in System Settings.
    var status: SMAppService.Status { SMAppService.mainApp.status }

    var enabled: Bool { status == .enabled }

    /// Turned off in System Settings rather than never asked for. Worth saying,
    /// because pressing the toggle will not fix it - only they can.
    var blocked: Bool { status == .requiresApproval }

    private(set) var lastError: String?

    /// One line for the status report.
    var description: String {
        switch status {
        case .enabled: return "starts at login"
        case .notRegistered: return "does not start at login"
        case .requiresApproval: return "turned off in System Settings > Login Items"
        case .notFound: return "not registered with macOS (unsigned or moved?)"
        @unknown default: return "unknown"
        }
    }

    func toggle() {
        lastError = nil
        do {
            if enabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// Whether to offer, once, on a fresh install.
    ///
    /// An app that quietly adds itself to login items has made a decision for
    /// somebody about their own machine. Asking once is the difference between
    /// an offer and a helpful liberty.
    var shouldOffer: Bool {
        !UserDefaults.standard.bool(forKey: Self.askedKey) && status == .notRegistered
    }

    func rememberAsked() {
        UserDefaults.standard.set(true, forKey: Self.askedKey)
    }
}

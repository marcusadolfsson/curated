import AppKit

/// Asking a question from a menu bar panel.
///
/// SwiftUI's `.alert` does not work here. With `.menuBarExtraStyle(.window)`
/// the menu is a panel that closes the moment it stops being key - and
/// clicking a button in it does exactly that - so the alert goes away with the
/// view that was presenting it. What you see is the menu closing and nothing
/// else happening, which is what every confirmation in this app did until
/// somebody tried to press one.
///
/// NSAlert is not owned by the panel, so it survives the panel closing. It has
/// to be scheduled rather than run inline, because at the moment of the click
/// the panel is still on its way out, and the app has to be activated or the
/// alert opens behind whatever is in front - this app has no Dock icon, so
/// nothing else would bring it forward.
@MainActor
enum Dialogs {
    static func confirm(
        _ title: String,
        message: String,
        action: String,
        destructive: Bool = false,
        then: @escaping () -> Void
    ) {
        present {
            let alert = NSAlert()
            alert.messageText = title
            alert.informativeText = message
            let go = alert.addButton(withTitle: action)
            if destructive { go.hasDestructiveAction = true }
            alert.addButton(withTitle: "Cancel")
            if alert.runModal() == .alertFirstButtonReturn { then() }
        }
    }

    /// A one-field question. Plain text rather than secure: what goes in here
    /// is pasted, not typed from memory, and a row of dots makes a mispaste
    /// impossible to see.
    /// `remove` adds a third, destructive button - for a value that can be
    /// taken away as well as replaced.
    static func prompt(
        _ title: String,
        message: String,
        placeholder: String,
        action: String,
        removeTitle: String? = nil,
        remove: (() -> Void)? = nil,
        then: @escaping (String) -> Void
    ) {
        present {
            let alert = NSAlert()
            alert.messageText = title
            alert.informativeText = message
            alert.addButton(withTitle: action)
            alert.addButton(withTitle: "Cancel")
            if let removeTitle {
                alert.addButton(withTitle: removeTitle).hasDestructiveAction = true
            }

            let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
            field.placeholderString = placeholder
            alert.accessoryView = field
            alert.window.initialFirstResponder = field

            switch alert.runModal() {
            case .alertFirstButtonReturn:
                let value = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
                if !value.isEmpty { then(value) }
            case .alertThirdButtonReturn:
                remove?()
            default:
                break
            }
        }
    }

    /// Something happened, and here is what. One button.
    static func info(_ title: String, message: String) {
        present {
            let alert = NSAlert()
            alert.messageText = title
            alert.informativeText = message
            alert.addButton(withTitle: "OK")
            alert.runModal()
        }
    }

    /// Waiting on a code from a browser.
    ///
    /// The third button opens the page again and comes straight back here,
    /// because "the tab closed" or "it opened behind everything" is the usual
    /// reason somebody has no code to paste - and that should not cost them
    /// the whole sign-in.
    static func codePrompt(
        _ title: String,
        message: String,
        placeholder: String,
        reopen: @escaping () -> Void,
        cancel: @escaping () -> Void,
        then: @escaping (String) -> Void
    ) {
        present {
            while true {
                let alert = NSAlert()
                alert.messageText = title
                alert.informativeText = message
                alert.addButton(withTitle: "Continue")
                alert.addButton(withTitle: "Cancel")
                alert.addButton(withTitle: "Open the Page Again")

                let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
                field.placeholderString = placeholder
                alert.accessoryView = field
                alert.window.initialFirstResponder = field

                switch alert.runModal() {
                case .alertFirstButtonReturn:
                    let code = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
                    if code.isEmpty { continue }
                    then(code)
                    return
                case .alertThirdButtonReturn:
                    reopen()
                    continue
                default:
                    cancel()
                    return
                }
            }
        }
    }

    private static func present(_ body: @escaping () -> Void) {
        DispatchQueue.main.async {
            NSApp.activate(ignoringOtherApps: true)
            body()
        }
    }
}

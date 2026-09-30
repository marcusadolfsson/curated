import AppKit
import Darwin

/// Getting a Claude token without a terminal.
///
/// The token has always come from `claude setup-token`, which meant opening a
/// terminal, having Claude Code installed, running it, and pasting what it
/// printed back into this app. The app already carries a `claude` binary - the
/// Agent SDK bundles one to run the analysis - so it can run that step itself.
///
/// What `setup-token` does, established by running it rather than assumed:
///
///   1. opens the browser at Claude's sign-in page;
///   2. after you authorise, the page does not call back to this machine - it
///      shows you a code to copy;
///   3. the CLI waits for that code on its input, exchanges it, and prints a
///      long-lived `sk-ant-oat01-...` token.
///
/// So this runs it, asks you for the code, types it in, and picks the token out
/// of the output. It needs a real pseudo-terminal: the CLI is an Ink program
/// and with plain pipes it prints nothing at all.
///
/// The token passes through here and nowhere else. It is never logged, and the
/// terminal output it arrives in is dropped the moment it has been read.
@MainActor
final class ClaudeSignIn {
    static let shared = ClaudeSignIn()

    private var session: SetupTokenSession?

    /// The binary to run: the app's own, else a Claude Code install.
    static var binary: URL? {
        let fm = FileManager.default
        let bundled = Bundle.main.resourceURL?.appending(
            path: "server/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude"
        )
        let installed = fm.homeDirectoryForCurrentUser.appending(path: ".local/bin/claude")
        return [bundled, installed].compactMap { $0 }.first { fm.isExecutableFile(atPath: $0.path) }
    }

    static var available: Bool { binary != nil }

    var running: Bool { session != nil }

    func start(poller: Poller) {
        guard session == nil else { return }
        guard let binary = Self.binary else {
            Dialogs.info("Cannot sign in from here",
                         message: "No claude binary was found in the app or in ~/.local/bin.")
            return
        }
        guard let session = SetupTokenSession(binary: binary) else {
            Dialogs.info("Cannot sign in from here", message: "The sign-in helper would not start.")
            return
        }
        self.session = session

        Task {
            // Wait until it has opened the browser, then ask for the code.
            //
            // Either sign will do - the prompt, or the sign-in URL it prints
            // beside it - and not seeing either is not a reason to give up
            // while the program is still running. The first version waited
            // twenty seconds for one exact phrase, never saw it, and killed
            // the sign-in while the person was still in the browser. The only
            // thing that ends this early now is the program itself ending.
            _ = await session.waitFor(timeout: 30) {
                SetupTokenSession.isAskingForCode($0) || $0.contains("claude.com/cai/oauth/authorize")
            }
            guard session.isRunning else {
                finish(failure: session.lastWords() ?? "The sign-in program stopped before it asked for a code.")
                return
            }
            askForCode(session, poller: poller)
        }
    }

    private func askForCode(_ session: SetupTokenSession, poller: Poller) {
        Dialogs.codePrompt(
            "Sign in with Claude",
            message: "Claude's sign-in page has opened in your browser. Sign in and authorise, "
                + "and the page will show you a code. Paste it here.",
            placeholder: "Code from the browser",
            reopen: { if let url = session.signInURL { NSWorkspace.shared.open(url) } },
            cancel: { [weak self] in self?.finish(failure: nil) }
        ) { [weak self] code in
            // Signing in can take a while - a password, a second factor - and
            // the program may have given up waiting in the meantime. Better to
            // say so than to type a code at nothing and wait a minute for it.
            guard session.isRunning else {
                self?.finish(failure: "The sign-in expired before the code arrived. Start again - "
                    + "the code only works for the sign-in that produced it.")
                return
            }
            session.send(code + "\r")
            Task { await self?.collectToken(session, poller: poller) }
        }
    }

    private func collectToken(_ session: SetupTokenSession, poller: Poller) async {
        _ = await session.waitFor(timeout: 60) { SetupTokenSession.token(in: $0) != nil || $0.contains("rror") }
        guard let token = session.token else {
            finish(failure: session.lastWords() ?? "Claude did not hand back a token. The code may have expired - try again.")
            return
        }
        finish(failure: nil)
        await poller.adoptClaudeToken(token)
    }

    /// Tears the session down. With a reason, says what went wrong; without
    /// one it was a success or a deliberate cancel, and stays quiet.
    private func finish(failure: String?) {
        session?.stop()
        session = nil
        if let failure {
            Dialogs.info("Could not sign in with Claude", message: failure)
        }
    }
}

import fs from "node:fs";
import type { BrowserContext, Page } from "playwright";
import { PROFILE_DIR, STORAGE_STATE_PATH, ensureDirs } from "@/lib/paths";
import { getSyncState } from "@/lib/sync";
import { startWatcher, stopWatcher } from "@/lib/watcher";
import { browserOptions, closeBrowser, finishSignIn } from "./client";

/**
 * Signing in at a window, rather than by pasting a cookie.
 *
 * The old way asked you to sign in somewhere else, dig the cookie out of
 * developer tools, and paste it here - and the session that arrived had been
 * made on another machine, in another browser, and was then used from this
 * one. This opens Instagram's own login page in the browser that will do the
 * using, on the profile it has been using all along, and takes what Instagram
 * puts in the jar.
 *
 * What it does not do is handle the password. The page is the real
 * instagram.com over TLS; the typing is yours, and nothing here reads it,
 * stores it or replays it. An app that renders its own login form is doing
 * something else entirely, whatever it says on the button.
 *
 * A checkpoint or a second factor is therefore not a special case. It is a
 * page, in front of a person, who deals with it.
 */

const LOGIN_URL = "https://www.instagram.com/accounts/login/";
/** How long the window may stand open before it is taken away. */
const WINDOW_MS = 6 * 60_000;
/** How often the cookie jar is checked while it stands open. */
const POLL_MS = 1_000;

export type SignInPhase =
  | "idle"
  | "opening"
  | "waiting"
  | "verifying"
  | "done"
  | "failed"
  | "cancelled";

export type SignInState = {
  phase: SignInPhase;
  message: string;
  username: string | null;
  /** When the window opened, so the page can show how long is left. */
  startedAt: string | null;
  /** True while the app's own browser is down for this. */
  paused: boolean;
};

type Runtime = {
  state: SignInState;
  running: Promise<void> | null;
  cancel: boolean;
};

const idle: SignInState = {
  phase: "idle",
  message: "",
  username: null,
  startedAt: null,
  paused: false,
};

const globalForSignIn = globalThis as unknown as { __igSignIn?: Runtime };
const runtime: Runtime = (globalForSignIn.__igSignIn ??= {
  state: { ...idle },
  running: null,
  cancel: false,
});

export function getSignInState(): SignInState {
  return { ...runtime.state };
}

function set(next: Partial<SignInState>) {
  runtime.state = { ...runtime.state, ...next };
}

/** Ask a window that is standing open to give up and close. */
export function cancelSignIn(): SignInState {
  if (runtime.running) runtime.cancel = true;
  return getSignInState();
}

/**
 * Open the login window.
 *
 * Returns as soon as the window is up rather than when the sign-in finishes,
 * because what happens next is somebody typing. The caller polls the state.
 */
export async function beginSignIn(): Promise<SignInState> {
  if (runtime.running) return getSignInState();

  // Mid-sync is the one time this cannot happen: the sync is driving the same
  // browser this is about to close underneath it.
  const sync = getSyncState();
  if (sync.running) {
    return { ...idle, phase: "failed", message: "A sync is running. Try again when it finishes." };
  }

  runtime.cancel = false;
  runtime.state = { ...idle, phase: "opening", startedAt: new Date().toISOString(), paused: true };
  runtime.running = run().finally(() => {
    runtime.running = null;
    set({ paused: false });
  });
  return getSignInState();
}

async function run() {
  let context: BrowserContext | null = null;
  /**
   * Whether there is a new session to prove.
   *
   * A flag rather than an early return. Returning out of the try skipped
   * everything after the block - which is where the headless browser and the
   * watcher are brought back - so cancelling the window left the app with
   * neither, quietly, until something restarted it.
   */
  let captured = false;

  try {
    // One Chromium per profile - the point is to sign in as the browser
    // Instagram already knows, so the headless one has to stand aside. The
    // watcher is stopped first because it holds the browser open on purpose.
    await stopWatcher().catch(() => undefined);
    await closeBrowser();

    ensureDirs();
    const { chromium } = await import("playwright");
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      ...(await browserOptions()),
      headless: false,
    });

    const page = context.pages()[0] ?? (await context.newPage());
    set({ phase: "waiting", message: "Sign in in the window that opened." });
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

    // waitForSession sets the reason when the answer is no.
    if (await waitForSession(context, page)) {
      set({ phase: "verifying", message: "Checking the session." });
      // Everything Instagram put in the jar, written where a restart will find
      // it. The profile is the live copy; this file is the backup and the way a
      // session moves to another machine.
      await context.storageState({ path: STORAGE_STATE_PATH });
      fs.chmodSync(STORAGE_STATE_PATH, 0o600);
      captured = true;
    }
  } catch (error) {
    set({
      phase: "failed",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await context?.close().catch(() => undefined);
  }

  // The headless browser comes back either way: a cancelled or failed sign-in
  // should not leave the app without the one it had.
  if (captured) {
    try {
      const outcome = await finishSignIn();
      if (outcome.status === "ok") {
        set({ phase: "done", message: "Signed in.", username: outcome.username });
      } else {
        set({ phase: "failed", message: outcome.message });
      }
    } catch (error) {
      set({
        phase: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await startWatcher().catch(() => undefined);
}

/**
 * Wait for Instagram to hand the browser a *new* session.
 *
 * Watching the cookie rather than the page: a login can land on the home feed,
 * on a "save your login info" interstitial, or on a checkpoint cleared a minute
 * later, and all three are signed in as far as the jar is concerned.
 *
 * It has to be a new one. This profile is almost always signed in already -
 * that is the point of doing it here - so waiting for a sessionid to exist
 * would succeed before anybody had typed anything. Logging in mints a fresh
 * one, so the test is that the value changed. If Instagram ever handed back
 * the identical session the window would time out and the paste field is still
 * there, which is the right way round to be wrong.
 */
async function waitForSession(context: BrowserContext, page: Page): Promise<boolean> {
  const deadline = Date.now() + WINDOW_MS;
  const before = await sessionValue(context);

  while (Date.now() < deadline) {
    if (runtime.cancel) {
      set({ phase: "cancelled", message: "Sign-in cancelled." });
      return false;
    }
    if (page.isClosed()) {
      set({ phase: "cancelled", message: "The window was closed before signing in." });
      return false;
    }

    const now = await sessionValue(context);
    if (now && now !== before) return true;

    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  set({ phase: "failed", message: "Nobody signed in before the window timed out." });
  return false;
}

async function sessionValue(context: BrowserContext): Promise<string | null> {
  const cookies = await context.cookies("https://www.instagram.com").catch(() => []);
  return cookies.find((cookie) => cookie.name === "sessionid")?.value || null;
}

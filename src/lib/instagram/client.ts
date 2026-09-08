import fs from "node:fs";
import type { Browser, BrowserContext, Page } from "playwright";
import { STORAGE_STATE_PATH, ensureDirs } from "@/lib/paths";
import { asBool, getSetting, setSettings } from "@/lib/settings";
import { RateLimitedError, SessionExpiredError } from "./errors";
import { closeInboxTab, igJson, inboxTab } from "./tab";

export { RateLimitedError, SessionExpiredError };

/**
 * The browser that is signed in to Instagram.
 *
 * This file owns the Chromium process and the session in it: launching with
 * the right identity and egress, keeping the cookies on disk, taking a pasted
 * session cookie, and knowing whether the session is alive. Talking to
 * Instagram happens in ./tab, from inside a page - never from here with the
 * cookies copied onto a Node request.
 *
 * There is no password login. Instagram's login endpoint is throttled by IP
 * and every scraper posts the same plaintext `#PWD_INSTAGRAM_BROWSER:0:`
 * password shape at it, which the real page stopped doing years ago. Signing
 * in at instagram.com in your own browser and pasting the cookie is both
 * quieter and more reliable.
 */

/**
 * The platform half of the user agent, taken from the host rather than assumed.
 *
 * This string used to say Windows everywhere. On the cloud box that was the
 * point: a Linux container had nothing to gain by announcing Linux. On the Mac
 * it undid the reason for moving home - a genuine macOS Chromium whose TLS
 * handshake says macOS, sending headers that say Windows, is the mismatch the
 * move was supposed to remove rather than introduce.
 *
 * Both literals here are what Chrome itself sends, not what the host reports.
 * Chrome froze the macOS version at 10_15_7 years ago and still says "Intel"
 * on Apple Silicon, so reading the real values would stand out rather than
 * blend in.
 */
function platformToken(): string {
  switch (process.platform) {
    case "darwin":
      return "Macintosh; Intel Mac OS X 10_15_7";
    case "linux":
      return "X11; Linux x86_64";
    default:
      return "Windows NT 10.0; Win64; x64";
  }
}

/**
 * A user agent that agrees with the browser sending it. Playwright derives the
 * Client Hints platform from this string, but the brand and version come from
 * the binary - so a fixed "Chrome/131" over a Chromium 151 said two different
 * things on every request. Built from the launched browser's own version.
 */
function userAgentFor(browserVersion: string): string {
  const major = browserVersion.split(".")[0] || "131";
  return `Mozilla/5.0 (${platformToken()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

const IDLE_SHUTDOWN_MS = 5 * 60_000;

export type LoginOutcome =
  | { status: "ok"; username: string | null }
  | { status: "unverified"; message: string }
  | { status: "failed"; message: string };

export type SessionStatus = {
  connected: boolean;
  username: string | null;
  userId: string | null;
  /** When the inbox last actually loaded with this session. */
  verifiedAt: string | null;
  checkedAt: string;
  message?: string;
};

type Runtime = {
  browser: Browser | null;
  context: BrowserContext | null;
  idleTimer: NodeJS.Timeout | null;
  starting: Promise<BrowserContext> | null;
  statusCache: { at: number; status: SessionStatus } | null;
  /** Things that need the browser to stay open, like the realtime watcher. */
  holds: number;
  /**
   * Set when Instagram has answered "not signed in". Nothing else asks again:
   * the answer only changes when a cookie is pasted, which clears it.
   * Rechecking on a schedule was a habit from polling.
   */
  sessionDead: boolean;
  verifiedAt: number | null;
};

// Next dev reloads modules; keep one browser per process.
const globalForIg = globalThis as unknown as { __igRuntime?: Runtime };
const runtime: Runtime = (globalForIg.__igRuntime ??= {
  browser: null,
  context: null,
  idleTimer: null,
  starting: null,
  statusCache: null,
  holds: 0,
  sessionDead: false,
  verifiedAt: null,
});

export function isSessionKnownDead(): boolean {
  return runtime.sessionDead;
}

/** Called by the tab when Instagram sends it to the login page. */
export function markSessionDead() {
  runtime.sessionDead = true;
  runtime.statusCache = null;
}

/** The tab loaded the inbox: the session is good as of now. */
export function markSessionVerified() {
  runtime.sessionDead = false;
  runtime.verifiedAt = Date.now();
  runtime.statusCache = null;
  void persistState();
}

/**
 * Write the live cookies back to disk. Instagram rotates the session cookie
 * over time; the browser's jar follows, but the file it was loaded from did
 * not - so every restart went back to the cookie as pasted, and after enough
 * restarts that cookie was one Instagram had retired. Saved whenever the
 * inbox loads and before the browser closes.
 */
async function persistState() {
  const context = runtime.context;
  if (!context) return;
  try {
    await saveState(context);
  } catch (error) {
    console.warn("[session] could not save the session state:", error);
  }
}

/**
 * Keep the browser from closing itself while something long-lived is using
 * it. Returns a release function; the idle shutdown resumes when the last
 * hold is released.
 */
export function holdBrowserOpen(): () => void {
  runtime.holds += 1;
  if (runtime.idleTimer) {
    clearTimeout(runtime.idleTimer);
    runtime.idleTimer = null;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    runtime.holds = Math.max(0, runtime.holds - 1);
    if (runtime.holds === 0 && runtime.context) touchIdleTimer();
  };
}

const STATUS_TTL_MS = 5 * 60_000;

function touchIdleTimer() {
  if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
  if (runtime.holds > 0) return; // something is listening; do not shut down
  runtime.idleTimer = setTimeout(() => void closeBrowser(), IDLE_SHUTDOWN_MS);
  runtime.idleTimer.unref?.();
}

export async function getContext(): Promise<BrowserContext> {
  if (runtime.context) {
    touchIdleTimer();
    return runtime.context;
  }
  runtime.starting ??= startContext();
  try {
    return await runtime.starting;
  } finally {
    runtime.starting = null;
  }
}

async function startContext(): Promise<BrowserContext> {
  ensureDirs();
  const { chromium } = await import("playwright");
  const headless = asBool(await getSetting("headless"));

  // Set on the browser rather than the context: Chromium only honours
  // per-context proxies when it was launched with one, and there is a single
  // browser per process anyway.
  const proxy = await proxySettings();

  // The full Chromium in its new headless mode, not the headless shell. The
  // shell announces itself: every request carried
  //   sec-ch-ua: "HeadlessChrome";v="151"
  // regardless of the user agent string.
  const browser = await chromium.launch({
    headless,
    channel: "chromium",
    proxy,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
  });

  const hasState = fs.existsSync(STORAGE_STATE_PATH);
  const context = await browser.newContext({
    userAgent: userAgentFor(browser.version()),
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    storageState: hasState ? STORAGE_STATE_PATH : undefined,
  });
  context.setDefaultTimeout(45_000);

  runtime.browser = browser;
  runtime.context = context;
  touchIdleTimer();
  return context;
}

/**
 * Where Instagram traffic should leave from.
 *
 * A session cookie is created in a browser at home and then used from here. If
 * those two are different addresses - worse, a residential one and a datacenter
 * one - that mismatch is itself a signal to Instagram, on top of the datacenter
 * address being suspect on its own. Sending the traffic back out through home
 * makes the session's origin match where it was made.
 */
async function proxySettings() {
  const server = (await getSetting("proxyServer")).trim();
  if (!server) return undefined;

  const username = (await getSetting("proxyUsername")).trim();
  const password = await getSetting("proxyPassword");

  return username ? { server, username, password } : { server };
}

/** The address Instagram sees. The point of the proxy, so worth being able to check. */
export async function egressAddress(): Promise<{ ip: string | null; via: string | null; error?: string }> {
  const via = (await getSetting("proxyServer")).trim() || null;
  try {
    const context = await getContext();
    const response = await context.request.get("https://api.ipify.org?format=json", {
      failOnStatusCode: false,
      timeout: 20_000,
    });
    if (!response.ok()) return { ip: null, via, error: `Lookup answered HTTP ${response.status()}` };
    const data = (await response.json()) as { ip?: string };
    return { ip: data.ip ?? null, via };
  } catch (error) {
    return { ip: null, via, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function closeBrowser() {
  if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
  runtime.idleTimer = null;
  if (!runtime.sessionDead) await persistState();
  await closeInboxTab();
  const { browser, context } = runtime;
  runtime.context = null;
  runtime.browser = null;
  try {
    await context?.close();
    await browser?.close();
  } catch {
    // already gone
  }
}

async function saveState(context: BrowserContext) {
  ensureDirs();
  await context.storageState({ path: STORAGE_STATE_PATH });
  fs.chmodSync(STORAGE_STATE_PATH, 0o600);
}

function remember(status: SessionStatus): SessionStatus {
  runtime.statusCache = { at: Date.now(), status };
  return status;
}

/** Something that was talking to Instagram learned who the session is; keep it. */
export async function noteIdentity(username: string, userId: string | null) {
  const current = await storedIdentity();
  if (current.username === username && (current.userId === userId || !userId)) return;
  await setSettings({ sessionUsername: username, sessionUserId: userId ?? current.userId ?? "" });
  runtime.statusCache = null;
}

async function storedIdentity(): Promise<{ username: string | null; userId: string | null }> {
  const username = (await getSetting("sessionUsername")).trim() || null;
  const userId = (await getSetting("sessionUserId")).trim() || null;
  return { username, userId };
}

/**
 * Whether the session is signed in.
 *
 * Passive by default: it reports what is known - a session on disk that has
 * not been refused - without touching Instagram, because the UI asks this on
 * every page load and a check that opens the inbox each time would be a
 * five-minute heartbeat. With `verify`, the inbox tab is opened (or reused),
 * which is the one honest test: it either loads or lands on the login page.
 */
export async function getSessionStatus(options?: { verify?: boolean }): Promise<SessionStatus> {
  const cached = runtime.statusCache;
  if (!options?.verify && cached && Date.now() - cached.at < STATUS_TTL_MS) {
    return { ...cached.status, checkedAt: new Date(cached.at).toISOString() };
  }

  const base = {
    checkedAt: new Date().toISOString(),
    verifiedAt: runtime.verifiedAt ? new Date(runtime.verifiedAt).toISOString() : null,
  };
  const signedOut = (message?: string) =>
    remember({ connected: false, username: null, userId: null, ...base, message });

  if (!fs.existsSync(STORAGE_STATE_PATH)) return signedOut();
  if (runtime.sessionDead) return signedOut("Signed out. Paste a new session cookie on the setup page.");

  let identity = await storedIdentity();

  if (options?.verify) {
    try {
      const page = await inboxTab();
      markSessionVerified();
      base.verifiedAt = new Date(runtime.verifiedAt as number).toISOString();

      // A session from before identities were kept: learn it from the page
      // that just loaded, once.
      if (!identity.username) {
        identity = await whoAmI(page);
        if (identity.username) {
          await setSettings({
            sessionUsername: identity.username,
            sessionUserId: identity.userId ?? "",
          });
        }
      }
    } catch (error) {
      return signedOut(error instanceof Error ? error.message : String(error));
    }
  }

  return remember({ connected: true, ...identity, ...base });
}

/**
 * Sign in with a cookie copied from a browser that is already signed in.
 *
 * The cookie is proven by loading the inbox with it: a session Instagram
 * honours gets the inbox, one it does not gets the login page. Nothing else
 * is asked. Who the session belongs to is read out of the page it loaded.
 */
export async function setSessionCookie(rawSessionId: string, userId?: string): Promise<LoginOutcome> {
  const sessionId = normalizeCookieValue(rawSessionId, "sessionid");
  if (!sessionId) {
    return { status: "failed", message: "That does not look like a sessionid value." };
  }

  const context = await getContext();
  const cookies = [
    {
      name: "sessionid",
      value: sessionId,
      domain: ".instagram.com",
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax" as const,
    },
  ];
  const dsUserId = userId ? normalizeCookieValue(userId, "ds_user_id") : "";
  if (dsUserId) {
    cookies.push({
      name: "ds_user_id",
      value: dsUserId,
      domain: ".instagram.com",
      path: "/",
      httpOnly: false,
      secure: true,
      sameSite: "Lax" as const,
    });
  }
  await context.addCookies(cookies);
  runtime.sessionDead = false;
  runtime.statusCache = null;

  let page: Page;
  try {
    page = await inboxTab({ refresh: true });
  } catch (error) {
    if (error instanceof SessionExpiredError) {
      return {
        status: "failed",
        message:
          "Instagram did not accept that cookie. It is truncated, already expired, or was invalidated " +
          "by signing out in the browser it was copied from.",
      };
    }
    // A 429 or a network fault proves nothing about the cookie. Keep it rather
    // than making you paste it again once the trouble clears.
    await saveState(context);
    const why = error instanceof Error ? error.message : String(error);
    return {
      status: "unverified",
      message: `Cookie saved, but it could not be checked yet${error instanceof RateLimitedError ? " (Instagram is rate-limiting this address)" : ""}: ${why}`,
    };
  }

  markSessionVerified();
  const identity = await whoAmI(page);
  await setSettings({
    sessionUsername: identity.username ?? "",
    sessionUserId: identity.userId ?? dsUserId,
  });
  await saveState(context);

  return { status: "ok", username: identity.username };
}

/**
 * Who the loaded inbox belongs to, read out of the page. The viewer is in the
 * page's own data; only if that shape has moved is one identity call made.
 */
async function whoAmI(page: Page): Promise<{ username: string | null; userId: string | null }> {
  const scraped = await page.evaluate(() => {
    const html = document.documentElement.innerHTML;
    const viewer = html.match(/"PolarisViewer",\[\],\{"data":\{([^}]{0,600})/);
    const block = viewer ? viewer[1] : "";
    const username = block.match(/"username":"([^"]+)"/)?.[1] ?? null;
    const userId =
      block.match(/"id":"(\d+)"/)?.[1] ?? html.match(/"USER_ID":"(\d+)"/)?.[1] ?? null;
    return { username, userId };
  });
  if (scraped.username) return scraped;

  try {
    const data = await igJson<{ user?: { username?: string; pk?: string | number } }>(
      "/api/v1/accounts/current_user/",
    );
    return {
      username: data.user?.username ?? null,
      userId: data.user?.pk != null ? String(data.user.pk) : scraped.userId,
    };
  } catch {
    return scraped;
  }
}

export async function logout() {
  runtime.statusCache = null;
  runtime.sessionDead = false;
  runtime.verifiedAt = null;
  await setSettings({ sessionUsername: "", sessionUserId: "" });
  await closeBrowser();
  if (fs.existsSync(STORAGE_STATE_PATH)) fs.rmSync(STORAGE_STATE_PATH);
}

/**
 * People paste whatever the browser gave them: the bare value, `sessionid=...`,
 * a quoted value, or the whole document.cookie string. Pull the value out of
 * any of those rather than sending a cookie that cannot work.
 */
function normalizeCookieValue(input: string, name: string): string {
  let value = input.trim().replace(/^["']|["']$/g, "");

  const fromPair = value.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  if (fromPair) value = fromPair[1];

  return value.trim().replace(/^["']|["']$/g, "");
}

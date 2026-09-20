import type { Page, WebSocket } from "playwright";
import {
  RateLimitedError,
  ScrapingWarningError,
  SessionExpiredError,
  holdBrowserOpen,
  isSessionKnownDead,
} from "@/lib/instagram/client";
import { closeInboxTab, currentTab, inboxTab, onTab } from "@/lib/instagram/tab";
import { isAwake, msUntilAwake, msUntilBed } from "@/lib/hours";
import { between } from "@/lib/pace";
import { pauseAutomation, pauseState } from "@/lib/pause";
import { asBool, getSetting } from "@/lib/settings";
import { getSyncState, startSync } from "@/lib/sync";

/**
 * Sync when something actually happens, instead of on a schedule.
 *
 * The DM inbox page keeps realtime sockets open - edge-chat.instagram.com and
 * gateway.instagram.com/ws/* - and that is how a new message reaches the tab.
 * The shared inbox tab is therefore also the ear: inbound traffic on those
 * sockets is the signal. The frames are binary MQTT and are not parsed.
 * Keepalives are tiny and filtered on size; anything else is debounced by a
 * human-shaped delay and rate-limited, so a chatty socket costs at most one
 * look every ten minutes.
 *
 * The tab is open during the day and closed at night, like a desktop that
 * gets locked. The twice-daily timer stays as the safety net for when this is
 * down.
 */

export type WatcherState = {
  enabled: boolean;
  listening: boolean;
  since: string | null;
  sockets: number;
  lastEventAt: string | null;
  lastSyncAt: string | null;
  syncsTriggered: number;
  eventsSeen: number;
  error: string | null;
};

const SOCKET_HOSTS = /edge-chat\.instagram\.com|gateway\.instagram\.com\/ws\//;
const KEEPALIVE_MAX_BYTES = 16; // MQTT PINGRESP and friends are 2-4 bytes

// The shape of a person, not a process. A notification arrives; a minute to
// five later they look. Not eight seconds, every time.
const REACT_MIN_MS = 60_000;
const REACT_MAX_MS = 300_000;
/**
 * The floor between two inbox reads.
 *
 * It was ten minutes, on the reasoning that nobody reloads their inbox more
 * often than that while chatting. True, and beside the point: a person does
 * not reload it every ten minutes all day either, and that is what ten minutes
 * became once every socket flicker booked the next slot. Thirty is a number a
 * person might plausibly produce on a busy day, and the daily budget below
 * stops even that from running all day unnoticed.
 */
const MIN_GAP_MS = 30 * 60_000;
// The wait after a failure, doubling while the fault lasts. A person whose
// page will not load tries again, and then gives it a rest; they do not knock
// once a minute all day.
const RETRY_MIN_MS = 60_000;
const RETRY_MAX_MS = 30 * 60_000;
// A long-lived page picks up stale tokens, so it is reloaded now and then -
// but at no fixed hour, because a reload landing on a six-hour grid is a
// clock, and clocks are what automation looks like.
/**
 * How long everything stops after a scraping warning.
 *
 * Longer than the six hours a 429 buys, because a 429 is a rate and this is a
 * judgement. Long enough that the account is quiet for a day either side of
 * somebody noticing.
 */
const SCRAPING_PAUSE_HOURS = 48;
const REFRESH_MIN_MS = 4 * 3600_000;
const REFRESH_MAX_MS = 8 * 3600_000;

type Runtime = {
  state: WatcherState;
  release: (() => void) | null;
  unsubscribe: (() => void) | null;
  debounce: NodeJS.Timeout | null;
  reconnect: NodeJS.Timeout | null;
  refresh: NodeJS.Timeout | null;
  starting: Promise<void> | null;
  wanted: boolean;
  /** Consecutive failures, which is what the retry wait is built from. */
  failures: number;
  /** The inbox tab's title at the last sync, to tell a message from typing. */
  lastInboxMark: string | null;
};

const globalForWatcher = globalThis as unknown as { __igWatcher?: Runtime };
const runtime: Runtime = (globalForWatcher.__igWatcher ??= {
  state: {
    enabled: false,
    listening: false,
    since: null,
    sockets: 0,
    lastEventAt: null,
    lastSyncAt: null,
    syncsTriggered: 0,
    eventsSeen: 0,
    error: null,
  },
  release: null,
  unsubscribe: null,
  debounce: null,
  reconnect: null,
  refresh: null,
  starting: null,
  wanted: false,
  failures: 0,
  lastInboxMark: null,
});

export function getWatcherState(): WatcherState {
  return { ...runtime.state };
}

/** Start listening (idempotent). Safe to call on every boot and after a sign-in. */
export async function startWatcher(): Promise<WatcherState> {
  runtime.wanted = true;
  runtime.state.enabled = true;
  if (runtime.state.listening && currentTab()) return getWatcherState();
  runtime.starting ??= open().finally(() => {
    runtime.starting = null;
  });
  await runtime.starting;
  return getWatcherState();
}

export async function stopWatcher(): Promise<WatcherState> {
  runtime.wanted = false;
  runtime.state.enabled = false;
  await teardown();
  runtime.state.listening = false;
  runtime.state.since = null;
  runtime.state.sockets = 0;
  return getWatcherState();
}

async function open() {
  if (!asBool(await getSetting("realtime"))) {
    runtime.state.enabled = false;
    return;
  }

  const paused = await pauseState();
  if (paused.paused) {
    // Wait out the pause rather than asking every minute whether it is over.
    scheduleReconnect(`paused until ${paused.until}`, msUntilResume(paused.until));
    return;
  }

  if (!isAwake()) {
    scheduleReconnect("night - the tab is closed until morning", msUntilAwake());
    return;
  }

  // Signed out is not a fault to retry. Instagram has said so once; the only
  // thing that changes it is a cookie pasted through the app, and that route
  // calls startWatcher(). Until then: silence.
  if (isSessionKnownDead()) {
    parked("signed out - waiting for a new session cookie");
    return;
  }

  try {
    runtime.release ??= holdBrowserOpen();
    runtime.unsubscribe ??= onTab({ open: attach, close: onTabClosed });

    // A load, not a reuse: the sockets are only seen if the listener was on
    // the page before they opened.
    await inboxTab({ refresh: true });

    runtime.state.listening = true;
    runtime.state.since = new Date().toISOString();
    runtime.state.error = null;
    runtime.failures = 0;
    console.log("[watcher] listening on the inbox");

    // Tokens and the session drift over a long-lived page; a reload every few
    // hours keeps it honest, and at bedtime the tab closes until morning.
    scheduleRefresh();
  } catch (error) {
    await handleFailure(error);
  }
}

/** The next reload, or bedtime if that comes first. */
function scheduleRefresh() {
  if (runtime.refresh) clearTimeout(runtime.refresh);
  const untilBed = msUntilBed();
  const untilRefresh = between(REFRESH_MIN_MS, REFRESH_MAX_MS);
  runtime.refresh = setTimeout(() => {
    if (!runtime.wanted) return;
    if (untilBed < untilRefresh) void bedtime();
    else void reload();
  }, Math.min(untilRefresh, untilBed));
  runtime.refresh.unref?.();
}

/**
 * What to do when the inbox will not open.
 *
 * A refusal and a fault are different things. Being signed out is final until
 * a cookie is pasted. Being rate-limited is Instagram asking us to stop, so
 * everything stops - the same answer the sync gives - rather than knocking
 * again in a minute, which is what this used to do for as long as the 429
 * lasted. Anything else is a fault, and faults get a doubling wait.
 */
async function handleFailure(error: unknown) {
  // The strongest thing Instagram says short of locking the account, and it
  // used to be filed as an ordinary fault: park, retry, land on the warning,
  // and go back to syncing as though nothing had happened. A long pause, and
  // a person has to lift it.
  if (error instanceof ScrapingWarningError) {
    await pauseAutomation(
      "Instagram served a scraping warning. Everything is stopped until you lift this by hand.",
      SCRAPING_PAUSE_HOURS,
    );
    parked("scraping warning - stopped until a person lifts it");
    console.error(`[watcher] ${error.message}`);
    return;
  }

  if (error instanceof SessionExpiredError) {
    parked("signed out - waiting for a new session cookie");
    return;
  }

  if (error instanceof RateLimitedError) {
    await pauseAutomation("Instagram rate-limited the inbox page, so the watcher stopped rather than pressing on.");
    const paused = await pauseState();
    scheduleReconnect("rate-limited - everything is paused", msUntilResume(paused.until));
    return;
  }

  retryLater(error instanceof Error ? error.message : String(error));
}

/** How long until a pause lifts, with a few minutes' grace. */
function msUntilResume(until: string | null): number {
  const at = until ? Date.parse(until) : Number.NaN;
  const wait = Number.isFinite(at) ? at - Date.now() : 60 * 60_000;
  return Math.max(wait, 60_000) + between(0, 10 * 60_000);
}

/** A new inbox page exists (opened by whoever needed it first); listen to it. */
function attach(page: Page) {
  runtime.state.sockets = 0;
  page.on("websocket", (socket) => watchSocket(socket));
}

function onTabClosed() {
  if (!runtime.wanted) return;
  runtime.state.listening = false;
  runtime.state.sockets = 0;
  // Closed by the idle shutdown, a proxy change, or bedtime. Usually a one-off,
  // so the first retry is quick - but it grows like any other, because a
  // browser that keeps dying should not mean a page load every fifteen seconds.
  retryLater("the inbox tab closed", 15_000);
}

function watchSocket(socket: WebSocket) {
  if (!SOCKET_HOSTS.test(socket.url())) return;
  runtime.state.sockets += 1;

  socket.on("framereceived", (frame) => {
    const size =
      typeof frame.payload === "string" ? frame.payload.length : frame.payload.byteLength;
    if (size <= KEEPALIVE_MAX_BYTES) return;
    onActivity();
  });

  socket.on("close", () => {
    runtime.state.sockets = Math.max(0, runtime.state.sockets - 1);
    // The page normally reopens its sockets itself; if they all go and stay
    // gone, the refresh timer will bring the page back.
  });
}

function onActivity() {
  runtime.state.eventsSeen += 1;
  runtime.state.lastEventAt = new Date().toISOString();

  // One look per burst of activity, after a human-shaped pause.
  if (runtime.debounce) return;
  const wait = REACT_MIN_MS + Math.random() * (REACT_MAX_MS - REACT_MIN_MS);
  runtime.debounce = setTimeout(() => {
    runtime.debounce = null;
    void trigger();
  }, wait);
  runtime.debounce.unref?.();
}

async function trigger() {
  const last = runtime.state.lastSyncAt ? Date.parse(runtime.state.lastSyncAt) : 0;
  if (Date.now() - last < MIN_GAP_MS) {
    // Dropped, not deferred.
    //
    // This used to reschedule itself for the moment the gap expired, which
    // turned the floor into the rate. The socket carries presence and typing
    // as well as messages, so something lands in almost every ten-minute
    // window - and each one booked the next sync. The result was a read every
    // ten minutes, sixteen hours a day, 323 of them over four days, almost all
    // returning nothing. Instagram called that scraping, and it was right.
    //
    // If this really was a new message, the thread it is in will stir again,
    // and the next look catches it. Nothing is lost that the twice-daily
    // fallback would not find anyway.
    return;
  }

  if (getSyncState().running) return; // it will pick up whatever arrived

  if (!isAwake()) return; // it arrived late; the morning reconnect will catch it

  // A ceiling, so no future bug can quietly become a poller again. This is not
  // pacing - the gap above is pacing - it is the thing that notices when the
  // pacing has stopped working.
  if (!withinDailyBudget()) {
    console.warn(
      `[watcher] daily look budget spent (${MAX_SYNCS_PER_DAY}); ` +
        `not syncing again until tomorrow`,
    );
    return;
  }

  if (isSessionKnownDead()) {
    // Signed out. One attempt is a check; a schedule of them is a machine
    // knocking on a door nobody is answering.
    parked("signed out - waiting for a new sign-in");
    return;
  }

  // Does the inbox actually look different?
  //
  // The sockets carry presence and typing as well as messages, and the frames
  // are binary MQTT that this deliberately does not parse. What the open tab
  // can say for free - no request to Instagram at all - is what its own title
  // reads, which carries the unread count. If that has not moved since the
  // last look, the stir was somebody typing, and a look would find nothing.
  //
  // A gate, not a gospel: when the title says nothing useful the sync goes
  // ahead on the gap alone, which is the old behaviour with a longer floor.
  const mark = await inboxMark();
  if (mark !== null && mark === runtime.lastInboxMark) {
    console.log("[watcher] socket stirred but the inbox looks unchanged - not syncing");
    return;
  }
  runtime.lastInboxMark = mark;

  runtime.state.lastSyncAt = new Date().toISOString();
  runtime.state.syncsTriggered += 1;
  noteSyncForBudget();
  console.log("[watcher] activity on the inbox socket - syncing");
  startSync();
}

/**
 * The inbox tab's own title, which carries the unread count, or null when
 * there is no tab or it says nothing recognisable. Read from the page that is
 * already open: it costs Instagram nothing.
 */
async function inboxMark(): Promise<string | null> {
  const page = currentTab();
  if (!page || page.isClosed()) return null;
  try {
    const title = await page.title();
    return /\(\d+\)/.test(title) || /inbox|direct/i.test(title) ? title : null;
  } catch {
    return null;
  }
}

/**
 * How many inbox reads a day is too many.
 *
 * Twelve is generous for something whose job is to notice a handful of shared
 * reels: it is a look every eighty minutes across a waking day, where the
 * design intends a look when a message actually arrives and twice a day
 * otherwise. The number exists to be hit loudly rather than to be correct -
 * reaching it means something upstream is wrong.
 */
const MAX_SYNCS_PER_DAY = 12;
const looks: number[] = [];

function withinDailyBudget(): boolean {
  const dayAgo = Date.now() - 24 * 3600_000;
  while (looks.length && looks[0] < dayAgo) looks.shift();
  return looks.length < MAX_SYNCS_PER_DAY;
}

function noteSyncForBudget() {
  looks.push(Date.now());
}

/** Stopped on purpose, with nothing scheduled. A sign-in starts it again. */
function parked(reason: string) {
  runtime.state.listening = false;
  runtime.state.error = reason;
  if (runtime.reconnect) clearTimeout(runtime.reconnect);
  runtime.reconnect = null;
  console.log(`[watcher] parked (${reason})`);
}

/** A fault: wait longer each time, and never the same interval twice. */
function retryLater(reason: string, base = RETRY_MIN_MS) {
  const grown = Math.min(base * 2 ** runtime.failures, RETRY_MAX_MS);
  runtime.failures += 1;
  scheduleReconnect(reason, grown + between(0, grown / 2));
}

function scheduleReconnect(reason: string, delayMs: number) {
  runtime.state.listening = false;
  runtime.state.error = reason;
  console.warn(`[watcher] not listening (${reason}); retrying in ${Math.round(delayMs / 1000)}s`);
  if (runtime.reconnect) clearTimeout(runtime.reconnect);
  runtime.reconnect = setTimeout(() => {
    runtime.reconnect = null;
    if (runtime.wanted && !runtime.state.listening) void open();
  }, delayMs);
  runtime.reconnect.unref?.();
}

async function reload() {
  console.log("[watcher] reloading the inbox page (scheduled refresh)");
  try {
    await inboxTab({ refresh: true });
    runtime.failures = 0;
    scheduleRefresh();
  } catch (error) {
    await handleFailure(error);
  }
}

async function bedtime() {
  console.log("[watcher] bedtime - closing the inbox tab until morning");
  if (runtime.refresh) clearTimeout(runtime.refresh);
  runtime.refresh = null;
  await closeInboxTab();
  scheduleReconnect("night - the tab is closed until morning", msUntilAwake());
}

async function teardown() {
  if (runtime.debounce) clearTimeout(runtime.debounce);
  if (runtime.reconnect) clearTimeout(runtime.reconnect);
  if (runtime.refresh) clearTimeout(runtime.refresh);
  runtime.debounce = runtime.reconnect = runtime.refresh = null;

  runtime.unsubscribe?.();
  runtime.unsubscribe = null;

  await closeInboxTab();

  runtime.release?.();
  runtime.release = null;
}

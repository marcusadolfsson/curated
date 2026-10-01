import { eq, gte } from "drizzle-orm";
import { db } from "@/db";
import { syncRuns, threads } from "@/db/schema";
import { ApiUnavailableError, updates } from "@/lib/instagram/api";
import { RateLimitedError } from "@/lib/instagram/errors";
import { pauseAutomation, pauseState } from "@/lib/pause";
import { asBool, getSetting, setSettings } from "@/lib/settings";
import { getSyncState, startSync } from "@/lib/sync";
import type { WatcherState } from "@/lib/watcher";

/**
 * Noticing new messages through the API, instead of through a browser socket.
 *
 * The browser watcher listened to Instagram's realtime socket, which stirs for
 * presence, typing and keepalives as much as for messages, and could not tell
 * them apart - so it had to be throttled into a slow poller. The API polls the
 * inbox itself, on its own schedule, and keeps what it saw; this waits on that
 * cache with a long poll. A reply means a real message arrived, so a sync here
 * only ever runs because somebody sent something.
 *
 * Waiting on the cache is local - the request goes to the API on the far end
 * of the tunnel and no further - so reconnecting after an error is not a retry
 * against Instagram. What does reach Instagram is the sync it triggers.
 */

const WAIT_SECONDS = 45;
const RETRY_MIN_MS = 15_000;
const RETRY_MAX_MS = 5 * 60_000;
/**
 * A ceiling, not pacing. Syncs here follow real messages, and the API checks
 * the inbox every five minutes at most, so this is never reached by somebody
 * sharing reels. Reaching it means something is looping; counted from the
 * database so a restart cannot wipe the count the way it did for the browser
 * watcher's in-memory one.
 */
const MAX_SYNCS_PER_DAY = 60;

type Runtime = {
  state: WatcherState;
  loop: Promise<void> | null;
  wanted: boolean;
  failures: number;
  pendingSync: boolean;
  /** When each thread last had something new, by fbid - for the chat's cache. */
  lastEventByThread: Map<string, number>;
};

const globalForApiWatcher = globalThis as unknown as { __igApiWatcher?: Runtime };
const runtime: Runtime = (globalForApiWatcher.__igApiWatcher ??= {
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
  loop: null,
  wanted: false,
  failures: 0,
  pendingSync: false,
  lastEventByThread: new Map(),
});

export function getApiWatcherState(): WatcherState {
  return { ...runtime.state };
}

/** When a thread last had a new message, as far as the listener knows. */
export function lastEventFor(threadFbid: string | null | undefined): number | null {
  return threadFbid ? (runtime.lastEventByThread.get(threadFbid) ?? null) : null;
}

export async function startApiWatcher(): Promise<WatcherState> {
  // The same switch the browser watcher answers to.
  if (!asBool(await getSetting("realtime"))) {
    runtime.state.enabled = false;
    return getApiWatcherState();
  }
  runtime.wanted = true;
  runtime.state.enabled = true;
  runtime.loop ??= listen().finally(() => {
    runtime.loop = null;
  });
  return getApiWatcherState();
}

export async function stopApiWatcher(): Promise<WatcherState> {
  runtime.wanted = false;
  runtime.state.enabled = false;
  runtime.state.listening = false;
  runtime.state.since = null;
  runtime.state.sockets = 0;
  return getApiWatcherState();
}

async function listen() {
  let since = (await getSetting("apiUpdatesSince")).trim() || null;

  // First start, or the cursor was lost: there is no telling what was missed,
  // so one sync catches up - it reads each watched thread back to where it
  // last got to - and listening starts from now.
  if (!since) {
    since = new Date().toISOString();
    await setSettings({ apiUpdatesSince: since });
    requestSync("first start through the API");
  }

  while (runtime.wanted) {
    try {
      // The first ask returns at once, so "listening" means the API answered
      // rather than sitting false for the length of the first long poll.
      const batch = await updates(since, runtime.state.listening ? WAIT_SECONDS : 0);
      if (!runtime.wanted) break;

      if (!runtime.state.listening) {
        runtime.state.listening = true;
        runtime.state.since = new Date().toISOString();
        console.log(`[watcher] ${runtime.state.since} listening through the Instagram API`);
      }
      runtime.state.sockets = 1;
      runtime.state.error = null;
      runtime.failures = 0;

      if (batch.messages.length > 0) {
        const newest: string = batch.messages.reduce<string>(
          (latest, message) => (message.sent_at > latest ? message.sent_at : latest),
          since ?? "",
        );
        since = newest;
        await setSettings({ apiUpdatesSince: newest });

        const now = Date.now();
        runtime.state.lastEventAt = new Date(now).toISOString();
        runtime.state.eventsSeen += batch.messages.length;
        for (const message of batch.messages) runtime.lastEventByThread.set(message.thread_fbid, now);

        const watched = await watchedFbids();
        const relevant = batch.messages.filter((m) => watched.size === 0 || watched.has(m.thread_fbid));
        if (relevant.length > 0) {
          requestSync(`${relevant.length} new message${relevant.length === 1 ? "" : "s"}`);
        }
      }
    } catch (error) {
      if (!runtime.wanted) break;
      runtime.state.listening = false;
      runtime.state.sockets = 0;

      if (error instanceof RateLimitedError) {
        // The API saying stop is Instagram saying stop. Same as ever: stop
        // until a person looks, no retrying around it.
        runtime.state.error = error.message;
        await pauseAutomation("The Instagram API was rate-limited, so listening stopped.");
        runtime.wanted = false;
        runtime.state.enabled = false;
        break;
      }

      runtime.failures += 1;
      runtime.state.error =
        error instanceof ApiUnavailableError
          ? "The Instagram API is not answering. The tunnel from Muse may be down."
          : error instanceof Error
            ? error.message
            : String(error);
      const delay = Math.min(RETRY_MIN_MS * 2 ** (runtime.failures - 1), RETRY_MAX_MS);
      if (runtime.failures === 1 || runtime.failures % 10 === 0) {
        console.warn(`[watcher] ${new Date().toISOString()} ${runtime.state.error} (trying again in ${Math.round(delay / 1000)}s)`);
      }
      await sleep(delay);
    }
  }
}

/** Starts a sync now, or as soon as the running one finishes. */
function requestSync(reason: string) {
  if (runtime.pendingSync) return;
  runtime.pendingSync = true;
  void (async () => {
    try {
      while (getSyncState().running) await sleep(5_000);
      if (!runtime.wanted) return;

      const paused = await pauseState();
      if (paused.paused) {
        console.log(`[watcher] ${reason}, but automation is paused; leaving it`);
        return;
      }
      if (!(await withinDailyCeiling())) {
        console.warn(`[watcher] ${reason}, but ${MAX_SYNCS_PER_DAY} syncs ran in the last day; not syncing again until that drops`);
        runtime.state.error = `Daily ceiling of ${MAX_SYNCS_PER_DAY} syncs reached`;
        return;
      }

      runtime.state.lastSyncAt = new Date().toISOString();
      runtime.state.syncsTriggered += 1;
      console.log(`[watcher] ${runtime.state.lastSyncAt} ${reason} - syncing`);
      startSync();
    } finally {
      runtime.pendingSync = false;
    }
  })();
}

async function withinDailyCeiling(): Promise<boolean> {
  const dayAgo = new Date(Date.now() - 24 * 3600_000);
  const runs = await db.select({ id: syncRuns.id }).from(syncRuns).where(gte(syncRuns.startedAt, dayAgo));
  return runs.length < MAX_SYNCS_PER_DAY;
}

async function watchedFbids(): Promise<Set<string>> {
  const rows = await db
    .select({ fbid: threads.threadV2Id })
    .from(threads)
    .where(eq(threads.watch, true));
  return new Set(rows.map((row) => row.fbid).filter((fbid): fbid is string => Boolean(fbid)));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

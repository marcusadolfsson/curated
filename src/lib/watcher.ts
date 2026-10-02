import { eq, gte } from "drizzle-orm";
import { db } from "@/db";
import { posts, syncRuns, threads } from "@/db/schema";
import { ApiUnavailableError, outboundQueue, outstanding, updates, type QueueItem } from "@/lib/instagram/api";
import { RateLimitedError } from "@/lib/instagram/errors";
import { pauseAutomation, pauseState } from "@/lib/pause";
import { asBool, getSetting, setSettings } from "@/lib/settings";
import { getSyncState, startSync } from "@/lib/sync";

export type WatcherState = {
  /** Which way it listens. Always the API's update feed now; the menu bar reads it. */
  via?: "api";
  /**
   * Through the API: when the API last checked Instagram's inbox, which is
   * how fresh "nothing new" is. The listener itself never reaches Instagram.
   */
  upstreamCheckedAt?: string | null;
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

/**
 * Noticing new messages.
 *
 * When this app drove a browser it listened to Instagram's realtime
 * socket, which stirs for presence, typing and keepalives as much as for messages, and could not tell
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
 * database so a restart cannot wipe the count the way the old in-memory one
 * could.
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

const globalForWatcher = globalThis as unknown as { __igWatcher?: Runtime };
const runtime: Runtime = (globalForWatcher.__igWatcher ??= {
  state: {
    via: "api",
    upstreamCheckedAt: null,
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

export function getWatcherState(): WatcherState {
  return { ...runtime.state };
}

/** When a thread last had a new message, as far as the listener knows. */
export function lastEventFor(threadFbid: string | null | undefined): number | null {
  return threadFbid ? (runtime.lastEventByThread.get(threadFbid) ?? null) : null;
}

/** Start listening (idempotent). Safe to call on every boot. */
export async function startWatcher(): Promise<WatcherState> {
  // The "listen for new messages" setting; off, posts arrive by hand.
  if (!asBool(await getSetting("realtime"))) {
    runtime.state.enabled = false;
    return getWatcherState();
  }
  runtime.wanted = true;
  runtime.state.enabled = true;
  runtime.loop ??= listen().finally(() => {
    runtime.loop = null;
  });
  return getWatcherState();
}

export async function stopWatcher(): Promise<WatcherState> {
  runtime.wanted = false;
  runtime.state.enabled = false;
  runtime.state.listening = false;
  runtime.state.since = null;
  runtime.state.sockets = 0;
  return getWatcherState();
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
      runtime.state.upstreamCheckedAt = batch.checkedAt ?? runtime.state.upstreamCheckedAt ?? null;
      runtime.state.error = null;
      runtime.failures = 0;

      await reconcileQueue();

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

const QUEUE_CHECK_MS = 30_000;
const QUEUE_STALE_MS = 10 * 60_000;
let lastQueueCheck = 0;

/**
 * Finds out what became of reactions and messages this app queued.
 *
 * A queued reaction is recorded as sent the moment the queue takes it, so the
 * post shows it at once. If Muse's sender later fails it, the record is taken
 * back off the post and the error put in its place. Items still waiting after
 * ten minutes mean the sender is not running - on Muse it is a scheduled task
 * that has to be enabled - and the menu says so rather than leaving it silent.
 * Only asks while something of ours is outstanding; the queue is local to the
 * API and never reaches Instagram.
 */
async function reconcileQueue() {
  if (outstanding.size === 0 || Date.now() - lastQueueCheck < QUEUE_CHECK_MS) return;
  lastQueueCheck = Date.now();

  let items: QueueItem[];
  try {
    items = await outboundQueue();
  } catch {
    return; // asked again on the next pass
  }
  const byId = new Map(items.map((item) => [item.id, item]));

  let waiting = 0;
  for (const [id, queuedAt] of outstanding) {
    const item = byId.get(id);
    if (!item || item.status === "sent") {
      outstanding.delete(id);
      continue;
    }
    if (item.status === "failed") {
      outstanding.delete(id);
      const why = `Muse could not send it: ${item.error ?? "no reason given"}`;
      console.warn(`[queue] ${item.type} ${id} failed - ${why}`);
      if (item.type === "react" && item.message_id) {
        await db
          .update(posts)
          .set({ reactedAt: null, reactionEmoji: null, reactionError: why.slice(0, 500) })
          .where(eq(posts.messageId, item.message_id));
      }
      continue;
    }
    if (Date.now() - queuedAt > QUEUE_STALE_MS) waiting += 1;
  }

  if (waiting > 0) {
    runtime.state.error =
      `${waiting} reaction${waiting === 1 ? "" : "s"} or message${waiting === 1 ? "" : "s"} waiting in Muse's send ` +
      "queue for over ten minutes. Is the outbound-queue-sender task enabled on Muse?";
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

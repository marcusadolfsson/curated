import { analysisAvailable } from "@/lib/claude-auth";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { posts, syncRuns, threads, type Post } from "@/db/schema";
import {
  RateLimitedError,
  SessionExpiredError,
  getSessionStatus,
  isSessionKnownDead,
} from "@/lib/instagram/client";
import { pauseAutomation, pauseState } from "@/lib/pause";
import {
  collectSharedPosts,
  fetchInbox,
  fetchThread,
  mediaIdFromShortcode,
  oldestMessageAt,
  type DmUser,
  type Json,
} from "@/lib/instagram/dm";
import { fetchVideo, videoIsCached } from "@/lib/instagram/gallery";
import { downloadThumbnail } from "@/lib/instagram/media";
import { fetchPostPreview } from "@/lib/instagram/preview";
import { analyzeAndStore, analysisConcurrency } from "@/lib/analyze";
import { pause } from "@/lib/pace";
import { asBool, asInt, getSettings } from "@/lib/settings";
import { queueReactions } from "@/lib/reactions";

export type SyncPhase =
  | "idle"
  | "connecting"
  | "inbox"
  | "reading"
  | "analyzing"
  | "reacting"
  | "done"
  | "error";

export type SyncState = {
  running: boolean;
  phase: SyncPhase;
  message: string;
  runId: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  threadsScanned: number;
  threadsTotal: number;
  itemsScanned: number;
  postsAdded: number;
  postsAnalyzed: number;
  analysisTotal: number;
  /** Reactions sent so far from the queue this run filled. */
  reactionsSent: number;
  /** Reactions this run queued for the coming minutes. */
  reactionsTotal: number;
  error: string | null;
};

const idleState = (): SyncState => ({
  running: false,
  phase: "idle",
  message: "",
  runId: null,
  startedAt: null,
  finishedAt: null,
  threadsScanned: 0,
  threadsTotal: 0,
  itemsScanned: 0,
  postsAdded: 0,
  postsAnalyzed: 0,
  analysisTotal: 0,
  reactionsSent: 0,
  reactionsTotal: 0,
  error: null,
});

const globalForSync = globalThis as unknown as { __syncState?: SyncState };
const state: SyncState = (globalForSync.__syncState ??= idleState());

export function getSyncState(): SyncState {
  return { ...state };
}

/** Kicks off a sync and returns immediately; poll `getSyncState()` for progress. */
export function startSync(): SyncState {
  if (state.running) return getSyncState();

  Object.assign(state, idleState(), {
    running: true,
    phase: "connecting" as SyncPhase,
    message: "Opening Instagram",
    startedAt: new Date().toISOString(),
  });

  void runSync().catch(async (error) => {
    // Instagram pushing back stops the automation rather than retrying it.
    if (error instanceof RateLimitedError) {
      await pauseAutomation(
        "Instagram rate-limited this host, so syncing stopped rather than pressing on.",
      );
    }
    finish("error", error instanceof Error ? error.message : String(error));
  });

  return getSyncState();
}

async function runSync() {
  const paused = await pauseState();
  if (paused.paused) {
    return finish(
      "error",
      `Paused until ${new Date(paused.until as string).toLocaleString()}. ${paused.reason ?? ""}`.trim(),
    );
  }

  const settings = await getSettings();

  const [run] = await db.insert(syncRuns).values({ startedAt: new Date() }).returning();
  state.runId = run.id;

  // A post left "running" by a restart is never retried, because the retry set
  // is pending/error. Nothing else analyses while a sync starts, so anything
  // still marked running here is a leftover.
  const revived = await db
    .update(posts)
    .set({ analysisStatus: "pending" })
    .where(eq(posts.analysisStatus, "running"))
    .returning({ id: posts.id });
  if (revived.length > 0) {
    console.log(`[sync] released ${revived.length} post(s) stuck mid-analysis`);
  }

  if (isSessionKnownDead()) {
    return finish("error", "Signed out. Paste a new session cookie on the setup page.");
  }

  // Opens the inbox tab if it is not already open; that load is the check.
  const session = await getSessionStatus({ verify: true });
  if (!session.connected) {
    return finish("error", session.message ?? "Not connected to Instagram. Sign in first.");
  }

  // 1. Refresh the thread list, keeping whatever is already marked as watched.
  state.phase = "inbox";
  state.message = "Reading the inbox";

  const inbox = await fetchInbox(asInt(settings.inboxLimit, 20));
  for (const thread of inbox) {
    await db
      .insert(threads)
      .values({
        threadId: thread.threadId,
        threadV2Id: thread.threadV2Id,
        title: thread.title,
        participants: JSON.stringify(thread.users.map((u) => u.username)),
        lastItemAt: thread.lastActivityAt,
      })
      .onConflictDoUpdate({
        target: threads.threadId,
        set: {
          threadV2Id: thread.threadV2Id,
          title: thread.title,
          participants: JSON.stringify(thread.users.map((u) => u.username)),
          lastItemAt: thread.lastActivityAt,
        },
      });
  }

  // 2. Decide which threads to read. With nothing watched, read everything -
  //    that is how you find the thread worth watching in the first place.
  const watched = await db.select().from(threads).where(eq(threads.watch, true));
  const targetIds = watched.length > 0
    ? watched.map((t) => t.threadId)
    : inbox.map((t) => t.threadId);

  state.threadsTotal = targetIds.length;
  state.phase = "reading";

  const historyDays = Math.max(1, asInt(settings.historyDays, 7));
  const titles = new Map(inbox.map((t) => [t.threadId, t.title]));
  const watchedById = new Map(watched.map((t) => [t.threadId, t]));
  const added: number[] = [];

  for (const [index, threadId] of targetIds.entries()) {
    // Opening the inbox, then a conversation, then another: not instantaneous.
    await pause(index === 0 ? 1_500 : 2_500, index === 0 ? 4_000 : 7_000);
    state.message = `Reading ${titles.get(threadId) ?? "thread"}`;
    try {
      // Everything since the last time this conversation was read - which is
      // the whole point: an outage of three days is caught up in one go. A
      // conversation never read before gets the configured span of history.
      const lastRead = watchedById.get(threadId)?.lastSyncedAt ?? null;
      const since = lastRead
        ? new Date(lastRead.getTime() - OVERLAP_MS)
        : new Date(Date.now() - historyDays * 86_400_000);

      const { items, users, threadV2Id, reachedTarget } = await readThread(threadId, since);
      if (threadV2Id) {
        await db.update(threads).set({ threadV2Id }).where(eq(threads.threadId, threadId));
      }
      const usernameById = new Map(users.map((user) => [user.id, user.username]));
      state.itemsScanned += items.length;

      let foundInThread = 0;
      for (const shared of collectSharedPosts(items)) {
        const existing = await db
          .select({ id: posts.id, messageId: posts.messageId })
          .from(posts)
          .where(eq(posts.shortcode, shared.shortcode))
          .limit(1);

        if (existing.length > 0) {
          // Posts imported before reactions existed have no message id, and
          // without one they cannot be reacted to.
          if (!existing[0].messageId && shared.messageId) {
            await db
              .update(posts)
              .set({ messageId: shared.messageId })
              .where(eq(posts.id, existing[0].id));
          }
          continue;
        }

        if (foundInThread > 0) await pause(800, 3_000);

        // A pasted link arrives with nothing attached; the media endpoint fills
        // in the thumbnail and caption the model needs.
        const preview =
          shared.thumbnailUrl === null ? await fetchPostPreview(shared.shortcode, shared.mediaId) : null;

        const thumbnailUrl = shared.thumbnailUrl ?? preview?.imageUrl ?? null;
        const thumbnailFile = await downloadThumbnail(shared.shortcode, thumbnailUrl).catch(
          () => null,
        );

        const [inserted] = await db
          .insert(posts)
          .values({
            shortcode: shared.shortcode,
            permalink: shared.permalink,
            mediaType: shared.mediaType,
            mediaId: shared.mediaId ?? preview?.mediaId ?? null,
            caption: shared.caption ?? preview?.caption ?? null,
            authorUsername: shared.authorUsername ?? preview?.authorUsername ?? null,
            messageText: shared.messageText,
            thumbnailUrl,
            thumbnailFile,
            threadId,
            itemId: shared.itemId,
            messageId: shared.messageId,
            senderId: shared.senderId,
            senderUsername:
              (shared.senderId ? usernameById.get(shared.senderId) : null) ??
              titles.get(threadId) ??
              null,
            sharedAt: shared.sharedAt,
          })
          .returning({ id: posts.id });

        added.push(inserted.id);
        state.postsAdded += 1;
        foundInThread += 1;
      }

      // Only claim to have read up to now if it actually got all the way
      // back. Otherwise the next sync starts from the same place and finishes
      // the job, rather than leaving a hole nothing ever returns to.
      await db
        .update(threads)
        .set(
          reachedTarget
            ? { lastSyncedAt: new Date(), postsFound: foundInThread }
            : { postsFound: foundInThread },
        )
        .where(eq(threads.threadId, threadId));
      if (!reachedTarget) {
        console.warn(`[sync] ${threadId}: stopped short of ${since.toISOString()}; will resume next time`);
      }
    } catch (error) {
      if (error instanceof SessionExpiredError || error instanceof RateLimitedError) throw error;
      console.error(`[sync] thread ${threadId} failed:`, error);
    }

    state.threadsScanned += 1;
  }

  // 3. Fetch the reels that just arrived. Someone who is sent a reel watches
  //    it, so the CDN sees the same fetch either way; doing it now means the
  //    modal opens on a local file instead of waiting for a download.
  if (added.length > 0) await prefetchVideos(added);

  // 4. Describe everything that has not been described yet.
  if (asBool(settings.autoAnalyze) && analysisAvailable()) {
    const pending = await db
      .select()
      .from(posts)
      .where(inArray(posts.analysisStatus, ["pending", "error"]));

    state.phase = "analyzing";
    state.analysisTotal = pending.length;
    await analyzeAll(pending, () => {
      state.postsAnalyzed += 1;
      state.message = `Describing posts (${state.postsAnalyzed} of ${state.analysisTotal})`;
    });
  }

  // 5. Let the sender know it landed - later, one at a time, and only for what
  //    arrived in this sync. Nothing is ever caught up on.
  if (asBool(settings.autoReact) && added.length > 0) {
    state.phase = "reacting";
    state.reactionsTotal = queueReactions(added, settings.reactionEmoji, () => {
      state.reactionsSent += 1;
    });
  }

  finish("done", null);
}

async function prefetchVideos(postIds: number[]) {
  const reels = (await db.select().from(posts).where(inArray(posts.id, postIds))).filter(
    (post) => (post.mediaType === "reel" || post.mediaType === "tv") && !videoIsCached(post.videoFile),
  );

  for (const [index, post] of reels.entries()) {
    const mediaId = post.mediaId ?? mediaIdFromShortcode(post.shortcode);
    if (!mediaId) continue;
    if (index > 0) await pause(2_000, 6_000);
    state.message = `Fetching the reel (${index + 1} of ${reels.length})`;
    try {
      const video = await fetchVideo(post.shortcode, mediaId);
      if (video) await db.update(posts).set({ videoFile: video.file }).where(eq(posts.id, post.id));
    } catch (error) {
      if (error instanceof SessionExpiredError || error instanceof RateLimitedError) throw error;
      console.error(`[sync] could not fetch the reel for ${post.shortcode}:`, error);
    }
  }
}

/** A little either side of the last read, so nothing falls between two syncs. */
const OVERLAP_MS = 60 * 60_000;
/**
 * A ceiling on one sitting. Reaching it is not a failure - the thread simply
 * keeps its old high-water mark and the next sync carries on from there, which
 * turns a very deep catch-up into several ordinary-looking ones rather than
 * one long march through someone's history.
 */
const MAX_PAGES = 40;

/**
 * A thread read backwards until it reaches a point in time.
 *
 * It used to stop after a fixed number of messages, which meant a backlog
 * bigger than that was lost for good: the next sync saw the newest page, found
 * it all familiar, and stopped - never going back for the rest. Reading to a
 * timestamp instead is what makes an outage recoverable, however long it was.
 */
async function readThread(
  threadId: string,
  since: Date,
): Promise<{ items: Json[]; users: DmUser[]; threadV2Id: string | null; reachedTarget: boolean }> {
  const items: Json[] = [];
  let users: DmUser[] = [];
  let threadV2Id: string | null = null;
  let cursor: string | null = null;
  let reachedTarget = false;

  for (let page = 1; page <= MAX_PAGES; page++) {
    if (page > 1) await pause(1_500, 4_500);

    const result = await fetchThread(threadId, cursor);
    items.push(...result.items);
    if (result.users.length > 0) users = result.users;
    threadV2Id ??= result.threadV2Id;

    const oldest = oldestMessageAt(result.items);
    const fresh = new Set(collectSharedPosts(result.items).map((post) => post.shortcode)).size;
    console.log(
      `[sync] ${threadId}: page ${page}, ${result.items.length} messages back to ${oldest?.toISOString() ?? "?"}, ${fresh} share(s)`,
    );

    // The start of the conversation, or far enough back to have met the last
    // sync. Either way there is nothing behind this worth asking for.
    if (!result.hasOlder || !result.oldestCursor) {
      reachedTarget = true;
      break;
    }
    if (oldest && oldest <= since) {
      reachedTarget = true;
      break;
    }

    cursor = result.oldestCursor;
  }

  return { items, users, threadV2Id, reachedTarget };
}

/** Runs analyses a few at a time so a large backlog does not spawn dozens of agents. */
export async function analyzeAll(pending: Post[], onDone: () => void) {
  const queue = [...pending];
  const workers = Array.from({ length: Math.min(analysisConcurrency(), queue.length || 1) }, () =>
    (async () => {
      for (;;) {
        const post = queue.shift();
        if (!post) return;
        await analyzeAndStore(post);
        onDone();
      }
    })(),
  );
  await Promise.all(workers);
}

function finish(phase: "done" | "error", error: string | null) {
  state.running = false;
  state.phase = phase;
  state.error = error;
  state.finishedAt = new Date().toISOString();
  state.message =
    phase === "done"
      ? state.postsAdded > 0
        ? `Added ${state.postsAdded} post${state.postsAdded === 1 ? "" : "s"}` +
          (state.reactionsTotal > 0 ? `, ${state.reactionsTotal} reaction${state.reactionsTotal === 1 ? "" : "s"} queued` : "")
        : "Nothing new"
      : (error ?? "Sync failed");

  if (state.runId !== null) {
    void db
      .update(syncRuns)
      .set({
        finishedAt: new Date(),
        status: phase,
        threadsScanned: state.threadsScanned,
        itemsScanned: state.itemsScanned,
        postsAdded: state.postsAdded,
        postsAnalyzed: state.postsAnalyzed,
        error,
      })
      .where(eq(syncRuns.id, state.runId))
      .catch(() => undefined);
  }
}

export async function lastRun() {
  const rows = await db.select().from(syncRuns).orderBy(desc(syncRuns.startedAt)).limit(1);
  return rows[0] ?? null;
}

export async function watchedThreadCount() {
  const rows = await db
    .select({ id: threads.threadId })
    .from(threads)
    .where(and(eq(threads.watch, true)));
  return rows.length;
}

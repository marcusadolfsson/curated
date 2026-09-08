import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { posts, threads } from "@/db/schema";
import { RateLimitedError, SessionExpiredError } from "@/lib/instagram/client";
import { collectSharedPosts, fetchThread } from "@/lib/instagram/dm";
import { downloadThumbnail } from "@/lib/instagram/media";
import { fetchPostPreview } from "@/lib/instagram/preview";
import { isAwake } from "@/lib/hours";
import { pause } from "@/lib/pace";
import { pauseAutomation, pauseState } from "@/lib/pause";

/**
 * Reading further back than a sync does.
 *
 * A sync looks at the last page of a conversation, which is all you need to
 * keep up. Going back a year means paging: the thread endpoint hands back a
 * cursor with each page, and following it walks backwards through the
 * conversation.
 *
 * Deliberately imports without describing. Describing is the expensive part -
 * seconds and cents per post - and a year of someone who shares daily is
 * hundreds of them. They land as pending, and you decide what to do about that.
 */

export type BackfillState = {
  running: boolean;
  threadTitle: string | null;
  pages: number;
  itemsScanned: number;
  postsAdded: number;
  duplicates: number;
  notesAdded: number;
  reachedBack: string | null;
  finished: boolean;
  stoppedBecause: string | null;
  error: string | null;
};

const idle = (): BackfillState => ({
  running: false,
  threadTitle: null,
  pages: 0,
  itemsScanned: 0,
  postsAdded: 0,
  duplicates: 0,
  notesAdded: 0,
  reachedBack: null,
  finished: false,
  stoppedBecause: null,
  error: null,
});

const globalForBackfill = globalThis as unknown as { __backfill?: BackfillState };
const state: BackfillState = (globalForBackfill.__backfill ??= idle());

export function getBackfillState(): BackfillState {
  return { ...state };
}

export function startBackfill(threadId: string, days: number): BackfillState {
  if (state.running) return getBackfillState();

  Object.assign(state, idle(), { running: true });
  void run(threadId, days).catch((error) => {
    state.error = error instanceof Error ? error.message : String(error);
    state.running = false;
    state.finished = true;
  });

  return getBackfillState();
}

async function run(threadId: string, days: number) {
  const paused = await pauseState();
  if (paused.paused) {
    state.error = `Paused until ${new Date(paused.until as string).toLocaleString()}.`;
    state.running = false;
    return;
  }

  // An hour of steady paging through DMs is the least human thing this app
  // does. It is at least going to happen at an hour its owner could be awake.
  if (!isAwake()) {
    state.error = "Not between 7am and 11pm. A long read of the history waits for the morning.";
    state.running = false;
    state.finished = true;
    return;
  }

  const [thread] = await db
    .select()
    .from(threads)
    .where(eq(threads.threadId, threadId))
    .limit(1);
  state.threadTitle = thread?.title ?? threadId;

  const until = new Date(Date.now() - days * 86_400_000);
  let cursor: string | null = null;

  try {
    // A page is 20 messages, the size the web client scrolls by; a year of a
    // busy conversation is a couple of hundred of them. Paced unevenly,
    // because this is a lot of requests in a row and Instagram has locked
    // this account once already.
    for (let page = 1; page <= 800; page++) {
      if (page > 1) await pause(2_000, 6_500);

      // It can run for the best part of an hour; if that reaches bedtime it
      // stops where it is rather than paging on into the night.
      if (!isAwake()) {
        state.stoppedBecause = "reached the end of the day - start it again tomorrow";
        break;
      }
      const { items, users, threadV2Id, oldestCursor, hasOlder } = await fetchThread(threadId, cursor);

      if (page === 1 && threadV2Id) {
        await db.update(threads).set({ threadV2Id }).where(eq(threads.threadId, threadId));
      }

      state.pages = page;
      state.itemsScanned += items.length;

      const usernameById = new Map(users.map((user) => [user.id, user.username]));
      let oldestSeen: Date | null = null;

      for (const shared of collectSharedPosts(items)) {
        {
          if (shared.sharedAt && (!oldestSeen || shared.sharedAt < oldestSeen)) {
            oldestSeen = shared.sharedAt;
          }

          const existing = await db
            .select({ id: posts.id, messageId: posts.messageId, messageText: posts.messageText })
            .from(posts)
            .where(eq(posts.shortcode, shared.shortcode))
            .limit(1);

          if (existing.length > 0) {
            state.duplicates += 1;

            // Her commentary was being dropped until now, so a second pass over
            // a thread is worth something: fill in what is missing without
            // touching what is already there.
            const fill: Partial<typeof posts.$inferInsert> = {};
            if (!existing[0].messageId && shared.messageId) fill.messageId = shared.messageId;
            if (!existing[0].messageText && shared.messageText) fill.messageText = shared.messageText;

            if (Object.keys(fill).length > 0) {
              await db.update(posts).set(fill).where(eq(posts.id, existing[0].id));
              if (fill.messageText) state.notesAdded += 1;
            }
            continue;
          }

          const preview =
            shared.thumbnailUrl === null ? await fetchPostPreview(shared.shortcode, shared.mediaId) : null;
          const thumbnailUrl = shared.thumbnailUrl ?? preview?.imageUrl ?? null;
          const thumbnailFile = await downloadThumbnail(shared.shortcode, thumbnailUrl).catch(
            () => null,
          );

          await db.insert(posts).values({
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
              thread?.title ??
              null,
            sharedAt: shared.sharedAt,
          });

          state.postsAdded += 1;
        }
      }

      // The timestamp of the last message on the page, which is how far back
      // this has actually reached.
      const last = items.at(-1);
      const pageOldest = microseconds(last?.timestamp) ?? oldestSeen;
      if (pageOldest) state.reachedBack = pageOldest.toISOString();

      if (!hasOlder || !oldestCursor) {
        state.stoppedBecause = "reached the start of the conversation";
        break;
      }
      if (pageOldest && pageOldest < until) {
        state.stoppedBecause = `reached ${days} days back`;
        break;
      }

      cursor = oldestCursor;
    }

    state.stoppedBecause ??= "hit the page limit";
  } catch (error) {
    if (error instanceof RateLimitedError) {
      await pauseAutomation("Instagram rate-limited this host during a backfill.");
    }
    state.error =
      error instanceof SessionExpiredError
        ? "Instagram signed this session out."
        : error instanceof Error
          ? error.message
          : String(error);
  } finally {
    state.running = false;
    state.finished = true;
  }
}

function microseconds(value: unknown): Date | null {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return new Date(Math.round(numeric / 1000));
}

export async function watchedThreads() {
  return db.select().from(threads).where(and(eq(threads.watch, true)));
}

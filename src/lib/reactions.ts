import { eq } from "drizzle-orm";
import { db } from "@/db";
import { posts, threads, type Post } from "@/db/schema";
import { sendReaction, type ReactionOutcome } from "@/lib/instagram/react";
import { isReactionEmoji } from "@/lib/emoji";
import { chooseReaction } from "@/lib/analyze";
import { AWAKE_FROM, AWAKE_UNTIL, isAwake } from "@/lib/hours";
import { between } from "@/lib/pace";
import { pauseState } from "@/lib/pause";

/**
 * Reacts to the DM the post arrived in, and records what happened.
 *
 * `emoji` is the fallback. What actually gets sent is the emoji the model chose
 * while reading the post, because a heart on all of it reads as automation -
 * the specific one is the whole signal that somebody looked.
 */
export async function reactToPost(post: Post, fallbackEmoji: string): Promise<ReactionOutcome> {
  let emoji = isReactionEmoji(post.suggestedReaction) ? (post.suggestedReaction as string) : null;

  // Posts described before the model was asked for an emoji have none stored.
  if (!emoji) {
    const chosen = await chooseReaction(post);
    if (chosen && isReactionEmoji(chosen)) {
      emoji = chosen;
      await db.update(posts).set({ suggestedReaction: chosen }).where(eq(posts.id, post.id));
    }
  }

  emoji = emoji ?? fallbackEmoji;

  if (!post.messageId) {
    return await record(post, { ok: false, error: "No message id was captured for this post." }, emoji);
  }
  if (!post.threadId) {
    return await record(post, { ok: false, error: "No thread recorded for this post." }, emoji);
  }

  const [thread] = await db
    .select()
    .from(threads)
    .where(eq(threads.threadId, post.threadId))
    .limit(1);

  if (!thread?.threadV2Id) {
    return await record(
      post,
      { ok: false, error: "This thread has no v2 id yet - sync once more to pick it up." },
      emoji,
    );
  }

  const outcome = await sendReaction({
    threadV2Id: thread.threadV2Id,
    messageId: post.messageId,
    emoji,
  });

  return await record(post, outcome, emoji);
}

/** Takes a reaction back off the message. */
export async function unreactToPost(post: Post): Promise<ReactionOutcome> {
  if (!post.messageId || !post.threadId) {
    return { ok: false, error: "Nothing recorded for this post to remove a reaction from." };
  }

  const [thread] = await db
    .select()
    .from(threads)
    .where(eq(threads.threadId, post.threadId))
    .limit(1);

  if (!thread?.threadV2Id) {
    return { ok: false, error: "This thread has no v2 id." };
  }

  const outcome = await sendReaction({
    threadV2Id: thread.threadV2Id,
    messageId: post.messageId,
    emoji: post.reactionEmoji ?? post.suggestedReaction ?? "❤️",
    remove: true,
  });

  if (outcome.ok) {
    await db
      .update(posts)
      .set({ reactedAt: null, reactionEmoji: null, reactionError: null })
      .where(eq(posts.id, post.id));
  }

  return outcome;
}

async function record(post: Post, outcome: ReactionOutcome, emoji: string): Promise<ReactionOutcome> {
  await db
    .update(posts)
    .set(
      outcome.ok
        ? { reactedAt: new Date(), reactionEmoji: emoji, reactionError: null }
        : { reactionError: outcome.error.slice(0, 500) },
    )
    .where(eq(posts.id, post.id));

  return outcome;
}

/**
 * Automatic reactions, one at a time, when a person would.
 *
 * The version of this that got the account warned reacted to forty posts ten
 * seconds apart. Nobody does that. Someone who has just seen a new post reacts
 * to it a few minutes later - or, if it came in at night, in the morning - and
 * two posts that arrived together get two separate reactions, minutes apart.
 * Only posts that arrived in the last day qualify: reacting to last month's
 * post is a bot catching up, and the sender would notice.
 *
 * In-process only. A restart drops the queue; a dropped reaction is nothing.
 */

const DELAY_MIN_MS = 60_000;
const DELAY_MAX_MS = 15 * 60_000;
const FRESH_MS = 24 * 3600_000;

type Queue = { lastAt: number; pending: Map<number, NodeJS.Timeout> };
const globalForQueue = globalThis as unknown as { __reactionQueue?: Queue };
const queue: Queue = (globalForQueue.__reactionQueue ??= { lastAt: 0, pending: new Map() });

export function queueReactions(
  postIds: number[],
  fallbackEmoji: string,
  onSent?: () => void,
): number {
  let queued = 0;
  for (const id of postIds) {
    if (queue.pending.has(id)) continue;

    // Each one lands after the last, by a fresh random interval.
    let at = Math.max(Date.now(), queue.lastAt) + between(DELAY_MIN_MS, DELAY_MAX_MS);
    at = duringTheDay(at);
    queue.lastAt = at;

    const timer = setTimeout(() => {
      queue.pending.delete(id);
      void fire(id, fallbackEmoji, onSent).catch((error) =>
        console.error(`[reactions] queued reaction for post ${id} failed:`, error),
      );
    }, at - Date.now());
    timer.unref?.();
    queue.pending.set(id, timer);
    queued += 1;
  }
  return queued;
}

export function reactionQueueSize(): number {
  return queue.pending.size;
}

async function fire(id: number, fallbackEmoji: string, onSent?: () => void) {
  const [post] = await db.select().from(posts).where(eq(posts.id, id)).limit(1);
  if (!post || post.reactedAt) return;
  if (!post.sharedAt || Date.now() - post.sharedAt.getTime() > FRESH_MS) return;
  if ((await pauseState()).paused) return;

  const outcome = await reactToPost(post, fallbackEmoji);
  if (outcome.ok) onSent?.();
}

/** A reaction that would land at night waits for the morning, at no particular minute. */
function duringTheDay(at: number): number {
  const when = new Date(at);
  if (isAwake(when)) return at;

  const morning = new Date(when);
  if (when.getHours() >= AWAKE_UNTIL) morning.setDate(morning.getDate() + 1);
  morning.setHours(AWAKE_FROM, 0, 0, 0);
  return morning.getTime() + between(0, 60 * 60_000);
}

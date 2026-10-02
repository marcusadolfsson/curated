import * as api from "./api";

/**
 * Reacting to a shared post, so the sender can see it landed.
 *
 * Through the API's outbound queue rather than its direct endpoint: a direct
 * reaction asks for approval on Muse's side every time, while the queue is
 * drained by a scheduled task there that carries one standing approval. The
 * queue answers at once; whether the reaction was created is learned from
 * /dms/queue afterwards, and a failure is put back onto the post by the
 * watcher. A message is addressed by its `mid.$...` id and the thread by the
 * id stored as threadV2Id, which is the API's thread_fbid.
 *
 * The emoji goes as Curated stores it; the queue accepts the same nine.
 */

export type ReactionOutcome = { ok: true } | { ok: false; error: string };

export async function sendReaction(options: {
  threadV2Id: string;
  messageId: string;
  emoji: string;
  remove?: boolean;
}): Promise<ReactionOutcome> {
  const { threadV2Id, messageId, emoji, remove = false } = options;

  if (!threadV2Id || !messageId) {
    return { ok: false, error: "Missing the thread or message id this reaction needs." };
  }
  // The API sends a reaction; it has no way to take one back.
  if (remove) return { ok: false, error: "Removing a reaction is not possible through the Instagram API." };

  const outcome = await api.queueReaction({ threadFbid: threadV2Id, messageId, emoji });
  if (!outcome.ok) return outcome;
  console.log(`[reactions] queued ${emoji} for ${messageId} (queue item ${outcome.queueId})`);
  return { ok: true };
}

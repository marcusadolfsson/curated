import * as api from "./api";

/**
 * Replying to a shared post in the thread, or saying something in it.
 *
 * Through the API's outbound queue, for the same reason reactions go that
 * way: a direct send asks for approval on Muse's side every time. The queue
 * passes `reply_to_message_id` through, so a reply quotes the post it is
 * about. The thread is addressed by the id stored as threadV2Id, which is the
 * API's thread_fbid.
 */

export type ReplyOutcome =
  | { ok: true; messageId: string | null }
  | { ok: false; error: string };

export async function sendTextReply(options: {
  threadV2Id: string;
  text: string;
  /** The `mid.$...` of the message being replied to. Absent for plain talk. */
  replyToMessageId?: string | null;
}): Promise<ReplyOutcome> {
  const { threadV2Id, text, replyToMessageId = null } = options;

  if (!threadV2Id) return { ok: false, error: "Missing the thread this message needs." };
  if (!text.trim()) return { ok: false, error: "Nothing to send." };

  const outcome = await api.queueMessage({ threadFbid: threadV2Id, text: text.trim(), replyToMessageId });
  if (outcome.ok) console.log(`[reply] queued for ${replyToMessageId ?? "the thread"}`);
  return outcome;
}

/** A message in the conversation, about nothing in particular. */
export function sendMessage(options: { threadV2Id: string; text: string }): Promise<ReplyOutcome> {
  return sendTextReply(options);
}

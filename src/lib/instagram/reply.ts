import {
  graphqlPage,
  looksStale,
  offlineThreadingId,
  parseGraphql,
  postGraphql,
} from "./graphql";

/**
 * Replying to a shared post in the thread - a text message that quotes the
 * share, the way tapping "reply" on it does.
 *
 * IGDirectTextSendMutation, read out of Instagram's bundle. Two details that
 * would not have been guessed: the text travels as {sensitive_string_value},
 * not a string, and the thread is addressed by ig_thread_igid, which is the
 * thread_v2_id the reaction mutation also uses.
 */

const TEXT_DOC_ID = "26911679871773184";
const FRIENDLY_NAME = "IGDirectTextSendMutation";

export type ReplyOutcome =
  | { ok: true; messageId: string | null }
  | { ok: false; error: string };

export async function sendTextReply(options: {
  threadV2Id: string;
  text: string;
  /** The `mid.$...` of the message being replied to. Absent for plain talk. */
  replyToMessageId?: string | null;
  /** Its item_id from the DM API, when known. */
  replyToItemId?: string | null;
}): Promise<ReplyOutcome> {
  const { threadV2Id, text, replyToMessageId = null, replyToItemId = null } = options;

  if (!threadV2Id) {
    return { ok: false, error: "Missing the thread this message needs." };
  }
  if (!text.trim()) return { ok: false, error: "Nothing to send." };

  const call = {
    docId: TEXT_DOC_ID,
    friendlyName: FRIENDLY_NAME,
    variables: {
      commands: null,
      forwarded_from_thread_id: null,
      ig_thread_igid: threadV2Id,
      is_forwarded_from_own_message: null,
      mentioned_user_ids: [],
      mentions: [],
      offline_threading_id: offlineThreadingId(),
      recipient_igids: null,
      replied_to_client_context: null,
      replied_to_item_id: replyToItemId,
      reply_to_message_id: replyToMessageId,
      send_attribution: "thread_view",
      text: { sensitive_string_value: text.trim() },
    },
  };

  try {
    let body = await postGraphql(await graphqlPage(), call);
    if (looksStale(body)) {
      console.warn("[reply] retrying on a fresh page");
      body = await postGraphql(await graphqlPage(true), call);
    }

    const parsed = parseGraphql(body);
    if (!parsed) return { ok: false, error: `Unreadable reply: ${body.slice(0, 200)}` };
    if (parsed.errors?.length) {
      return { ok: false, error: parsed.errors.map((e) => e.message ?? "error").join("; ").slice(0, 300) };
    }

    // Success is a message id coming back, nothing less.
    const payload = parsed.data?.xig_direct_text_send_with_slide_messaging_response as
      | { message_id?: string; id?: string; timestamp_ms?: string }
      | null
      | undefined;
    if (!payload?.message_id && !payload?.id) {
      console.warn(`[reply] mutation returned no message: ${body.slice(0, 600)}`);
      return {
        ok: false,
        error: `Instagram accepted the request but reported no message: ${body.slice(0, 200)}`,
      };
    }

    console.log(`[reply] sent to ${replyToMessageId ?? "the thread"}: ${JSON.stringify(payload).slice(0, 300)}`);
    return { ok: true, messageId: payload.message_id ?? payload.id ?? null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** A message in the conversation, about nothing in particular. */
export function sendMessage(options: { threadV2Id: string; text: string }): Promise<ReplyOutcome> {
  return sendTextReply(options);
}

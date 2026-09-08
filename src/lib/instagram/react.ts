import {
  graphqlPage,
  looksStale,
  parseGraphql,
  postGraphql,
} from "./graphql";

/**
 * Reacting to a shared post, so the sender can see it landed.
 *
 * There is no REST endpoint for this - the `direct_v2/.../react` shapes all
 * 404. It is a Relay mutation, and the identifiers are not the ones the DM API
 * returns for a message: it is addressed by its `mid.$...` message_id and by
 * thread_v2_id. The emoji is bare - "❤", never "❤️" with U+FE0F.
 *
 * The persisted-query id changes when Instagram ships a new client. If this
 * starts failing with a GraphQL error rather than a network one, check it first.
 */

const REACTION_DOC_ID = "24374451552236906";
const FRIENDLY_NAME = "IGDirectReactionSendMutation";

export type ReactionOutcome = { ok: true } | { ok: false; error: string };

function bareEmoji(emoji: string): string {
  return emoji.replace(/️/g, "");
}

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

  const call = {
    docId: REACTION_DOC_ID,
    friendlyName: FRIENDLY_NAME,
    variables: {
      input: {
        emoji: bareEmoji(emoji),
        item_id: "",
        message_id: messageId,
        reaction_status: remove ? "deleted" : "created",
        thread_id: threadV2Id,
      },
    },
  };

  try {
    let body = await postGraphql(await graphqlPage(), call);

    // A page open a while can carry a stale fb_dtsg. One reload, then give up.
    if (looksStale(body)) {
      console.warn("[reactions] retrying on a fresh page");
      body = await postGraphql(await graphqlPage(true), call);
    }

    const parsed = parseGraphql(body);
    if (!parsed) return { ok: false, error: `Unreadable reply: ${body.slice(0, 200)}` };
    if (parsed.errors?.length) {
      return { ok: false, error: parsed.errors.map((e) => e.message ?? "error").join("; ").slice(0, 300) };
    }

    // A 200 with a `data` key proves nothing - GraphQL answers a no-op the same
    // way. Only the slide message the mutation returns counts as evidence.
    const payload = parsed.data?.xig_direct_reaction_send_with_slide_messaging_response as
      | { slide_message?: unknown }
      | null
      | undefined;
    if (!payload?.slide_message) {
      console.warn(`[reactions] mutation returned no slide_message: ${body.slice(0, 600)}`);
      return {
        ok: false,
        error: `Instagram accepted the request but reported no reaction: ${body.slice(0, 200)}`,
      };
    }

    console.log(`[reactions] sent ${emoji} to ${messageId}: ${JSON.stringify(payload).slice(0, 300)}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

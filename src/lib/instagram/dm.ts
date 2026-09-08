import { noteIdentity } from "./client";
import { igJson } from "./tab";

/**
 * Reading shared posts out of DMs.
 *
 * Instagram keeps renaming the envelope a shared post arrives in - `media_share`,
 * `clip`, `story_share`, and lately the `xma_*` shapes - so rather than matching
 * on `item_type`, we walk each message's JSON and pick out anything that looks
 * like a post: an object carrying a shortcode, or a plain instagram.com link.
 */

export type DmUser = { id: string; username: string };

export type DmThreadSummary = {
  threadId: string;
  threadV2Id: string | null;
  title: string;
  users: DmUser[];
  lastActivityAt: Date | null;
};

export type DmThread = {
  items: Json[];
  users: DmUser[];
  threadV2Id: string | null;
  /** Feed back as `cursor` to get the next page further back. */
  oldestCursor: string | null;
  hasOlder: boolean;
};

export type SharedPost = {
  shortcode: string;
  permalink: string;
  mediaType: "post" | "reel" | "tv" | "unknown";
  mediaId: string | null;
  caption: string | null;
  authorUsername: string | null;
  thumbnailUrl: string | null;
  messageText: string | null;
  itemId: string;
  /** `mid.$...`, the id the reaction mutation wants. */
  messageId: string | null;
  senderId: string | null;
  sharedAt: Date | null;
};

export type Json = Record<string, unknown>;

const PERMALINK_RE = /instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})/g;
const SHORTCODE_RE = /^[A-Za-z0-9_-]{5,30}$/;

/** What the web client asks for: a page of the inbox is 20 threads, a page of a thread 20 messages. */
export const INBOX_PAGE = 20;
export const THREAD_PAGE = 20;

export async function fetchInbox(limit: number = INBOX_PAGE): Promise<DmThreadSummary[]> {
  // The same shape the inbox page itself requests, so the call is not a new
  // kind of request from this session.
  const query = new URLSearchParams({
    persistentBadging: "true",
    folder: "",
    limit: String(Math.min(Math.max(limit, 1), INBOX_PAGE)),
    thread_message_limit: "10",
  });

  const data = await igJson<{
    inbox?: { threads?: Json[] };
    viewer?: { username?: string; pk?: string | number };
  }>(`/api/v1/direct_v2/inbox/?${query}`);

  // The inbox says who is reading it; no separate identity call needed.
  if (data.viewer?.username) {
    void noteIdentity(data.viewer.username, data.viewer.pk != null ? String(data.viewer.pk) : null);
  }

  return (data.inbox?.threads ?? []).map(toThreadSummary).filter((t): t is DmThreadSummary => t !== null);
}

/** One page of a thread - the newest 20 messages, or the 20 before `cursor`. */
export async function fetchThread(threadId: string, cursor?: string | null): Promise<DmThread> {
  const query = new URLSearchParams({
    visual_message_return_type: "unseen",
    direction: "older",
    limit: String(THREAD_PAGE),
  });
  if (cursor) query.set("cursor", cursor);

  const data = await igJson<{
    thread?: {
      items?: Json[];
      users?: Json[];
      thread_v2_id?: string;
      oldest_cursor?: string;
      has_older?: boolean;
    };
  }>(`/api/v1/direct_v2/threads/${encodeURIComponent(threadId)}/?${query}`);

  return {
    items: data.thread?.items ?? [],
    users: toUsers(data.thread?.users),
    threadV2Id: str(data.thread?.thread_v2_id),
    oldestCursor: str(data.thread?.oldest_cursor),
    hasOlder: data.thread?.has_older === true,
  };
}

/**
 * A shortcode is the media id in base 64, using Instagram's alphabet. Decoding
 * it gives the id the media endpoint wants, so a bare pasted link can be looked
 * up the same way an attached share is - no scraping a post page for it.
 */
const SHORTCODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function mediaIdFromShortcode(shortcode: string): string | null {
  // Longer codes carry other data; only the plain 11-character form is an id.
  if (shortcode.length > 11) return null;
  let id = BigInt(0);
  for (const char of shortcode) {
    const value = SHORTCODE_ALPHABET.indexOf(char);
    if (value < 0) return null;
    id = id * BigInt(64) + BigInt(value);
  }
  return id > BigInt(0) ? id.toString() : null;
}

export type ChatMessage = {
  id: string;
  /** What was typed, when anything was. */
  text: string | null;
  senderId: string | null;
  at: string | null;
  /** Set when the message was a shared post rather than words. */
  shortcode: string | null;
};

/**
 * The conversation itself: what was said, in order, by whom.
 *
 * The rest of this file is interested in the posts inside a thread. This is
 * interested in the thread - the messages that are just people talking, and
 * the shares in their place among them, so a chat reads the way it did when
 * it happened.
 */
/** The oldest message on a page, which is how far back that page reached. */
export function oldestMessageAt(items: Json[]): Date | null {
  let oldest: Date | null = null;
  for (const item of items) {
    const at = microsecondsToDate(item.timestamp);
    if (at && (!oldest || at < oldest)) oldest = at;
  }
  return oldest;
}

export function collectMessages(items: Json[]): ChatMessage[] {
  const messages: ChatMessage[] = [];

  for (const item of items) {
    const id = str(item.item_id) ?? str(item.item_id_v2);
    if (!id) continue;

    const text = str(item.text)?.trim() || null;
    const shared = extractSharedPosts(item);
    // Reactions, seen-markers and the other bookkeeping Instagram puts in a
    // thread are not things anybody said.
    if (!text && shared.length === 0) continue;

    messages.push({
      id,
      text,
      senderId: str(item.user_id),
      at: microsecondsToDate(item.timestamp)?.toISOString() ?? null,
      shortcode: shared[0]?.shortcode ?? null,
    });
  }

  // A thread arrives newest first; a conversation is read the other way.
  return messages.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
}

/**
 * Shared posts from a page of messages, with her commentary attached.
 *
 * She comments on a share in a *separate* message - "The brown glass is a
 * vibeee" arrives just after the reel, not inside it. Reading one message at a
 * time threw all of that away: of 952 posts imported that way, exactly one had
 * a note on it. So a page is read together, and a text message is attached to
 * whichever share it sits closest to in time.
 */
export function collectSharedPosts(items: Json[]): SharedPost[] {
  const found: SharedPost[] = [];
  const shares: { at: number; post: SharedPost }[] = [];

  for (const item of items) {
    for (const post of extractSharedPosts(item)) {
      found.push(post);
      if (post.sharedAt) shares.push({ at: post.sharedAt.getTime(), post });
    }
  }

  for (const item of items) {
    const text = str(item.text)?.trim();
    if (!text || shares.length === 0) continue;

    const at = microsecondsToDate(item.timestamp)?.getTime();
    if (at === undefined) continue;

    // Whichever share it sits nearest to, within five minutes. Beyond that it
    // is conversation rather than a remark about a post.
    let nearest: { at: number; post: SharedPost } | null = null;
    for (const share of shares) {
      if (Math.abs(share.at - at) > 5 * 60_000) continue;
      if (!nearest || Math.abs(share.at - at) < Math.abs(nearest.at - at)) nearest = share;
    }
    if (!nearest) continue;

    const sender = str(item.user_id);
    if (sender && nearest.post.senderId && sender !== nearest.post.senderId) continue;

    nearest.post.messageText = nearest.post.messageText
      ? `${nearest.post.messageText}\n${text}`
      : text;
  }

  return found;
}

export function extractSharedPosts(item: Json): SharedPost[] {
  const itemId = str(item.item_id) ?? str(item.item_id_v2) ?? "";
  if (!itemId) return [];

  const messageId = str(item.message_id);

  const senderId = str(item.user_id);
  const sharedAt = microsecondsToDate(item.timestamp);
  const messageText = str(item.text);

  const found = new Map<string, SharedPost>();

  // Pass 1: objects that carry a shortcode - these have the caption and thumbnail too.
  walk(item, (node) => {
    const code = str(node.code);
    if (!code || !SHORTCODE_RE.test(code) || !looksLikeMedia(node)) return;
    if (found.has(code)) return;
    found.set(code, {
      shortcode: code,
      permalink: buildPermalink(code, mediaTypeOf(node)),
      mediaType: mediaTypeOf(node),
      mediaId: str(node.pk) ?? str(node.id) ?? null,
      caption: captionOf(node),
      authorUsername: authorOf(node),
      thumbnailUrl: thumbnailOf(node),
      messageText,
      itemId,
      messageId,
      senderId,
      sharedAt,
    });
  });

  // Pass 2: bare links (shares that arrive as a URL preview, or a pasted link).
  for (const [, kind, code] of collectStrings(item).flatMap((s) => [...s.matchAll(PERMALINK_RE)])) {
    if (!code || found.has(code)) continue;
    const mediaType = kind === "reel" || kind === "reels" ? "reel" : kind === "tv" ? "tv" : "post";
    found.set(code, {
      shortcode: code,
      permalink: buildPermalink(code, mediaType),
      mediaType,
      mediaId: null,
      caption: null,
      authorUsername: null,
      thumbnailUrl: firstImageUrl(item),
      messageText,
      itemId,
      messageId,
      senderId,
      sharedAt,
    });
  }

  return [...found.values()];
}

function toThreadSummary(thread: Json): DmThreadSummary | null {
  const threadId = str(thread.thread_id) ?? str(thread.thread_v2_id);
  if (!threadId) return null;

  const users = toUsers(thread.users);

  return {
    threadId,
    threadV2Id: str(thread.thread_v2_id),
    title: str(thread.thread_title) || users.map((u) => u.username).join(", ") || threadId,
    users,
    lastActivityAt: microsecondsToDate(thread.last_activity_at),
  };
}

function toUsers(value: unknown): DmUser[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isJson)
    .map((user) => ({ id: str(user.pk) ?? "", username: str(user.username) ?? "" }))
    .filter((user) => user.id !== "" && user.username !== "");
}

function looksLikeMedia(node: Json): boolean {
  return (
    "image_versions2" in node ||
    "media_type" in node ||
    "carousel_media" in node ||
    "video_versions" in node ||
    "taken_at" in node
  );
}

function mediaTypeOf(node: Json): SharedPost["mediaType"] {
  const productType = str(node.product_type);
  if (productType === "clips") return "reel";
  if (productType === "igtv") return "tv";
  if (node.media_type === 2) return "reel";
  if (node.media_type === 1 || node.media_type === 8) return "post";
  return "unknown";
}

function buildPermalink(code: string, mediaType: SharedPost["mediaType"]): string {
  const segment = mediaType === "reel" ? "reel" : mediaType === "tv" ? "tv" : "p";
  return `https://www.instagram.com/${segment}/${code}/`;
}

function captionOf(node: Json): string | null {
  const caption = node.caption;
  if (isJson(caption)) return str(caption.text) ?? null;
  return str(node.caption_text) ?? null;
}

function authorOf(node: Json): string | null {
  for (const key of ["user", "owner"]) {
    const value = node[key];
    if (isJson(value)) {
      const username = str(value.username);
      if (username) return username;
    }
  }
  return null;
}

/** Prefer the largest still we can get - the model reads this image. */
function thumbnailOf(node: Json): string | null {
  const direct = bestCandidate(node);
  if (direct) return direct;

  const carousel = node.carousel_media;
  if (Array.isArray(carousel)) {
    for (const entry of carousel) {
      if (!isJson(entry)) continue;
      const url = bestCandidate(entry);
      if (url) return url;
    }
  }

  for (const key of ["thumbnail_url", "preview_url", "cover_frame_url", "cover_photo_url"]) {
    const url = str(node[key]);
    if (url) return url;
  }
  return null;
}

function bestCandidate(node: Json): string | null {
  const versions = node.image_versions2;
  if (!isJson(versions)) return null;
  const candidates = versions.candidates;
  if (!Array.isArray(candidates)) return null;

  let best: { url: string; width: number } | null = null;
  for (const candidate of candidates) {
    if (!isJson(candidate)) continue;
    const url = str(candidate.url);
    const width = typeof candidate.width === "number" ? candidate.width : 0;
    if (url && (!best || width > best.width)) best = { url, width };
  }
  return best?.url ?? null;
}

function firstImageUrl(root: Json): string | null {
  let found: string | null = null;
  walk(root, (node) => {
    if (found) return;
    found = bestCandidate(node);
    if (found) return;
    for (const key of ["preview_url", "thumbnail_url", "image_url"]) {
      const url = str(node[key]);
      if (url?.startsWith("http")) {
        found = url;
        return;
      }
    }
  });
  return found;
}

function collectStrings(root: unknown): string[] {
  const out: string[] = [];
  walkValues(root, (value) => {
    if (typeof value === "string" && value.includes("instagram.com")) out.push(value);
  });
  return out;
}

function walk(root: unknown, visit: (node: Json) => void) {
  walkValues(root, (value) => {
    if (isJson(value)) visit(value);
  });
}

function walkValues(root: unknown, visit: (value: unknown) => void, depth = 0) {
  if (depth > 12 || root === null || root === undefined) return;
  visit(root);
  if (Array.isArray(root)) {
    for (const entry of root) walkValues(entry, visit, depth + 1);
  } else if (typeof root === "object") {
    for (const entry of Object.values(root as Json)) walkValues(entry, visit, depth + 1);
  }
}

function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number") return String(value);
  return null;
}

/** DM timestamps are microseconds since epoch. */
function microsecondsToDate(value: unknown): Date | null {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return new Date(Math.round(numeric / 1000));
}

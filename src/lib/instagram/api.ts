import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { threads } from "@/db/schema";
import { TOKEN_DIR } from "@/lib/claude-token";
import { getSetting } from "@/lib/settings";
import type { DmThread, DmThreadSummary, DmUser, Json } from "./dm";
import { RateLimitedError } from "./errors";

/**
 * Instagram through the API on Muse, instead of through a browser.
 *
 * The API is an authorised Meta product running on another machine, reached
 * through a reverse SSH tunnel that machine keeps open to this one, so it is
 * http://127.0.0.1:8000 from here. It answers in its own shapes; this module
 * turns them into the ones the rest of the app already reads, so sync,
 * backfill and the chat need no second code path.
 *
 * Every call here except /health and /dms/updates is a real request to
 * Instagram on the API's side, and that includes reads. The updates feed is
 * the API's own cache - it polls Instagram on a schedule of its own - so
 * waiting on it costs Instagram nothing.
 */

export const API_KEY_PATH = path.join(TOKEN_DIR, "instagram-api-key");

/** The tunnel or the API is down: nothing answered at all. */
export class ApiUnavailableError extends Error {
  constructor(message = "The Instagram API is not reachable. The tunnel from Muse may be down.") {
    super(message);
    this.name = "ApiUnavailableError";
  }
}

/** The API answered, and said no. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const globalForApi = globalThis as unknown as { __igApiSource?: { value: boolean; at: number } };

/**
 * Whether the app reads Instagram through the API rather than the browser.
 *
 * Read from settings, but cached for a few seconds: this sits in front of
 * every browser launch, and a database read per page fetch is not free.
 */
export async function usingApi(): Promise<boolean> {
  const cached = globalForApi.__igApiSource;
  if (cached && Date.now() - cached.at < 5_000) return cached.value;
  const value = (await getSetting("instagramSource")) === "api";
  globalForApi.__igApiSource = { value, at: Date.now() };
  return value;
}

/** For a settings change to apply at once rather than within five seconds. */
export function forgetSourceCache() {
  globalForApi.__igApiSource = undefined;
}

function apiKey(): string {
  try {
    const key = fs.readFileSync(API_KEY_PATH, "utf8").trim();
    if (key) return key;
  } catch {
    // reported below
  }
  throw new ApiUnavailableError(`No API key at ${API_KEY_PATH}.`);
}

async function call<T>(
  method: "GET" | "POST",
  pathname: string,
  options: { query?: Record<string, string | number | null | undefined>; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const base = (await getSetting("instagramApiBase")).replace(/\/+$/, "");
  const url = new URL(base + pathname);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== null && value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        "X-API-Key": apiKey(),
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
  } catch (error) {
    if (error instanceof ApiUnavailableError) throw error;
    throw new ApiUnavailableError(
      `The Instagram API did not answer (${error instanceof Error ? error.message : String(error)}).`,
    );
  }

  const text = await response.text();
  if (response.status === 429) {
    // Instagram, or the API in front of it, objecting. Same answer as when the
    // browser was told this: stop, and let the pause take it from here.
    throw new RateLimitedError(`The Instagram API was rate-limited: ${text.slice(0, 200)}`);
  }
  if (!response.ok) {
    throw new ApiError(response.status, `Instagram API ${response.status} on ${pathname}: ${detail(text)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(response.status, `Instagram API sent something that is not JSON on ${pathname}.`);
  }
}

function detail(text: string): string {
  try {
    const parsed = JSON.parse(text) as { detail?: unknown; error?: unknown };
    const value = parsed.detail ?? parsed.error;
    if (typeof value === "string") return value.slice(0, 300);
    if (value !== undefined) return JSON.stringify(value).slice(0, 300);
  } catch {
    // not JSON; the raw text will do
  }
  return text.slice(0, 300);
}

// ---------------------------------------------------------------------------
// The API's shapes, as far as this app reads them.

type ApiTimestamp = { utc?: string };

type ApiMessage = {
  message_id?: string;
  sender_fbid?: string;
  timestamp?: string;
  message_sent_at?: ApiTimestamp;
  content_type?: string;
  content?: {
    text_body?: string;
    xma_text_body?: string;
    text_fragments?: unknown;
    xma?: { target_url?: string | null; caption_body_text?: string | null } | null;
  } | null;
};

type ApiUser = {
  id?: string;
  username?: string;
  full_name?: string;
  profile_pic_url?: string;
};

type ApiThread = {
  thread_fbid?: string;
  thread_title?: string;
  last_activity_timestamp_ms?: string;
  users?: ApiUser[];
  messages?: ApiMessage[];
  messages_page_info?: { end_cursor?: string | null; has_next_page?: boolean };
};

export type ApiUpdate = {
  thread_fbid: string;
  thread_title?: string;
  message_id: string;
  sender_fbid?: string;
  sent_at: string;
  content_type?: string;
  text?: string;
  share_url?: string | null;
};

export type ApiUpdates = {
  messages: ApiUpdate[];
  checkedAt: string | null;
  warmingUp: boolean;
};

export type ApiHealth = { ok: boolean; accountId: string | null };

export type ApiPost = {
  mediaId: string | null;
  imageUrl: string | null;
  caption: string | null;
  authorUsername: string | null;
};

// ---------------------------------------------------------------------------
// Calls.

/** Local only: whether the API process is up. Says nothing about Instagram. */
export async function health(): Promise<ApiHealth> {
  const base = (await getSetting("instagramApiBase")).replace(/\/+$/, "");
  try {
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(10_000) });
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; account_id?: string };
    return { ok: response.ok && body.ok === true, accountId: body.account_id ?? null };
  } catch {
    return { ok: false, accountId: null };
  }
}

/** The inbox's most recent threads, in the shape fetchInbox returns. */
export async function inbox(limit: number): Promise<DmThreadSummary[]> {
  const data = await call<{ threads?: ApiThread[] }>("GET", "/dms/inbox", {
    // One message per thread: the list is for titles and activity times,
    // and reading a conversation is a separate call anyway.
    query: { first: Math.min(Math.max(limit, 1), 20), message_count: 1 },
  });
  const summaries: DmThreadSummary[] = [];
  for (const thread of data.threads ?? []) {
    const fbid = thread.thread_fbid;
    if (!fbid) continue;
    const users = toUsers(thread.users);
    summaries.push({
      threadId: await threadIdFor(fbid),
      threadV2Id: fbid,
      title: thread.thread_title || users.map((u) => u.username).join(", ") || fbid,
      users,
      lastActivityAt: msToDate(thread.last_activity_timestamp_ms),
    });
  }
  return summaries;
}

/** One page of a thread, newest first, in the shape fetchThread returns. */
export async function thread(threadId: string, cursor?: string | null): Promise<DmThread> {
  const fbid = await fbidFor(threadId);
  const data = await call<ApiThread>("GET", `/dms/threads/${encodeURIComponent(fbid)}`, {
    query: { first: 20, after: cursor ?? null },
  });
  const nextCursor = data.messages_page_info?.end_cursor ?? null;
  return {
    items: (data.messages ?? []).map(toItem).filter((item): item is Json => item !== null),
    users: toUsers(data.users),
    threadV2Id: data.thread_fbid ?? fbid,
    oldestCursor: nextCursor,
    hasOlder: data.messages_page_info?.has_next_page === true && Boolean(nextCursor),
  };
}

/**
 * New messages since a point in time, from the API's own cache.
 *
 * `wait` makes it a long poll: the API holds the request until something
 * newer arrives or the wait runs out. Strictly newer than `since`, so passing
 * the newest `sent_at` seen never returns it twice.
 */
export async function updates(since: string | null, waitSeconds: number): Promise<ApiUpdates> {
  const data = await call<{ messages?: ApiUpdate[]; checked_at?: string; warming_up?: boolean }>(
    "GET",
    "/dms/updates",
    { query: { since, wait: waitSeconds }, timeoutMs: (waitSeconds + 30) * 1000 },
  );
  return {
    messages: (data.messages ?? []).filter((m) => m.thread_fbid && m.message_id && m.sent_at),
    checkedAt: data.checked_at ?? null,
    warmingUp: data.warming_up === true,
  };
}

/**
 * A shared post's caption, author and cover, from its link.
 *
 * Resolved by the API through Instagram's public oEmbed, without the account,
 * and cached there for a day per shortcode.
 */
export async function postByUrl(permalink: string): Promise<ApiPost | null> {
  try {
    const data = await call<{
      media_id?: string;
      caption?: string;
      author_username?: string;
      thumbnail_url?: string;
    }>("GET", "/posts/by-url", { query: { url: permalink } });
    return {
      mediaId: data.media_id ?? null,
      imageUrl: data.thumbnail_url ?? null,
      caption: data.caption?.trim() || null,
      authorUsername: data.author_username ?? null,
    };
  } catch (error) {
    // Deleted or private: a post with no cover, not a failed sync.
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) return null;
    throw error;
  }
}

/**
 * A reel's video, as a short-lived signed CDN link.
 *
 * The API gets it without the account - a logged-out lookup on its side - and
 * keeps it for a few hours per shortcode. The link expires, so it is for
 * downloading at once, not for storing.
 */
export async function postVideo(permalink: string): Promise<string | null> {
  try {
    const data = await call<{ video_url?: string }>("GET", "/posts/video", {
      query: { url: permalink },
      timeoutMs: 90_000,
    });
    return data.video_url ?? null;
  } catch (error) {
    // A photo post, a withheld video, a deleted post: no reel to keep.
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) return null;
    throw error;
  }
}

export type ApiPostItem = { type: "image" | "video"; url: string; width: number; height: number };

/**
 * Every entry in a post, in order, each as its largest signed CDN link: all
 * the photos of a carousel, the one photo of a single post, or a reel's video.
 * Found without the account, like the video, and cached the same way.
 */
export async function postImages(permalink: string): Promise<ApiPostItem[] | null> {
  try {
    const data = await call<{ items?: Partial<ApiPostItem>[] }>("GET", "/posts/images", {
      query: { url: permalink },
      timeoutMs: 90_000,
    });
    return (data.items ?? [])
      .filter((item): item is ApiPostItem => (item.type === "image" || item.type === "video") && Boolean(item.url))
      .map((item) => ({ ...item, width: item.width ?? 0, height: item.height ?? 0 }));
  } catch (error) {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The outbound queue.
//
// A send or a reaction made through the API directly asks Marcus to approve
// it on Muse's side, one card per action. Queued instead, it is sent by a
// scheduled task on Muse that carries one standing approval, within about
// half a minute. The queue answers at once; whether the item went is learned
// afterwards from /dms/queue, which the listener checks while anything of
// ours is still waiting.

export type QueueItem = {
  id: string;
  type: "react" | "send";
  thread_fbid: string;
  message_id?: string;
  emoji?: string;
  text?: string;
  status: "queued" | "sent" | "failed";
  queued_at: number;
  sent_at?: number;
  error?: string;
};

const globalForQueue = globalThis as unknown as { __igQueued?: Map<string, number> };
/** Items this app queued and has not yet seen resolved, by id, with when. */
export const outstanding: Map<string, number> = (globalForQueue.__igQueued ??= new Map());

export async function queueReaction(options: {
  threadFbid: string;
  messageId: string;
  emoji: string;
}): Promise<{ ok: true; queueId: string } | { ok: false; error: string }> {
  try {
    const item = await call<Partial<QueueItem>>("POST", "/dms/react/queue", {
      body: { thread_fbid: options.threadFbid, message_id: options.messageId, emoji: options.emoji },
    });
    if (!item.id) return { ok: false, error: "The queue took the reaction but returned no id." };
    if (item.status !== "sent") outstanding.set(item.id, Date.now());
    return { ok: true, queueId: item.id };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function queueMessage(options: {
  threadFbid: string;
  text: string;
  replyToMessageId?: string | null;
}): Promise<{ ok: true; messageId: null } | { ok: false; error: string }> {
  try {
    const item = await call<Partial<QueueItem>>("POST", "/dms/send/queue", {
      body: {
        thread_fbid: options.threadFbid,
        text: options.text,
        // Not read by the queue yet; sent along so a quoted reply becomes one
        // as soon as it is. Until then it arrives as a plain message.
        reply_to_message_id: options.replyToMessageId ?? null,
      },
    });
    if (!item.id) return { ok: false, error: "The queue took the message but returned no id." };
    if (item.status !== "sent") outstanding.set(item.id, Date.now());
    return { ok: true, messageId: null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The whole outbound queue. Local to the API; never reaches Instagram. */
export async function outboundQueue(): Promise<QueueItem[]> {
  const data = await call<{ items?: QueueItem[] }>("GET", "/dms/queue");
  return data.items ?? [];
}

export async function send(options: {
  threadFbid: string;
  text: string;
  replyToMessageId?: string | null;
}): Promise<{ ok: true; messageId: string | null } | { ok: false; error: string }> {
  try {
    const data = await call<Json>("POST", "/dms/send", {
      body: {
        thread_fbid: options.threadFbid,
        text: options.text,
        reply_to_message_id: options.replyToMessageId ?? null,
      },
    });
    return { ok: true, messageId: messageIdIn(data) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function react(options: {
  threadFbid: string;
  messageId: string;
  emoji: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await call<Json>("POST", "/dms/react", {
      body: { thread_fbid: options.threadFbid, message_id: options.messageId, emoji: options.emoji },
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// Shapes.

/**
 * An API message as the DM item the parser in dm.ts reads.
 *
 * The parser walks an item for anything carrying an instagram.com link, so a
 * share only has to bring its link along; everything it needs beyond that -
 * caption, cover, author - is looked up afterwards, the same as a pasted link
 * always was. Timestamps become microseconds because that is what the private
 * API used and what the parser converts from.
 */
export function toItem(message: ApiMessage): Json | null {
  const id = message.message_id;
  if (!id) return null;
  const ms = Number(message.timestamp) || Date.parse(message.message_sent_at?.utc ?? "");
  const content = message.content ?? {};
  const text = content.text_body?.trim() || content.xma_text_body?.trim() || fragmentsText(content.text_fragments);
  const link = content.xma?.target_url ?? null;
  return {
    item_id: id,
    message_id: id,
    user_id: message.sender_fbid ?? null,
    timestamp: Number.isFinite(ms) && ms > 0 ? ms * 1000 : null,
    text: text || null,
    item_type: message.content_type ?? null,
    ...(link ? { link: { target_url: link } } : {}),
  };
}

/** Text that arrives in pieces - a mention or a link inside it - as one string. */
function fragmentsText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((fragment) => {
      if (typeof fragment === "string") return fragment;
      if (typeof fragment !== "object" || fragment === null) return "";
      const record = fragment as Json;
      for (const key of ["plaintext", "text"]) {
        if (typeof record[key] === "string") return record[key] as string;
      }
      return "";
    })
    .join("")
    .trim();
}

function toUsers(value: ApiUser[] | undefined): DmUser[] {
  return (value ?? [])
    .map((user) => ({
      id: user.id ?? "",
      username: user.username ?? "",
      avatarUrl: user.profile_pic_url ?? null,
    }))
    .filter((user) => user.id !== "" && user.username !== "");
}

function messageIdIn(data: Json): string | null {
  if (typeof data.message_id === "string") return data.message_id;
  const ids = ((data._meta as Json | undefined)?.data as Json | undefined)?.message_ids;
  return Array.isArray(ids) && typeof ids[0] === "string" ? ids[0] : null;
}

function msToDate(value: unknown): Date | null {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
}

/**
 * The thread row a conversation belongs to.
 *
 * The API names a thread by what the browser called thread_v2_id, and the
 * table is keyed by the older private-API thread id. A conversation already
 * known keeps its row; one first seen through the API is keyed by its fbid.
 */
async function threadIdFor(fbid: string): Promise<string> {
  const [row] = await db
    .select({ threadId: threads.threadId })
    .from(threads)
    .where(eq(threads.threadV2Id, fbid))
    .limit(1);
  return row?.threadId ?? fbid;
}

/** The other way: the fbid to ask the API for, given a row's thread id. */
async function fbidFor(threadId: string): Promise<string> {
  const [row] = await db
    .select({ threadV2Id: threads.threadV2Id })
    .from(threads)
    .where(and(eq(threads.threadId, threadId)))
    .limit(1);
  return row?.threadV2Id ?? threadId;
}

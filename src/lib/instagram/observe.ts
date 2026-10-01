import type { Page, Response } from "playwright";
import { asBool, getSetting } from "@/lib/settings";
import { fetchingInPage } from "./tab";

/**
 * Watching what the inbox page fetches, and writing down nothing else.
 *
 * Two questions need answering before the watcher can be trusted, and neither
 * can be answered by reading code:
 *
 *   1. When a message arrives, does the page fetch it - or does the realtime
 *      frame carry it and the page never asks? The sync trigger now waits for
 *      such a fetch, so if the answer is "it never asks", that trigger is too
 *      strict and delivery quietly falls back to the twice-daily timer.
 *   2. If it does fetch, is the payload rich enough to use instead of making
 *      the same request again ourselves? fetchInbox asks for ten messages per
 *      thread, so the page's own inbox response may already hold everything a
 *      sync would have gone and collected.
 *
 * This answers both by watching, and does nothing else: no requests of its
 * own, no change to what syncs, no decisions. It is off unless the
 * `observePayloads` setting says otherwise.
 *
 * **It records shapes, never contents.** Counts, sizes, timestamps and which
 * endpoint - never message text, usernames, or anything that would put a
 * private conversation in a log file. Thread identifiers are truncated to
 * enough to tell two threads apart and no more.
 */

const DIRECT_API = /\/api\/v1\/direct_v2\//;
/**
 * Everything the page asks Instagram for, not just the endpoint we happen to
 * use ourselves.
 *
 * Started as direct_v2 only, and saw nothing at all - which is either the
 * answer (the page never fetches) or a filter looking in the wrong place. The
 * web client may well carry DMs over GraphQL rather than the private API this
 * app calls, and a narrow filter cannot tell those two cases apart. So: watch
 * every API-shaped request to instagram.com and let the log say which.
 */
const IG_API = /instagram\.com\/(api\/|graphql)/;
/** Enough to tell threads apart in a log, not enough to address one. */
const ID_PREFIX = 8;
const KEEP = 200;

export type Observation = {
  at: string;
  kind: "inbox" | "thread" | "graphql" | "other";
  path: string;
  /**
   * Which GraphQL query this was, by the name the page gives it - the
   * x-fb-friendly-name header, or fb_api_req_friendly_name in the form body -
   * and its doc_id. Every GraphQL request shares one path, so without these
   * a message fetch and a profile-picture fetch look the same. Both name
   * the query, not the person: they are the same for every account. The
   * variables, which can hold thread ids, are not recorded.
   */
  op?: string;
  docId?: string;
  /** The query keys the page used, so ours can be compared with theirs. */
  query: Record<string, string>;
  status: number;
  /** False when Playwright could not give us the body - a real possibility. */
  bodyRead: boolean;
  bytes: number | null;
  /** Threads in an inbox payload, or null. */
  threads: number | null;
  /** Messages carried, summed across threads for an inbox payload. */
  messages: number | null;
  /** The oldest message in the payload, which says how far back it reaches. */
  oldest: string | null;
  newest: string | null;
  /**
   * For GraphQL: the field names on the way down from `data`, two levels
   * deep. Schema, not content - enough to recognise a message-shaped
   * response when the query name alone does not give it away.
   */
  shape?: string[];
  note?: string;
};

/**
 * On globalThis, like every other piece of runtime state here.
 *
 * The watcher and the route handler that reads this back are separate module
 * instances in a Next build, so module-level state is two different arrays
 * wearing the same name. The log filled up correctly and the endpoint
 * reported nothing, which reads exactly like "the page never fetches" - the
 * finding this was built to establish. An instrument that can fail into the
 * shape of its own hypothesis is worse than no instrument.
 */
type ObserveStore = { log: Observation[]; totals: { responses: number; instagram: number; matched: number } };
const globalForObserve = globalThis as unknown as { __igObserve?: ObserveStore };
const store: ObserveStore = (globalForObserve.__igObserve ??= {
  log: [],
  totals: { responses: 0, instagram: 0, matched: 0 },
});
const log = store.log;

/**
 * Every response seen, matched or not.
 *
 * Without this, "nothing recorded" has two very different explanations that
 * look identical: the page really is not calling Instagram's API, or the
 * listener is not firing at all. One is the answer we came for; the other is a
 * broken instrument. The totals tell them apart.
 */
const totals = store.totals;

export function getTotals() {
  return { ...totals };
}

/** Contexts already listened to, so a second page does not double-count. */
const wired = new WeakSet<object>();

export function getObservations(): Observation[] {
  return [...log].reverse();
}

export function clearObservations() {
  log.length = 0;
}

/** Attach to a freshly opened inbox page. Cheap when the setting is off. */
export async function observePage(page: Page) {
  if (!asBool(await getSetting("observePayloads"))) return;

  // The context, not the page. A page listener misses anything a worker
  // fetches, and a web app of this size may well do its talking from one -
  // which would look exactly like a page that never fetches anything.
  const context = page.context();
  if (wired.has(context)) return;
  wired.add(context);

  context.on("response", (response) => void record(response));
  console.log("[observe] watching every response in the browser context (shapes only)");
}

async function record(response: Response) {
  const url = response.url();
  totals.responses += 1;
  if (url.includes("instagram.com")) totals.instagram += 1;
  if (!IG_API.test(url)) return;
  totals.matched += 1;

  // Ours, not the page's. Counting our own requests as evidence that the page
  // fetches on its own would answer question 1 with our own footsteps.
  if (fetchingInPage()) return;

  const parsed = new URL(url);
  const isGraphQL = /graphql/.test(parsed.pathname);
  const entry: Observation = {
    at: new Date().toISOString(),
    kind: DIRECT_API.test(url) && parsed.pathname.includes("/inbox/")
      ? "inbox"
      : DIRECT_API.test(url) && parsed.pathname.includes("/threads/")
        ? "thread"
        : isGraphQL
          ? "graphql"
          : "other",
    path: parsed.pathname.replace(/\/threads\/[^/]+/, "/threads/<id>"),
    // Keys and short values only. A long run of digits in a query string is an
    // identifier, and identifiers are the thing this is not writing down.
    query: Object.fromEntries(
      [...parsed.searchParams].map(([k, v]) => [k, /^\d{6,}$/.test(v) ? "<id>" : v.slice(0, 40)]),
    ),
    status: response.status(),
    bodyRead: false,
    bytes: null,
    threads: null,
    messages: null,
    oldest: null,
    newest: null,
  };

  if (isGraphQL) nameQuery(response, entry);

  try {
    const text = await response.text();
    entry.bodyRead = true;
    entry.bytes = text.length;
    if (isGraphQL) summariseGraphQL(text, entry);
    else summarise(text, entry);
  } catch (error) {
    // Expected sometimes: a navigation, a streamed body, the target closing.
    // Worth recording as a fact, because "can we read these at all" is half
    // of question 2.
    entry.note = `body unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }

  push(entry);
}

/**
 * Pull the shape out of a payload and let the rest go.
 *
 * Deliberately tolerant: this is reconnaissance, and a payload that does not
 * match the expected shape is itself a finding rather than an error.
 */
function summarise(text: string, entry: Observation) {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    entry.note = "not JSON";
    return;
  }

  const stamps: number[] = [];
  let threads = 0;
  let messages = 0;

  const readItems = (items: unknown) => {
    if (!Array.isArray(items)) return;
    messages += items.length;
    for (const item of items) {
      const at = (item as { timestamp?: unknown })?.timestamp;
      // Instagram's DM timestamps are microseconds.
      const n = typeof at === "string" ? Number(at) : typeof at === "number" ? at : NaN;
      if (Number.isFinite(n) && n > 0) stamps.push(n / 1000);
    }
  };

  const body = data as { inbox?: { threads?: unknown[] }; thread?: { items?: unknown[] } };
  if (Array.isArray(body?.inbox?.threads)) {
    threads = body.inbox.threads.length;
    for (const t of body.inbox.threads) readItems((t as { items?: unknown })?.items);
  } else if (body?.thread) {
    threads = 1;
    readItems(body.thread.items);
  }

  entry.threads = threads;
  entry.messages = messages;
  if (stamps.length) {
    entry.oldest = new Date(Math.min(...stamps)).toISOString();
    entry.newest = new Date(Math.max(...stamps)).toISOString();
  }
}

/** The query's name and doc_id, from the request that produced it. */
function nameQuery(response: Response, entry: Observation) {
  try {
    const request = response.request();
    const headers = request.headers();
    const form = new URLSearchParams(request.postData() ?? "");
    const op = headers["x-fb-friendly-name"] ?? form.get("fb_api_req_friendly_name") ?? form.get("query_name");
    const docId = form.get("doc_id") ?? new URL(request.url()).searchParams.get("doc_id");
    if (op) entry.op = op.slice(0, 120);
    if (docId && /^\d{1,25}$/.test(docId)) entry.docId = docId;
  } catch {
    // A request that cannot be read is still a response worth counting.
  }
}

/** Keys that hold one message, in the schemas seen so far and the likely ones. */
const MESSAGE_KEY = /^(message_id|messageId|mid|item_id|offline_threading_id)$/;
/** Keys that hold a time, and the units they are likely in. */
const TIME_KEY = /^(timestamp|timestamp_ms|timestamp_precise|created_at|sent_at)$/;

/**
 * The GraphQL version of summarise: count what looks like a message, find
 * the newest and oldest times, note the shape. Values are read only to count
 * them and to turn times into dates; nothing else from the body is kept.
 *
 * Bodies can be several JSON documents in a row, and can start with a
 * for (;;); guard, so each line is tried on its own.
 */
function summariseGraphQL(text: string, entry: Observation) {
  const documents: unknown[] = [];
  for (const line of text.replace(/^for \(;;\);/, "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      documents.push(JSON.parse(trimmed));
    } catch {
      // A line that is not JSON is skipped; a body with none is noted below.
    }
  }
  if (documents.length === 0) {
    entry.note = "not JSON";
    return;
  }

  const stamps: number[] = [];
  let messages = 0;
  const walk = (node: unknown, depth: number) => {
    if (depth > 40 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1);
      return;
    }
    let isMessage = false;
    for (const [key, value] of Object.entries(node)) {
      if (MESSAGE_KEY.test(key) && (typeof value === "string" || typeof value === "number")) isMessage = true;
      if (TIME_KEY.test(key)) {
        const at = toMillis(value);
        if (at !== null) stamps.push(at);
      }
      walk(value, depth + 1);
    }
    if (isMessage) messages += 1;
  };

  // Some responses key objects by id rather than by field name, and an id is
  // exactly what this does not write down.
  const schemaKeys = (keys: string[]) => keys.filter((k) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k));
  const shape = new Set<string>();
  for (const document of documents) {
    walk(document, 0);
    const data = (document as { data?: unknown })?.data;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      for (const key of schemaKeys(Object.keys(data))) {
        const value = (data as Record<string, unknown>)[key];
        const below = value && typeof value === "object" && !Array.isArray(value)
          ? schemaKeys(Object.keys(value)).slice(0, 6).join(",")
          : "";
        shape.add(below ? `${key}{${below}}` : key);
      }
    }
  }

  entry.messages = messages;
  if (shape.size) entry.shape = [...shape].slice(0, 6);
  // Times far in the past or future are some other number with a time-like
  // name; a message lands within a few years of now.
  const plausible = stamps.filter((t) => t > Date.parse("2010-01-01") && t < Date.now() + 86_400_000);
  if (plausible.length) {
    entry.oldest = new Date(Math.min(...plausible)).toISOString();
    entry.newest = new Date(Math.max(...plausible)).toISOString();
  }
}

/** Seconds, milliseconds or microseconds, as milliseconds. */
function toMillis(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 1e14) return n / 1000; // microseconds
  if (n > 1e11) return n; // milliseconds
  return n * 1000; // seconds
}

function push(entry: Observation) {
  log.push(entry);
  if (log.length > KEEP) log.shift();
  // Timestamped, unlike the rest of the log, because the whole point of these
  // lines is to be lined up against a message arriving and a sync starting.
  const named = entry.kind === "graphql"
    ? `op=${entry.op ?? "?"} doc=${entry.docId ?? "?"} shape=${(entry.shape ?? []).join(";") || "-"} `
    : "";
  console.log(
    `[observe] ${entry.at} ${entry.kind} ${entry.status} ${named}` +
      `threads=${entry.threads ?? "?"} messages=${entry.messages ?? "?"} ` +
      `newest ${entry.newest ?? "?"} back to ${entry.oldest ?? "?"} ` +
      `${entry.bodyRead ? `${entry.bytes}B` : entry.note ?? "no body"} ` +
      `query=${JSON.stringify(entry.query)}`,
  );
}

/** Truncated thread id, for anywhere one is genuinely needed. */
export function shortId(id: string): string {
  return id.slice(0, ID_PREFIX);
}

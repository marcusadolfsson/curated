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
/** Enough to tell threads apart in a log, not enough to address one. */
const ID_PREFIX = 8;
const KEEP = 200;

export type Observation = {
  at: string;
  kind: "inbox" | "thread" | "other";
  path: string;
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
  note?: string;
};

const log: Observation[] = [];

export function getObservations(): Observation[] {
  return [...log].reverse();
}

export function clearObservations() {
  log.length = 0;
}

/** Attach to a freshly opened inbox page. Cheap when the setting is off. */
export async function observePage(page: Page) {
  if (!asBool(await getSetting("observePayloads"))) return;
  page.on("response", (response) => void record(response));
  console.log("[observe] watching what the inbox page fetches (recording shapes only)");
}

async function record(response: Response) {
  const url = response.url();
  if (!DIRECT_API.test(url)) return;

  // Ours, not the page's. Counting our own requests as evidence that the page
  // fetches on its own would answer question 1 with our own footsteps.
  if (fetchingInPage()) return;

  const parsed = new URL(url);
  const entry: Observation = {
    at: new Date().toISOString(),
    kind: parsed.pathname.includes("/inbox/")
      ? "inbox"
      : parsed.pathname.includes("/threads/")
        ? "thread"
        : "other",
    path: parsed.pathname.replace(/\/threads\/[^/]+/, "/threads/<id>"),
    query: Object.fromEntries(parsed.searchParams),
    status: response.status(),
    bodyRead: false,
    bytes: null,
    threads: null,
    messages: null,
    oldest: null,
    newest: null,
  };

  try {
    const text = await response.text();
    entry.bodyRead = true;
    entry.bytes = text.length;
    summarise(text, entry);
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

function push(entry: Observation) {
  log.push(entry);
  if (log.length > KEEP) log.shift();
  console.log(
    `[observe] ${entry.kind} ${entry.status} ` +
      `threads=${entry.threads ?? "?"} messages=${entry.messages ?? "?"} ` +
      `back to ${entry.oldest ?? "?"} ` +
      `${entry.bodyRead ? `${entry.bytes}B` : entry.note ?? "no body"} ` +
      `query=${JSON.stringify(entry.query)}`,
  );
}

/** Truncated thread id, for anywhere one is genuinely needed. */
export function shortId(id: string): string {
  return id.slice(0, ID_PREFIX);
}

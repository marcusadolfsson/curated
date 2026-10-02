import { query } from "@anthropic-ai/claude-agent-sdk";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { posts, type Post } from "@/db/schema";
import { agentEnv, claudeAuth } from "@/lib/claude-auth";
import { getSettings } from "@/lib/settings";

/**
 * The dates a post is about, for Upcoming.
 *
 * Plenty of what she sends is time-bound - tickets that go on sale on a day,
 * an event on certain nights, a booking window that closes - and by the time
 * the post is found again the day has passed. This reads what the analysis
 * already wrote, plus the caption and what is said in a reel, and keeps the
 * dates worth acting on. Text only, in batches, the same way places are found.
 */

export type PostDate = {
  /** First day, YYYY-MM-DD. */
  start: string;
  /** Last day for a span ("Nov-Dec"), else null. */
  end: string | null;
  kind: "event" | "sale" | "deadline" | "opening" | "other";
  /** A few words: "Tickets go on sale", "After-hours nights". */
  label: string;
};

const BATCH = 40;

const SYSTEM_PROMPT = `You find the dates in shared posts that a person might want on their calendar.

For each post, list the specific dates it is about that someone could act on:
- event: something happening on a day or over days - a concert, a race, a festival, an exhibition, a season of after-hours nights.
- sale: tickets, bookings or a product going on sale, or a release.
- deadline: the last day to book, enter, apply or buy; something closing or ending.
- opening: a place or attraction opening.
- other: any other actionable date.

Rules:
- Dates as YYYY-MM-DD. A span ("November to December 2026", "Oct 3 and 17" as one run of nights) gets a start and an end; a single day gets end null. Two separate days are two entries.
- The year: when the post gives none, it is the next occurrence on or after the day the post was shared.
- A month with no day: the first of the month as start, the last of the month as end.
- Leave out recurring schedules ("every Saturday"), opening hours, history ("founded in 1995"), durations ("a 7-day trek"), plans with no date ("a renovation planned for 2026"), a whole year as a span, and anything vague ("this summer", "soon").
- label: a few words saying what happens on that date ("Tickets go on sale", "Half marathon weekend", "Last night of the tour"). No emoji.
- Most posts have no dates; an empty list is the usual answer. Never invent a date the post does not support.`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    posts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          dates: {
            type: "array",
            items: {
              type: "object",
              properties: {
                start: { type: "string" },
                end: { type: ["string", "null"] },
                kind: { type: "string", enum: ["event", "sale", "deadline", "opening", "other"] },
                label: { type: "string" },
              },
              required: ["start", "end", "kind", "label"],
              additionalProperties: false,
            },
          },
        },
        required: ["id", "dates"],
        additionalProperties: false,
      },
    },
  },
  required: ["posts"],
  additionalProperties: false,
} as const;

type FindState = { running: boolean; done: number; total: number; error: string | null };
const globalForDates = globalThis as unknown as { __dates?: FindState };
const state: FindState = (globalForDates.__dates ??= { running: false, done: 0, total: 0, error: null });

export function datingState(): FindState {
  return { ...state };
}

/** Posts that have been described but not yet read for dates. */
async function pending(): Promise<Post[]> {
  return db
    .select()
    .from(posts)
    .where(and(eq(posts.analysisStatus, "done"), isNull(posts.datedAt)));
}

/** Reads every waiting post for dates, a batch at a time. */
export async function datePending(): Promise<{ dated: number; checked: number }> {
  if (state.running) return { dated: 0, checked: 0 };
  if (!claudeAuth().ok) return { dated: 0, checked: 0 };

  const waiting = await pending();
  if (waiting.length === 0) return { dated: 0, checked: 0 };

  Object.assign(state, { running: true, done: 0, total: waiting.length, error: null });
  let dated = 0;
  try {
    for (let start = 0; start < waiting.length; start += BATCH) {
      const batch = waiting.slice(start, start + BATCH);
      const results = await find(batch);
      const byId = new Map(results.map((r) => [r.id, r.dates]));
      for (const post of batch) {
        // A post the model skipped stays waiting and is asked about again.
        if (!byId.has(post.id)) continue;
        const found = clean(byId.get(post.id) ?? []);
        await db
          .update(posts)
          .set({ dates: found.length ? JSON.stringify(found) : null, datedAt: new Date() })
          .where(eq(posts.id, post.id));
        if (found.length) dated += 1;
      }
      state.done = Math.min(start + batch.length, waiting.length);
    }
    console.log(`[dates] found dates in ${dated} of ${waiting.length} post(s)`);
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    console.error("[dates] stopped:", error);
  } finally {
    state.running = false;
  }
  return { dated, checked: waiting.length };
}

async function find(batch: Post[]): Promise<{ id: number; dates: PostDate[] }[]> {
  const settings = await getSettings();
  const input = batch.map((post) => ({
    id: post.id,
    shared: post.sharedAt ? post.sharedAt.toISOString().slice(0, 10) : null,
    summary: post.summary,
    named: parseList(post.items),
    caption: post.caption ? truncate(post.caption, 500) : null,
    said: post.transcript ? truncate(post.transcript, 600) : null,
    note: post.messageText ? truncate(post.messageText, 200) : null,
  }));

  const stream = query({
    prompt: `Find the dates in these posts.\n\nPosts:\n${JSON.stringify(input, null, 1)}`,
    options: {
      model: settings.analysisModel || undefined,
      effort: "low",
      systemPrompt: { type: "custom", prompt: SYSTEM_PROMPT },
      tools: [],
      settingSources: [],
      persistSession: false,
      env: agentEnv(),
      maxTurns: 3,
      outputFormat: { type: "json_schema", schema: OUTPUT_SCHEMA as unknown as Record<string, unknown> },
    },
  });

  for await (const message of stream) {
    if (message.type !== "result") continue;
    if (message.subtype !== "success") throw new Error(`Agent stopped: ${message.subtype}`);
    const output = message.structured_output as { posts?: { id: number; dates: PostDate[] }[] } | undefined;
    return (output?.posts ?? []).filter((p) => typeof p.id === "number" && Array.isArray(p.dates));
  }
  throw new Error("Agent produced no result.");
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Only well-formed days, an end that is not before its start, a label. */
function clean(dates: PostDate[]): PostDate[] {
  return dates
    .filter((d) => DAY.test(d.start) && !Number.isNaN(Date.parse(d.start)))
    .map((d) => ({
      start: d.start,
      end: d.end && DAY.test(d.end) && d.end > d.start ? d.end : null,
      kind: d.kind,
      label: d.label.trim().slice(0, 80) || "Date",
    }));
}

export function parseDates(value: string | null): PostDate[] {
  return parseList(value) as unknown as PostDate[];
}

function parseList(value: string | null): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

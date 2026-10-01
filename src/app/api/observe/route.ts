import { NextResponse } from "next/server";
import { clearObservations, getObservations, getTotals } from "@/lib/instagram/observe";
import { getSetting } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * What the inbox page has been fetching on its own.
 *
 * A read, and only a read - this starts nothing. It exists so the question
 * can be answered by looking at a summary rather than by grepping a log that
 * also contains every sync line.
 */
export async function GET() {
  const observations = getObservations();
  const inbox = observations.filter((o) => o.kind === "inbox");
  const threads = observations.filter((o) => o.kind === "thread");
  const unreadable = observations.filter((o) => !o.bodyRead);

  // Per GraphQL query: how often the page ran it, and whether it ever came
  // back carrying messages. The query that fetches new messages, if there is
  // one, is the row whose count rises when a message arrives.
  const queries: Record<string, { count: number; withMessages: number; mostMessages: number; last: string }> = {};
  for (const o of observations.filter((o) => o.kind === "graphql")) {
    const key = o.op ?? (o.docId ? `doc ${o.docId}` : "unnamed");
    const row = (queries[key] ??= { count: 0, withMessages: 0, mostMessages: 0, last: o.at });
    row.count += 1;
    if ((o.messages ?? 0) > 0) row.withMessages += 1;
    row.mostMessages = Math.max(row.mostMessages, o.messages ?? 0);
    if (o.at > row.last) row.last = o.at;
  }

  return NextResponse.json({
    watching: (await getSetting("observePayloads")) === "true",
    seen: observations.length,
    /**
     * Responses the listener saw at all. If this is zero the instrument is
     * broken, not the theory; if it is high and `matched` is zero, the page
     * genuinely is not calling Instagram's API.
     */
    totals: getTotals(),
    /**
     * The headline. If the page fetches nothing of its own accord when
     * messages arrive, the sync trigger is waiting for something that never
     * happens, and delivery has quietly fallen back to the twice-daily timer.
     */
    summary: {
      inboxFetches: inbox.length,
      threadFetches: threads.length,
      bodiesUnreadable: unreadable.length,
      /** Messages the richest single inbox payload carried. */
      bestInboxPayload: inbox.reduce((best, o) => Math.max(best, o.messages ?? 0), 0),
      /** Whether the page asks for messages inline, as fetchInbox does. */
      usesThreadMessageLimit: inbox.some((o) => "thread_message_limit" in o.query),
    },
    queries,
    observations,
  });
}

/** Start again, for when a run of observation has been read and noted. */
export async function DELETE() {
  clearObservations();
  return NextResponse.json({ cleared: true });
}

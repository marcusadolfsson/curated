import { NextResponse } from "next/server";
import { clearObservations, getObservations } from "@/lib/instagram/observe";
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

  return NextResponse.json({
    watching: (await getSetting("observePayloads")) === "true",
    seen: observations.length,
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
    observations,
  });
}

/** Start again, for when a run of observation has been read and noted. */
export async function DELETE() {
  clearObservations();
  return NextResponse.json({ cleared: true });
}

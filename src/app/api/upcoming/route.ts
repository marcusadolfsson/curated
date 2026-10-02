import { NextResponse } from "next/server";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/db";
import { posts, threads } from "@/db/schema";
import { datingState, parseDates, type PostDate } from "@/lib/dates";
import { toPostView, type PostView } from "@/lib/serialize";

export const dynamic = "force-dynamic";

export type UpcomingEntry = PostDate & { key: string; index: number; post: PostView };

/**
 * What is coming up: every date found in a post, from today on, soonest
 * first. A span that has started but not ended is still upcoming. A read;
 * finding dates happens in sync, or by POST /api/upcoming/scan.
 */
export async function GET() {
  // Only the conversations you follow, as the feed does.
  const watched = await db.select({ threadId: threads.threadId }).from(threads).where(eq(threads.watch, true));
  const rows = await db
    .select()
    .from(posts)
    .where(
      watched.length > 0
        ? and(isNotNull(posts.dates), inArray(posts.threadId, watched.map((t) => t.threadId)))
        : isNotNull(posts.dates),
    );

  const today = localDay(new Date());
  const entries: UpcomingEntry[] = [];
  for (const row of rows) {
    const view = toPostView(row);
    parseDates(row.dates).forEach((date, index) => {
      if ((date.end ?? date.start) < today) return;
      entries.push({ ...date, key: `${row.id}-${index}`, index, post: view });
    });
  }
  entries.sort((a, b) => a.start.localeCompare(b.start) || a.label.localeCompare(b.label));

  const [waiting] = await db
    .select({ id: posts.id })
    .from(posts)
    .where(and(eq(posts.analysisStatus, "done"), isNull(posts.datedAt)))
    .limit(1);

  return NextResponse.json({ today, entries, waiting: Boolean(waiting), finding: datingState() });
}

/** YYYY-MM-DD in this Mac's own time zone, which is the one the dates are in. */
function localDay(at: Date): string {
  const shifted = new Date(at.getTime() - at.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 10);
}

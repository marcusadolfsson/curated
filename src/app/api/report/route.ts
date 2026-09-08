import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";

export const dynamic = "force-dynamic";

/**
 * When posts arrive, by weekday and by hour of the week.
 *
 * Bucketed in SQL in local time - the send date is stored as an epoch, and a
 * UTC bucket would smear evenings into the next day. Only followed
 * conversations count, same as the feed.
 */
export async function GET() {
  const rows = await db.all<{ day: string; hour: string; n: number }>(sql`
    select strftime('%w', posts.sharedAt, 'unixepoch', 'localtime') as day,
           strftime('%H', posts.sharedAt, 'unixepoch', 'localtime') as hour,
           count(*) as n
    from posts
    join threads on threads.threadId = posts.threadId
    where threads.watch = 1 and posts.sharedAt is not null
    group by day, hour
  `);

  const grid: number[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const row of rows) {
    const day = Number(row.day);
    const hour = Number(row.hour);
    if (Number.isInteger(day) && Number.isInteger(hour)) grid[day][hour] = Number(row.n);
  }

  const byWeekday = grid.map((hours) => hours.reduce((sum, n) => sum + n, 0));
  const byHour = Array.from({ length: 24 }, (_, hour) =>
    grid.reduce((sum, day) => sum + day[hour], 0),
  );

  const span = await db.get<{ first: number | null; last: number | null; total: number }>(sql`
    select min(posts.sharedAt) as first, max(posts.sharedAt) as last, count(*) as total
    from posts
    join threads on threads.threadId = posts.threadId
    where threads.watch = 1 and posts.sharedAt is not null
  `);

  return NextResponse.json({
    grid,
    byWeekday,
    byHour,
    total: Number(span?.total ?? 0),
    first: span?.first ? new Date(Number(span.first) * 1000).toISOString() : null,
    last: span?.last ? new Date(Number(span.last) * 1000).toISOString() : null,
    generatedAt: new Date().toISOString(),
  });
}

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { posts } from "@/db/schema";
import { parseDates } from "@/lib/dates";

export const dynamic = "force-dynamic";

/**
 * One date as a calendar file. Opened on a phone or a Mac it offers to add
 * the event to the calendar - an all-day event, or a run of days, with what
 * the post is and a link back to it on Instagram.
 *
 *   /api/upcoming/ics?post=<id>&date=<index>
 */
export async function GET(request: NextRequest) {
  const id = Number(request.nextUrl.searchParams.get("post"));
  const index = Number(request.nextUrl.searchParams.get("date") ?? 0);
  const [post] = await db.select().from(posts).where(eq(posts.id, id)).limit(1);
  const date = post ? parseDates(post.dates)[index] : undefined;
  if (!post || !date) return NextResponse.json({ error: "No such date." }, { status: 404 });

  const day = (iso: string) => iso.replaceAll("-", "");
  // All-day events end on the day after the last one.
  const last = new Date(`${date.end ?? date.start}T00:00:00Z`);
  last.setUTCDate(last.getUTCDate() + 1);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const description = [post.summary, post.permalink].filter(Boolean).join("\n\n");

  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Curated//Upcoming//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:curated-${post.id}-${index}@curated.local`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${day(date.start)}`,
    `DTEND;VALUE=DATE:${day(last.toISOString().slice(0, 10))}`,
    fold(`SUMMARY:${escape(date.label)}`),
    fold(`DESCRIPTION:${escape(description)}`),
    fold(`URL:${post.permalink}`),
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");

  return new NextResponse(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `inline; filename="${slug(date.label)}.ics"`,
    },
  });
}

/** Text as an iCalendar value: backslashes, commas, semicolons and newlines escaped. */
function escape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Lines of at most 75 octets, continued with a leading space, as the format requires. */
function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + (parts.length === 0 ? 75 : 74), bytes.length);
    // Never split a multi-byte character.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    parts.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
  }
  return parts.join("\r\n ");
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "event";
}

import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { posts, threads } from "@/db/schema";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await db.select().from(threads).orderBy(desc(threads.lastItemAt));

  // A face per conversation, taken from the newest post in it that carries
  // one. The threads table has no avatar of its own, and this is the same
  // picture the feed and the modal already show for that person.
  const faces = new Map<string, string>();
  const seen = await db
    .select({ threadId: posts.threadId, avatar: posts.senderAvatarFile })
    .from(posts)
    .orderBy(desc(posts.sharedAt));
  for (const row of seen) {
    if (!row.threadId || !row.avatar || faces.has(row.threadId)) continue;
    faces.set(row.threadId, `/api/media/${row.avatar}`);
  }

  return NextResponse.json({
    threads: rows.map((thread) => ({
      threadId: thread.threadId,
      title: thread.title,
      avatar: faces.get(thread.threadId) ?? null,
      participants: parseParticipants(thread.participants),
      watch: thread.watch,
      lastItemAt: thread.lastItemAt?.toISOString() ?? null,
      postsFound: thread.postsFound,
    })),
  });
}

// PATCH /api/threads - { threadId, watch }
export async function PATCH(request: NextRequest) {
  const { threadId, watch } = (await request.json()) as { threadId?: string; watch?: boolean };
  if (!threadId || typeof watch !== "boolean") {
    return NextResponse.json({ error: "Send { threadId, watch }." }, { status: 400 });
  }

  await db.update(threads).set({ watch }).where(eq(threads.threadId, threadId));
  return NextResponse.json({ threadId, watch });
}

function parseParticipants(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

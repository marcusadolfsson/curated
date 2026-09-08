import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { posts, threads } from "@/db/schema";
import { sendTextReply } from "@/lib/instagram/reply";
import { toPostView } from "@/lib/serialize";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Sends your comment into the thread as a reply quoting this post. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const [post] = await db.select().from(posts).where(eq(posts.id, Number(id))).limit(1);
  if (!post) return NextResponse.json({ error: "No such post." }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as { text?: string };
  const text = body.text?.trim() ?? "";
  if (!text) return NextResponse.json({ error: "Write something first." }, { status: 400 });
  if (text.length > 1000) {
    return NextResponse.json({ error: "Keep it under a thousand characters." }, { status: 400 });
  }

  if (!post.messageId || !post.threadId) {
    return NextResponse.json(
      { error: "This post was imported before message ids were kept; sync once more to pick it up." },
      { status: 409 },
    );
  }

  const [thread] = await db
    .select()
    .from(threads)
    .where(eq(threads.threadId, post.threadId))
    .limit(1);
  if (!thread?.threadV2Id) {
    return NextResponse.json({ error: "This thread has no v2 id yet." }, { status: 409 });
  }

  const outcome = await sendTextReply({
    threadV2Id: thread.threadV2Id,
    text,
    replyToMessageId: post.messageId,
    replyToItemId: post.itemId,
  });

  if (outcome.ok) {
    await db
      .update(posts)
      .set({ replyText: text, repliedAt: new Date() })
      .where(eq(posts.id, post.id));
  }

  const [updated] = await db.select().from(posts).where(eq(posts.id, post.id)).limit(1);
  return NextResponse.json(
    { post: toPostView(updated), error: outcome.ok ? null : outcome.error },
    { status: outcome.ok ? 200 : 502 },
  );
}

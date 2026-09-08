import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { posts } from "@/db/schema";
import { draftReplyFor } from "@/lib/analyze";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Drafts a reply for a post described before drafting existed. Nothing is
 * sent: the text lands in the form for editing.
 */
export async function POST(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const [post] = await db.select().from(posts).where(eq(posts.id, Number(id))).limit(1);
  if (!post) return NextResponse.json({ error: "No such post." }, { status: 404 });

  const draft = await draftReplyFor(post);
  if (!draft) {
    return NextResponse.json({ error: "Could not come up with anything for this one." }, { status: 502 });
  }

  await db.update(posts).set({ draftReply: draft }).where(eq(posts.id, post.id));
  return NextResponse.json({ draft });
}

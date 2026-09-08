import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { posts } from "@/db/schema";
import { reactToPost, unreactToPost } from "@/lib/reactions";
import { getSettings } from "@/lib/settings";
import { toPostView } from "@/lib/serialize";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const [post] = await db.select().from(posts).where(eq(posts.id, Number(id))).limit(1);
  if (!post) return NextResponse.json({ error: "No such post." }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as { emoji?: string };
  const settings = await getSettings();
  const emoji = body.emoji || settings.reactionEmoji;

  const outcome = await reactToPost(post, emoji);
  const [updated] = await db.select().from(posts).where(eq(posts.id, post.id)).limit(1);

  return NextResponse.json(
    { post: toPostView(updated), error: outcome.ok ? null : outcome.error },
    { status: outcome.ok ? 200 : 502 },
  );
}

/** Take the reaction back off. */
export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const [post] = await db.select().from(posts).where(eq(posts.id, Number(id))).limit(1);
  if (!post) return NextResponse.json({ error: "No such post." }, { status: 404 });

  const outcome = await unreactToPost(post);
  const [updated] = await db.select().from(posts).where(eq(posts.id, post.id)).limit(1);

  return NextResponse.json(
    { post: toPostView(updated), error: outcome.ok ? null : outcome.error },
    { status: outcome.ok ? 200 : 502 },
  );
}

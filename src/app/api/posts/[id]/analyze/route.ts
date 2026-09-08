import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { posts } from "@/db/schema";
import { analyzeAndStore } from "@/lib/analyze";
import { toPostView } from "@/lib/serialize";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const [post] = await db.select().from(posts).where(eq(posts.id, Number(id))).limit(1);
  if (!post) return NextResponse.json({ error: "No such post." }, { status: 404 });

  const result = await analyzeAndStore(post);
  const [updated] = await db.select().from(posts).where(eq(posts.id, post.id)).limit(1);

  return NextResponse.json(
    { post: toPostView(updated), error: result.ok ? null : result.error },
    { status: result.ok ? 200 : 502 },
  );
}

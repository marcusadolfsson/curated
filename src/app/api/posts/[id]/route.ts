import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { posts } from "@/db/schema";
import { deleteMedia } from "@/lib/instagram/media";
import { toPostView } from "@/lib/serialize";
import { isCategory } from "@/lib/categories";

export const dynamic = "force-dynamic";

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const postId = Number(id);
  const body = (await request.json()) as { viewed?: boolean; saved?: boolean; category?: string };

  const changes: Partial<typeof posts.$inferInsert> = {};
  if (typeof body.viewed === "boolean") {
    changes.viewed = body.viewed;
    changes.viewedAt = body.viewed ? new Date() : null;
  }
  if (typeof body.saved === "boolean") {
    changes.saved = body.saved;
    changes.savedAt = body.saved ? new Date() : null;
  }
  // The model's guess, corrected by the person who actually knows.
  if (typeof body.category === "string") {
    if (!isCategory(body.category)) {
      return NextResponse.json({ error: "Not one of the categories." }, { status: 400 });
    }
    changes.category = body.category;
  }

  if (Object.keys(changes).length === 0) {
    return NextResponse.json(
      { error: "Send { viewed }, { saved } or { category }." },
      { status: 400 },
    );
  }

  const [updated] = await db.update(posts).set(changes).where(eq(posts.id, postId)).returning();

  if (!updated) return NextResponse.json({ error: "No such post." }, { status: 404 });
  return NextResponse.json(toPostView(updated));
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const postId = Number(id);

  const [removed] = await db.delete(posts).where(eq(posts.id, postId)).returning();
  if (!removed) return NextResponse.json({ error: "No such post." }, { status: 404 });

  deleteMedia(removed.thumbnailFile);
  return NextResponse.json({ deleted: postId });
}

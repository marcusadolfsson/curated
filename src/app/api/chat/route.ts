import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { posts, threads } from "@/db/schema";
import { isSessionKnownDead } from "@/lib/instagram/client";
import { collectMessages, fetchThread } from "@/lib/instagram/dm";
import { sendMessage } from "@/lib/instagram/reply";
import { pauseState } from "@/lib/pause";
import { getSetting } from "@/lib/settings";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The conversation, as it stands right now.
 *
 * The feed is patient on purpose: a post can wait a few minutes because
 * nobody is holding their phone waiting for it. A chat is the opposite. This
 * reads the thread the moment it is asked, and it is asked when the inbox
 * socket says something happened and you are actually looking at it - which
 * is exactly what an open tab does.
 */

async function chosenThread(threadId: string | null) {
  if (threadId) {
    // Named, but still only one you follow: this decides what a chat request
    // may read and send to, so it should not reach a conversation you have
    // not opted into.
    const [named] = await db
      .select()
      .from(threads)
      .where(and(eq(threads.threadId, threadId), eq(threads.watch, true)))
      .limit(1);
    return named ?? null;
  }
  // No thread asked for: the one that spoke most recently, rather than
  // whichever row the database happened to return first. With several
  // followed that was arbitrary, and there was no way to tell which you had
  // been given.
  const watched = await db
    .select()
    .from(threads)
    .where(eq(threads.watch, true))
    .orderBy(desc(threads.lastItemAt));
  return watched[0] ?? null;
}

export async function GET(request: NextRequest) {
  const thread = await chosenThread(request.nextUrl.searchParams.get("threadId"));
  if (!thread) {
    return NextResponse.json({ error: "No conversation is being watched yet." }, { status: 404 });
  }

  const me = (await getSetting("sessionUserId")).trim() || null;
  const base = { threadId: thread.threadId, title: thread.title, me };

  if (isSessionKnownDead()) {
    return NextResponse.json({ ...base, messages: [], error: "Signed out." }, { status: 200 });
  }
  const paused = await pauseState();
  if (paused.paused) {
    return NextResponse.json({ ...base, messages: [], error: "Paused." }, { status: 200 });
  }

  try {
    const { items, users } = await fetchThread(thread.threadId);
    const messages = collectMessages(items);

    // What the app already knows about the posts mentioned, so a share reads
    // as the thing it is rather than a bare link.
    const codes = messages.map((m) => m.shortcode).filter((c): c is string => Boolean(c));
    // Only the posts this page actually mentions. This had no where clause, so
    // every poll - and the page polls every few seconds while you are reading -
    // pulled the whole table across to match a handful of shortcodes.
    const known = codes.length
      ? await db
          .select({
            id: posts.id,
            shortcode: posts.shortcode,
            summary: posts.summary,
            mediaType: posts.mediaType,
            thumbnailFile: posts.thumbnailFile,
          })
          .from(posts)
          .where(inArray(posts.shortcode, codes))
      : [];
    const byCode = new Map(known.map((p) => [p.shortcode, p]));

    return NextResponse.json({
      ...base,
      users,
      messages: messages.map((message) => {
        const post = message.shortcode ? (byCode.get(message.shortcode) ?? null) : null;
        return {
          ...message,
          post: post
            ? {
                id: post.id,
                summary: post.summary,
                mediaType: post.mediaType,
                thumbnail: post.thumbnailFile ? `/api/media/${post.thumbnailFile}` : null,
              }
            : null,
        };
      }),
    });
  } catch (error) {
    return NextResponse.json(
      { ...base, messages: [], error: error instanceof Error ? error.message : String(error) },
      { status: 200 },
    );
  }
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { text?: string; threadId?: string };
  const text = body.text?.trim() ?? "";
  if (!text) return NextResponse.json({ error: "Write something first." }, { status: 400 });
  if (text.length > 1000) {
    return NextResponse.json({ error: "Keep it under a thousand characters." }, { status: 400 });
  }

  const thread = await chosenThread(body.threadId ?? null);
  if (!thread?.threadV2Id) {
    return NextResponse.json({ error: "That conversation has no id to send to yet." }, { status: 409 });
  }

  const outcome = await sendMessage({ threadV2Id: thread.threadV2Id, text });
  return NextResponse.json(
    { ok: outcome.ok, error: outcome.ok ? null : outcome.error },
    { status: outcome.ok ? 200 : 502 },
  );
}

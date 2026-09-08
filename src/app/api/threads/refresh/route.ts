import { NextResponse } from "next/server";
import { db } from "@/db";
import { threads } from "@/db/schema";
import { fetchInbox } from "@/lib/instagram/dm";
import { SessionExpiredError } from "@/lib/instagram/client";
import { asInt, getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Reads the inbox and records the conversations, importing nothing.
 *
 * Without this the conversation list only appeared after a sync, so the first
 * sync had nothing to narrow it to and would import and describe every
 * conversation in the inbox - the expensive way to discover which one you
 * actually wanted.
 */
export async function POST() {
  try {
    const settings = await getSettings();
    const inbox = await fetchInbox(asInt(settings.inboxLimit, 25));

    for (const thread of inbox) {
      await db
        .insert(threads)
        .values({
          threadId: thread.threadId,
          title: thread.title,
          participants: JSON.stringify(thread.users.map((user) => user.username)),
          lastItemAt: thread.lastActivityAt,
        })
        .onConflictDoUpdate({
          target: threads.threadId,
          set: {
            title: thread.title,
            participants: JSON.stringify(thread.users.map((user) => user.username)),
            lastItemAt: thread.lastActivityAt,
          },
        });
    }

    return NextResponse.json({ found: inbox.length });
  } catch (error) {
    const message =
      error instanceof SessionExpiredError
        ? "Instagram signed this session out. Sign in again on this page."
        : error instanceof Error
          ? error.message
          : String(error);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

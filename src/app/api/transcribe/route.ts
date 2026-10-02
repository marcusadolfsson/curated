import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { posts } from "@/db/schema";
import { analysisAvailable } from "@/lib/claude-auth";
import { datePending } from "@/lib/dates";
import { locatePending } from "@/lib/places";
import { analyzeAll } from "@/lib/sync";
import { transcribePending, transcribeState, transcriptionAvailable } from "@/lib/transcribe";

export const dynamic = "force-dynamic";

/** Whether transcription can run, and how far a run has got. */
export async function GET() {
  return NextResponse.json({ available: await transcriptionAvailable(), ...transcribeState() });
}

/**
 * Transcribes every reel whose video is on disk and has not been tried yet.
 * Returns at once; the work runs in the background.
 *
 * Unread reels that turn out to have something said are described again with
 * it, and placed and dated again from the new description - they have not
 * been looked at yet, so the better description is the one that gets read.
 * Reels already read keep theirs; the transcript is still kept and searched.
 */
export async function POST() {
  if (!(await transcriptionAvailable())) {
    return NextResponse.json({ error: "whisper.cpp or its models are not installed." }, { status: 409 });
  }
  if (!transcribeState().running) {
    void (async () => {
      const spoken = await transcribePending();
      if (spoken.length === 0 || !analysisAvailable()) return;
      const unread = await db
        .select()
        .from(posts)
        .where(and(inArray(posts.id, spoken), eq(posts.viewed, false)));
      if (unread.length === 0) return;
      console.log(`[transcribe] describing ${unread.length} unread reel(s) again with what is said in them`);
      await analyzeAll(unread, () => undefined);
      await locatePending();
      await datePending();
    })().catch((error) => console.error("[transcribe] failed:", error));
  }
  return NextResponse.json(transcribeState());
}

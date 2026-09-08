import { NextRequest, NextResponse } from "next/server";
import { getBackfillState, startBackfill, watchedThreads } from "@/lib/backfill";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getBackfillState());
}

// POST /api/threads/backfill - { threadId?, days? }
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { threadId?: string; days?: number };
  const days = Math.min(Math.max(body.days ?? 365, 1), 3650);

  let threadId = body.threadId;
  if (!threadId) {
    const watched = await watchedThreads();
    if (watched.length !== 1) {
      return NextResponse.json(
        { error: "Say which conversation - more than one is being followed." },
        { status: 400 },
      );
    }
    threadId = watched[0].threadId;
  }

  return NextResponse.json(startBackfill(threadId, days));
}

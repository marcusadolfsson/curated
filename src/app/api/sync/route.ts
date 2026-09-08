import { NextResponse } from "next/server";
import { getSyncState, lastRun, startSync } from "@/lib/sync";
import { pauseState } from "@/lib/pause";

export const dynamic = "force-dynamic";

export async function GET() {
  const run = await lastRun();
  return NextResponse.json({
    state: getSyncState(),
    pause: await pauseState(),
    lastRun: run
      ? {
          startedAt: run.startedAt?.toISOString() ?? null,
          finishedAt: run.finishedAt?.toISOString() ?? null,
          status: run.status,
          postsAdded: run.postsAdded,
          error: run.error,
        }
      : null,
  });
}

export async function POST() {
  return NextResponse.json({ state: startSync() });
}

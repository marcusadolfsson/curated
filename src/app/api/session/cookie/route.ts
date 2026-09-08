import { NextRequest, NextResponse } from "next/server";
import { setSessionCookie } from "@/lib/instagram/client";

export const dynamic = "force-dynamic";
import { startWatcher } from "@/lib/watcher";
export const maxDuration = 120;

export async function POST(request: NextRequest) {
  const { sessionId, userId } = (await request.json()) as {
    sessionId?: string;
    userId?: string;
  };

  if (!sessionId?.trim()) {
    return NextResponse.json(
      { status: "failed", message: "Paste the sessionid cookie value." },
      { status: 400 },
    );
  }

  const outcome = await setSessionCookie(sessionId, userId);
  if (outcome.status === "ok") void startWatcher().catch(() => undefined);
  const status = outcome.status === "failed" ? 401 : outcome.status === "unverified" ? 202 : 200;
  return NextResponse.json(outcome, { status });
}

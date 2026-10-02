import { NextResponse } from "next/server";
import { datePending, datingState } from "@/lib/dates";

export const dynamic = "force-dynamic";

/**
 * Reads every described post not yet read for dates. Returns at once; the
 * work runs in the background and GET /api/upcoming reports how far it has
 * got. Sync does the same for new posts, so this is for the backlog.
 */
export async function POST() {
  if (!datingState().running) {
    void datePending().catch((error) => console.error("[dates] failed:", error));
  }
  return NextResponse.json(datingState());
}

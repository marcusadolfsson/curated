import { NextResponse } from "next/server";
import { locatePending, locateState } from "@/lib/places";

export const dynamic = "force-dynamic";

/**
 * Places every travel post still waiting. Returns at once; the work runs in
 * the background and GET /api/travel reports how far it has got. Sync does
 * the same for new posts, so this is for the backlog.
 */
export async function POST() {
  if (!locateState().running) {
    void locatePending().catch((error) => console.error("[places] failed:", error));
  }
  return NextResponse.json(locateState());
}

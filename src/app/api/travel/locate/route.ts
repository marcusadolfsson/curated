import { NextResponse } from "next/server";
import { consolidateRegions, fillCities, fillCoordinates, locatePending, locateState } from "@/lib/places";

export const dynamic = "force-dynamic";

/**
 * Places every travel post still waiting. Returns at once; the work runs in
 * the background and GET /api/travel reports how far it has got. Sync does
 * the same for new posts, so this is for the backlog.
 */
export async function POST() {
  if (!locateState().running) {
    // Placing tidies the regions itself when it placed anything; with nothing
    // left to place, a call here still tidies, for a list placed before that.
    void locatePending()
      .then(async (result) => {
        if (result.checked === 0) {
          await consolidateRegions();
          await fillCities();
          await fillCoordinates();
        }
      })
      .catch((error) => console.error("[places] failed:", error));
  }
  return NextResponse.json(locateState());
}

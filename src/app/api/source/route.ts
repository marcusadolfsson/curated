import { NextRequest, NextResponse } from "next/server";
import { forgetSourceCache, health, usingApi } from "@/lib/instagram/api";
import { closeBrowser } from "@/lib/instagram/client";
import { getSetting, setSettings } from "@/lib/settings";
import { getSyncState } from "@/lib/sync";
import { getWatcherState, startWatcher, stopWatcher } from "@/lib/watcher";

export const dynamic = "force-dynamic";

/**
 * Which way Curated reads Instagram: its own browser, or the API on Muse.
 *
 * A route of its own rather than one more setting, because changing it is
 * not just a value. The account must never have both reading at once, so the
 * old side is stopped - the browser closed, not merely idle - before the new
 * one starts, and never in the middle of a sync, which would be reading
 * through the side being taken away.
 */
export async function GET() {
  return NextResponse.json({
    source: (await usingApi()) ? "api" : "browser",
    api: await health(),
    watcher: getWatcherState(),
  });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { source?: string };
  const wanted = body.source;
  if (wanted !== "api" && wanted !== "browser") {
    return NextResponse.json({ error: 'source must be "api" or "browser".' }, { status: 400 });
  }
  if (getSyncState().running) {
    return NextResponse.json({ error: "A sync is running. Switch when it finishes." }, { status: 409 });
  }
  if ((await getSetting("instagramSource")) === wanted) {
    return NextResponse.json({ source: wanted, changed: false, watcher: getWatcherState() });
  }
  if (wanted === "api" && !(await health()).ok) {
    return NextResponse.json(
      { error: "The Instagram API is not answering, so switching to it would leave nothing reading." },
      { status: 503 },
    );
  }

  // The old side first, completely. Stopping the watcher while the source
  // still says the old value stops the one that is actually running.
  await stopWatcher();
  if (wanted === "api") await closeBrowser();

  await setSettings({ instagramSource: wanted });
  forgetSourceCache();
  console.log(`[source] ${new Date().toISOString()} Instagram is now read through the ${wanted}`);

  const watcher = await startWatcher();
  return NextResponse.json({ source: wanted, changed: true, watcher });
}

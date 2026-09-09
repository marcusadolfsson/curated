/**
 * Runs once when the server starts. The realtime watcher has to be alive
 * before anyone opens the app, or the first post of the day waits for the
 * hourly timer.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { startWatcher } = await import("@/lib/watcher");
  const { closeBrowser } = await import("@/lib/instagram/client");
  const { pruneWatchedMedia, shrinkThumbnails } = await import("@/lib/prune");

  // Give the server a moment to finish booting before opening a browser.
  setTimeout(() => {
    void startWatcher().catch((error) => console.error("[watcher] failed to start:", error));
  }, 5_000).unref?.();

  // Reels and photo galleries are dropped from the cache a day after the post
  // is read. Nothing waits on this, so it runs behind the boot and then a few
  // times a day.
  const prune = () =>
    void pruneWatchedMedia()
      .then(() => shrinkThumbnails())
      .catch((error) => console.error("[prune] failed:", error));
  setTimeout(prune, 30_000).unref?.();
  setInterval(prune, 6 * 3600_000).unref?.();

  // Best effort, and only that: Next takes the same signal and ends the
  // process before closeBrowser's first await comes back, so this rarely
  // finishes. What actually keeps the cookies on disk is the timer in
  // ./lib/instagram/client - see SAVE_EVERY_MS. Left in because when it does
  // get to run it closes the browser tidily.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void closeBrowser().finally(() => process.exit(0));
    });
  }
}

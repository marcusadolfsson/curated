/**
 * Runs once when the server starts. The realtime watcher has to be alive
 * before anyone opens the app, or the first post of the day waits for the
 * next manual check.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { startWatcher } = await import("@/lib/watcher");
  const { pruneWatchedMedia, shrinkThumbnails } = await import("@/lib/prune");

  // Give the server a moment to finish booting before it starts listening.
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
}

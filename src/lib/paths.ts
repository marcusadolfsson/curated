import fs from "node:fs";
import path from "node:path";

/** Everything the app writes lives under DATA_DIR so a single volume persists it. */
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(process.cwd(), "data");

export const DB_PATH = path.join(DATA_DIR, "insta.db");
export const MEDIA_DIR = path.join(DATA_DIR, "media");
export const SESSION_DIR = path.join(DATA_DIR, "session");
/**
 * Chromium's own profile directory.
 *
 * Not the same thing as the session file beside it. That holds cookies; this
 * holds everything else a browser accumulates about a place it visits often -
 * history, cache, device state, the local storage Instagram writes. Playwright
 * used to hand Chromium a temporary profile that was wiped on exit, so every
 * restart presented a browser that had never been anywhere, wearing the
 * previous one's cookies. Keeping the profile makes it one browser over time.
 *
 * It holds live credentials, so it is owner-only like the session dir.
 */
export const PROFILE_DIR = path.join(DATA_DIR, "browser");
export const STORAGE_STATE_PATH = path.join(SESSION_DIR, "instagram.json");

export function ensureDirs() {
  for (const dir of [DATA_DIR, MEDIA_DIR, SESSION_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // The session file holds live Instagram cookies - keep it owner-only.
  fs.chmodSync(SESSION_DIR, 0o700);
}

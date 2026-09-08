import fs from "node:fs";
import path from "node:path";
import { and, eq, isNotNull, isNull, lt, or } from "drizzle-orm";
import { db } from "@/db";
import { posts } from "@/db/schema";
import {
  THUMBNAIL_MAX_EDGE,
  deleteMedia,
  encodeThumbnail,
  mediaPath,
} from "@/lib/instagram/media";

/**
 * Throwing away what you have already looked at.
 *
 * Reels are a few megabytes each and photo galleries a few hundred kilobytes,
 * and they arrive daily; kept for ever they grow without limit. Once a post has
 * been read the files have done their job, so they go a day later - long enough
 * to open the post again that evening, or the next morning, without a wait.
 *
 * Saved posts keep theirs. Saving one is a request to keep it.
 *
 * Nothing is lost: the row keeps its shortcode and media id, so opening the
 * post again fetches the files back on demand.
 *
 * Thumbnails are deliberately NOT pruned. They are what the feed itself shows,
 * there is no path that re-fetches one for a row, and doing it would mean an
 * Instagram request per post while scrolling - the shape of traffic this app
 * exists to avoid.
 */

const KEEP_AFTER_READ_MS = 24 * 3600_000;

type CachedImage = { file?: unknown };

function imageFiles(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return (parsed as CachedImage[])
      .map((image) => image?.file)
      .filter((file): file is string => typeof file === "string");
  } catch {
    return [];
  }
}

export async function pruneWatchedMedia(): Promise<{ videos: number; photos: number }> {
  const cutoff = new Date(Date.now() - KEEP_AFTER_READ_MS);

  const stale = await db
    .select({ id: posts.id, videoFile: posts.videoFile, images: posts.images })
    .from(posts)
    .where(
      and(
        eq(posts.viewed, true),
        eq(posts.saved, false),
        // A read post with no timestamp was read before the app recorded one:
        // old by definition.
        or(lt(posts.viewedAt, cutoff), isNull(posts.viewedAt)),
        or(isNotNull(posts.videoFile), isNotNull(posts.images)),
      ),
    );

  let videos = 0;
  let photos = 0;

  for (const post of stale) {
    if (post.videoFile) {
      deleteMedia(post.videoFile);
      videos += 1;
    }
    for (const file of imageFiles(post.images)) {
      deleteMedia(file);
      photos += 1;
    }
    await db.update(posts).set({ videoFile: null, images: null }).where(eq(posts.id, post.id));
  }

  if (videos > 0 || photos > 0) {
    console.log(`[prune] removed ${videos} reel(s) and ${photos} photo(s) from the cache`);
  }
  return { videos, photos };
}

/**
 * Bringing the covers already on disk down to the size new ones arrive at.
 *
 * A thumbnail is not pruned - it is what the feed shows, and nothing re-fetches
 * one for a row - but it does not need to be a 1080px original either. This
 * walks the collection once and re-encodes anything still oversized. It is
 * local work: no request to Instagram, and the picture is the same picture.
 *
 * Idempotent, because a file it has already handled is within the limit and
 * gets skipped on the next pass.
 */

/** Anything wider or heavier than this has not been through here yet. */
const SHRINK_ABOVE_BYTES = 200 * 1024;

export async function shrinkThumbnails(limit = 2000): Promise<{ count: number; savedBytes: number }> {
  const rows = await db
    .select({ id: posts.id, thumbnailFile: posts.thumbnailFile })
    .from(posts)
    .where(isNotNull(posts.thumbnailFile));

  let count = 0;
  let savedBytes = 0;

  for (const row of rows) {
    if (count >= limit) break;

    const file = row.thumbnailFile;
    if (!file) continue;
    const current = mediaPath(file);
    if (!fs.existsSync(current)) continue;

    const before = fs.statSync(current).size;
    const isJpeg = path.extname(file).toLowerCase() === ".jpg";

    let oversized = before > SHRINK_ABOVE_BYTES || !isJpeg;
    if (!oversized) {
      const { default: sharp } = await import("sharp");
      const meta = await sharp(current).metadata().catch(() => null);
      if (!meta) continue;
      oversized =
        (meta.width ?? 0) > THUMBNAIL_MAX_EDGE || (meta.height ?? 0) > THUMBNAIL_MAX_EDGE;
    }
    if (!oversized) continue;

    try {
      const shrunk = await encodeThumbnail(await fs.promises.readFile(current));
      // A file that would grow is left as it is; re-encoding it again next pass
      // would only lose more detail for nothing.
      if (shrunk.length >= before && isJpeg) continue;

      // The original cannot be fetched again - its CDN link expired hours after
      // it arrived - so nothing is overwritten until the replacement is known
      // to be a readable image.
      const { default: sharp } = await import("sharp");
      const check = await sharp(shrunk).metadata().catch(() => null);
      if (!check?.width || !check?.height) {
        console.warn(`[prune] re-encoded ${file} did not read back; left alone`);
        continue;
      }

      const target = `${path.basename(file, path.extname(file))}.jpg`;
      await fs.promises.writeFile(mediaPath(target), shrunk);

      if (target !== file) {
        deleteMedia(file);
        await db.update(posts).set({ thumbnailFile: target }).where(eq(posts.id, row.id));
      }

      count += 1;
      savedBytes += before - shrunk.length;
    } catch (error) {
      console.warn(`[prune] could not shrink ${file}:`, error);
    }
  }

  if (count > 0) {
    console.log(
      `[prune] shrank ${count} cover(s), freeing ${(savedBytes / 1048576).toFixed(1)}MB`,
    );
  }
  return { count, savedBytes };
}

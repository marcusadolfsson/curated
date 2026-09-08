import fs from "node:fs";
import path from "node:path";
import { MEDIA_DIR, ensureDirs } from "@/lib/paths";
import { igFetch } from "./tab";

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/heic": ".heic",
};

/**
 * How big a cover is kept.
 *
 * Instagram hands over a 1080px original, around 240KB. The feed shows it a
 * couple of hundred pixels wide; the viewer uses it as a poster behind a reel
 * and as the picture itself for a post with nothing else attached. Nine
 * hundred pixels covers the largest of those on a phone, and at that size the
 * files come out roughly a tenth of the weight with nothing visible lost.
 */
export const THUMBNAIL_MAX_EDGE = 900;
const THUMBNAIL_QUALITY = 80;

export async function encodeThumbnail(input: Buffer): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp(input)
    .rotate() // honour EXIF orientation before it is stripped
    .resize({
      width: THUMBNAIL_MAX_EDGE,
      height: THUMBNAIL_MAX_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: THUMBNAIL_QUALITY, mozjpeg: true, progressive: true })
    .toBuffer();
}

/**
 * Instagram's CDN URLs are signed and expire within hours, so the thumbnail is
 * copied locally: it keeps the feed from filling with broken images, and gives
 * the analysis agent a file it can actually read.
 */
export async function downloadThumbnail(
  shortcode: string,
  url: string | null,
): Promise<string | null> {
  if (!url) return null;
  ensureDirs();

  const response = await igFetch(url);
  if (!response.ok) return null;

  // Re-encoded on the way in, so the big original is never on disk at all.
  // If that fails the original is kept rather than losing the cover.
  let data = response.body;
  let filename = `${shortcode}.jpg`;
  try {
    data = await encodeThumbnail(response.body);
  } catch (error) {
    const contentType = (response.headers["content-type"] ?? "").split(";")[0].trim();
    filename = `${shortcode}${EXTENSIONS[contentType] ?? ".jpg"}`;
    console.warn(`[media] kept the original cover for ${shortcode}:`, error);
  }

  await fs.promises.writeFile(path.join(MEDIA_DIR, filename), data);
  return filename;
}

export function mediaPath(filename: string): string {
  return path.join(MEDIA_DIR, filename);
}

export function mediaExists(filename: string | null): boolean {
  return Boolean(filename) && fs.existsSync(path.join(MEDIA_DIR, filename as string));
}

export function deleteMedia(filename: string | null) {
  if (!filename) return;
  const target = path.join(MEDIA_DIR, filename);
  if (fs.existsSync(target)) fs.rmSync(target);
}

import fs from "node:fs";
import path from "node:path";
import { MEDIA_DIR, ensureDirs } from "@/lib/paths";
import { postImages, postVideo } from "./api";

/**
 * Every image in a post, and a reel's video, kept next to the thumbnails.
 *
 * The share in a DM carries nothing but its link. The API looks the post up
 * without the account and hands back signed CDN links - every entry of a
 * carousel at full size, or a reel's mp4 - and the files come straight off
 * the CDN, which serves whoever holds the link. Fetched once and kept, so
 * looking at a post again costs nothing and keeps working after the links
 * expire.
 */

export type GalleryImage = { file: string; width: number; height: number };
export type GalleryVideo = { file: string; width: number; height: number; duration: number };

/**
 * The photos of a post. Video entries in a carousel are skipped rather than
 * shown as a still that pretends to be the post.
 */
export async function fetchGallery(shortcode: string): Promise<GalleryImage[]> {
  ensureDirs();
  const items = await postImages(`https://www.instagram.com/p/${shortcode}/`);
  if (!items) return [];

  const images: GalleryImage[] = [];
  for (const [index, item] of items.entries()) {
    if (item.type !== "image") continue;
    const file = `${shortcode}-${index + 1}.jpg`;
    if (!(await keep(item.url, file, 60_000))) continue;
    images.push({ file, width: item.width, height: item.height });
  }
  return images;
}

/** A reel's video. Null for a post with none, or one Instagram withholds. */
export async function fetchVideo(shortcode: string): Promise<GalleryVideo | null> {
  ensureDirs();
  const file = `${shortcode}.mp4`;
  if (!fs.existsSync(path.join(MEDIA_DIR, file))) {
    const url = await postVideo(`https://www.instagram.com/reel/${shortcode}/`);
    if (!url || !(await keep(url, file, 180_000))) return null;
  }
  // The player reads the size and length off the file itself.
  return { file, width: 0, height: 0, duration: 0 };
}

/**
 * Downloads a CDN link into the media folder, whole or not at all: written to
 * a side file and renamed, so a half-written one can never read as cached.
 */
async function keep(url: string, file: string, timeoutMs: number): Promise<boolean> {
  const target = path.join(MEDIA_DIR, file);
  if (fs.existsSync(target)) return true;
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) }).catch(() => null);
  if (!response?.ok) return false;
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length === 0) return false;
  await fs.promises.writeFile(`${target}.part`, body);
  await fs.promises.rename(`${target}.part`, target);
  return true;
}

export function videoIsCached(file: string | null): boolean {
  return Boolean(file) && fs.existsSync(path.join(MEDIA_DIR, file as string));
}

/** True when every file we recorded is still on disk. */
export function galleryIsCached(images: GalleryImage[]): boolean {
  return images.length > 0 && images.every((i) => fs.existsSync(path.join(MEDIA_DIR, i.file)));
}

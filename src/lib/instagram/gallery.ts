import fs from "node:fs";
import path from "node:path";
import { MEDIA_DIR, ensureDirs } from "@/lib/paths";
import { igFetch, igJson } from "./tab";

/**
 * Every image in a post, not just the one that came in the message.
 *
 * The DM payload carries a single still - the cover. For a carousel that is
 * image one of five, which is no use when you are looking at image three and
 * want to keep it. The media endpoint returns the lot, at full size, so they
 * are fetched once and cached next to the thumbnails.
 */

export type GalleryImage = { file: string; width: number; height: number };
export type GalleryVideo = { file: string; width: number; height: number; duration: number };

type Candidate = { url?: string; width?: number; height?: number };
type VideoVersion = { url?: string; width?: number; height?: number; type?: number };

export type MediaNode = {
  media_type?: number;
  video_duration?: number;
  image_versions2?: { candidates?: Candidate[] };
  carousel_media?: MediaNode[];
  video_versions?: VideoVersion[];
  caption?: { text?: string } | null;
  user?: { username?: string };
};

/**
 * Everything Instagram knows about one post, the way the web client asks for it.
 *
 * Held briefly, because more than one caller wants it for the same post within
 * moments: importing a share with no thumbnail attached looks the post up, and
 * then fetching its reel looks the same post up again. Two identical requests
 * seconds apart are a small oddity, and the answer cannot have changed. Kept
 * only for minutes, since the URLs inside expire within hours.
 */
const INFO_MEMO_MS = 5 * 60_000;
const INFO_MEMO_MAX = 200;
const infoMemo = new Map<string, { at: number; item: MediaNode | null }>();

export async function fetchMediaInfo(mediaId: string): Promise<MediaNode | null> {
  const held = infoMemo.get(mediaId);
  if (held && Date.now() - held.at < INFO_MEMO_MS) return held.item;

  const data = await igJson<{ items?: MediaNode[] }>(`/api/v1/media/${mediaId}/info/`);
  const item = data.items?.[0] ?? null;

  if (infoMemo.size >= INFO_MEMO_MAX) {
    const oldest = infoMemo.keys().next();
    if (!oldest.done) infoMemo.delete(oldest.value);
  }
  infoMemo.set(mediaId, { at: Date.now(), item });
  return item;
}

export async function fetchGallery(shortcode: string, mediaId: string): Promise<GalleryImage[]> {
  ensureDirs();

  const item = await fetchMediaInfo(mediaId);
  if (!item) return [];

  const parts = item.carousel_media?.length ? item.carousel_media : [item];
  const images: GalleryImage[] = [];

  for (const [index, part] of parts.entries()) {
    // A carousel can mix video in; we cannot play those, so skip them rather
    // than show a still that pretends to be the post.
    if (part.video_versions?.length) continue;

    const best = largest(part.image_versions2?.candidates ?? []);
    if (!best?.url) continue;

    const file = `${shortcode}-${index + 1}.jpg`;
    const target = path.join(MEDIA_DIR, file);

    if (!fs.existsSync(target)) {
      const response = await igFetch(best.url);
      if (!response.ok) continue;
      await fs.promises.writeFile(target, response.body);
    }

    images.push({ file, width: best.width ?? 0, height: best.height ?? 0 });
  }

  return images;
}

/**
 * The reel itself.
 *
 * Instagram's embed will not play a reel - it shows a cover and a button that
 * leaves. The file behind it is an ordinary mp4 though, and the media endpoint
 * hands over the URL, so it can be fetched once and played here like any other
 * video.
 */
export async function fetchVideo(shortcode: string, mediaId: string): Promise<GalleryVideo | null> {
  ensureDirs();

  const item = await fetchMediaInfo(mediaId);
  const versions = item?.video_versions ?? [];
  if (versions.length === 0) return null;

  const best = phoneSized(versions);
  if (!best?.url) return null;

  const file = `${shortcode}.mp4`;
  const target = path.join(MEDIA_DIR, file);

  if (!fs.existsSync(target)) {
    const response = await igFetch(best.url);
    if (!response.ok) return null;
    await fs.promises.writeFile(target, response.body);
  }

  return {
    file,
    width: best.width ?? 0,
    height: best.height ?? 0,
    duration: item?.video_duration ?? 0,
  };
}

/**
 * The rendition worth fetching. Instagram offers the same clip at 1080, 720
 * and 480 wide; the widest is roughly twice the bytes of the 720 one and
 * looks the same in a modal on a phone, which is where these get watched.
 * The time before a reel starts is mostly the time to move its bytes -
 * from the CDN into the cache, then from here to the phone - so this is the
 * single biggest lever on it.
 */
const PREFERRED_MAX_WIDTH = 720;

function phoneSized(versions: VideoVersion[]): VideoVersion | null {
  const usable = versions.filter((version) => version.url);
  if (usable.length === 0) return null;
  const fitting = usable.filter((version) => (version.width ?? Infinity) <= PREFERRED_MAX_WIDTH);
  const pool = fitting.length > 0 ? fitting : usable;
  // Largest of those that fit; if none fit, the smallest there is.
  return pool.reduce((chosen, version) =>
    fitting.length > 0
      ? (version.width ?? 0) > (chosen.width ?? 0) ? version : chosen
      : (version.width ?? Infinity) < (chosen.width ?? Infinity) ? version : chosen,
  );
}

export function videoIsCached(file: string | null): boolean {
  return Boolean(file) && fs.existsSync(path.join(MEDIA_DIR, file as string));
}

export function largest(candidates: Candidate[]): Candidate | null {
  let best: Candidate | null = null;
  for (const candidate of candidates) {
    if (!candidate.url) continue;
    if (!best || (candidate.width ?? 0) > (best.width ?? 0)) best = candidate;
  }
  return best;
}

/** True when every file we recorded is still on disk. */
export function galleryIsCached(images: GalleryImage[]): boolean {
  return images.length > 0 && images.every((i) => fs.existsSync(path.join(MEDIA_DIR, i.file)));
}

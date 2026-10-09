import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { posts } from "@/db/schema";
import { analyzeAndStore } from "@/lib/analyze";
import { analysisAvailable } from "@/lib/claude-auth";
import { coverMissing, fillPreview } from "@/lib/instagram/preview";
import { asBool, getSetting } from "@/lib/settings";
import {
  fetchGallery,
  fetchVideo,
  galleryIsCached,
  videoIsCached,
  type GalleryImage,
} from "@/lib/instagram/gallery";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Every image in a post. Fetched from Instagram the first time and kept, so
 * looking at the same post again costs nothing and keeps working after the
 * CDN links expire.
 */
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const [found] = await db.select().from(posts).where(eq(posts.id, Number(id))).limit(1);
  if (!found) return NextResponse.json({ error: "No such post." }, { status: 404 });

  // A post that arrived while the cover lookup was failing is blank until a
  // sync comes along, which can be days. Being opened is reason enough to
  // look again - once, now - and to describe it once there is something to go on.
  let post = found;
  if (coverMissing(found)) {
    const filled = await fillPreview(found).catch(() => null);
    if (filled) {
      post = filled;
      if (post.analysisStatus === "pending" && asBool(await getSetting("autoAnalyze")) && analysisAvailable()) {
        void analyzeAndStore(post).catch((error) => console.error(`[gallery] describing ${post.shortcode}:`, error));
      }
    }
  }

  // A reel: the mp4 itself, which Instagram's embed refuses to play.
  if (post.mediaType === "reel" || post.mediaType === "tv") {
    if (videoIsCached(post.videoFile)) {
      return NextResponse.json({ video: `/api/media/${post.videoFile}`, images: [] });
    }
    try {
      const video = await fetchVideo(post.shortcode);
      if (video) {
        await db.update(posts).set({ videoFile: video.file }).where(eq(posts.id, post.id));
        return NextResponse.json({ video: `/api/media/${video.file}`, images: [] });
      }
    } catch (error) {
      console.error(`[gallery] could not fetch the video for ${post.shortcode}:`, error);
    }
    // None to be had - a photo mislabelled, a video Instagram withholds: the
    // viewer shows the cover and a way out to Instagram, not a failure.
    return NextResponse.json({ video: null, images: [], reason: "api" });
  }

  const cached = parse(post.images);
  if (galleryIsCached(cached)) return NextResponse.json({ images: serve(cached) });

  const cover = post.thumbnailFile ? [{ url: `/api/media/${post.thumbnailFile}` }] : [];
  try {
    const images = await fetchGallery(post.shortcode);
    if (images.length === 0) return NextResponse.json({ images: cover });
    await db.update(posts).set({ images: JSON.stringify(images) }).where(eq(posts.id, post.id));
    return NextResponse.json({ images: serve(images) });
  } catch (error) {
    console.error(`[gallery] could not fetch images for ${post.shortcode}:`, error);
    return NextResponse.json({ images: cover, error: error instanceof Error ? error.message : String(error) });
  }
}

function parse(value: string | null): GalleryImage[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as GalleryImage[]) : [];
  } catch {
    return [];
  }
}

function serve(images: GalleryImage[]) {
  return images.map((image) => ({
    url: `/api/media/${image.file}`,
    width: image.width,
    height: image.height,
  }));
}

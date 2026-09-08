import { mediaIdFromShortcode } from "./dm";
import { SessionExpiredError } from "./errors";
import { fetchMediaInfo, largest } from "./gallery";

export type PostPreview = {
  mediaId: string | null;
  imageUrl: string | null;
  caption: string | null;
  authorUsername: string | null;
};

const EMPTY: PostPreview = { mediaId: null, imageUrl: null, caption: null, authorUsername: null };

/**
 * Some shares arrive as a bare link with no media attached - a pasted URL, or a
 * preview card Instagram did not fill in. The shortcode in the link decodes to
 * the media id, and the media endpoint - the one the web client calls for any
 * post - gives back the cover, the caption and the author. Nothing is scraped
 * off a post page, which no real client fetches as XHR.
 */
export async function fetchPostPreview(
  shortcode: string,
  knownMediaId?: string | null,
): Promise<PostPreview> {
  const mediaId = knownMediaId ?? mediaIdFromShortcode(shortcode);
  if (!mediaId) return EMPTY;

  try {
    const item = await fetchMediaInfo(mediaId);
    if (!item) return { ...EMPTY, mediaId };

    const cover = item.carousel_media?.[0] ?? item;
    return {
      mediaId,
      imageUrl: largest(cover.image_versions2?.candidates ?? [])?.url ?? null,
      caption: item.caption?.text?.trim() || null,
      authorUsername: item.user?.username ?? null,
    };
  } catch (error) {
    if (error instanceof SessionExpiredError) throw error;
    return { ...EMPTY, mediaId };
  }
}

import { ApiUnavailableError, postByUrl } from "./api";
import { RateLimitedError } from "./errors";

export type PostPreview = {
  mediaId: string | null;
  imageUrl: string | null;
  caption: string | null;
  authorUsername: string | null;
};

const EMPTY: PostPreview = { mediaId: null, imageUrl: null, caption: null, authorUsername: null };

/**
 * A shared post's cover, caption and author, from its link.
 *
 * Every share arrives as a bare link, so this is how every post gets what the
 * feed and the description need: the API resolves the link through
 * Instagram's public oEmbed lookup, without the account, and caches it for a
 * day. A deleted or private post comes back empty rather than failing a sync.
 */
export async function fetchPostPreview(shortcode: string, knownMediaId?: string | null): Promise<PostPreview> {
  const post = await postByUrl(`https://www.instagram.com/p/${shortcode}/`);
  return post ? { ...post, mediaId: post.mediaId ?? knownMediaId ?? null } : EMPTY;
}

/**
 * The same, but a lookup that fell over for this one post gives null instead
 * of an error. Instagram's oEmbed does now and then (a 502, a truncated
 * reply), and letting that through cost a whole thread its sync: the share
 * never reached the feed, and the listener, having moved past the message,
 * had no reason to look again. The post goes in without a cover instead, and
 * the cover is looked up once more before the post is described.
 *
 * A rate limit or the API being down still stops the sync - those are about
 * everything, not this post.
 */
export async function previewOrNull(shortcode: string, knownMediaId?: string | null): Promise<PostPreview | null> {
  try {
    return await fetchPostPreview(shortcode, knownMediaId);
  } catch (error) {
    if (error instanceof RateLimitedError || error instanceof ApiUnavailableError) throw error;
    console.warn(`[preview] ${shortcode}: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

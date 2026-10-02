import { postByUrl } from "./api";

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

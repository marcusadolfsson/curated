import type { Post } from "@/db/schema";

export type PostView = {
  id: number;
  shortcode: string;
  permalink: string;
  mediaType: Post["mediaType"];
  caption: string | null;
  messageText: string | null;
  authorUsername: string | null;
  thumbnail: string | null;
  /** The reel itself, when it has already been fetched; lets the player start inside the tap that opened it. */
  video: string | null;
  /** The app already holds what this post needs to show, so opening it costs nothing. */
  mediaReady: boolean;
  senderUsername: string | null;
  senderAvatar: string | null;
  sharedAt: string | null;
  viewed: boolean;
  saved: boolean;
  reactedAt: string | null;
  reactionEmoji: string | null;
  suggestedReaction: string | null;
  replyText: string | null;
  draftReply: string | null;
  repliedAt: string | null;
  reactionError: string | null;
  analysisStatus: Post["analysisStatus"];
  category: string | null;
  summary: string | null;
  items: string[];
  analysisError: string | null;
};

export function toPostView(post: Post): PostView {
  return {
    id: post.id,
    shortcode: post.shortcode,
    permalink: post.permalink,
    mediaType: post.mediaType,
    caption: post.caption,
    messageText: post.messageText,
    authorUsername: post.authorUsername,
    thumbnail: post.thumbnailFile ? `/api/media/${post.thumbnailFile}` : null,
    video: post.videoFile ? `/api/media/${post.videoFile}` : null,
    mediaReady:
      post.mediaType === "reel" || post.mediaType === "tv"
        ? post.videoFile !== null
        : // A photo post with nothing to ask Instagram for shows its own cover.
          post.images !== null || post.mediaId === null,
    senderUsername: post.senderUsername,
    senderAvatar: post.senderAvatarFile ? `/api/media/${post.senderAvatarFile}` : null,
    sharedAt: (post.sharedAt ?? post.createdAt)?.toISOString() ?? null,
    viewed: post.viewed,
    saved: post.saved,
    reactedAt: post.reactedAt?.toISOString() ?? null,
    reactionEmoji: post.reactionEmoji,
    suggestedReaction: post.suggestedReaction,
    replyText: post.replyText,
    draftReply: post.draftReply,
    repliedAt: post.repliedAt?.toISOString() ?? null,
    reactionError: post.reactionError,
    analysisStatus: post.analysisStatus,
    category: post.category,
    summary: post.summary,
    items: parseItems(post.items),
    analysisError: post.analysisError,
  };
}

function parseItems(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((i): i is string => typeof i === "string") : [];
  } catch {
    return [];
  }
}

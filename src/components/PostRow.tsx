"use client";

import { useState } from "react";
import { BookmarkIcon } from "./icons";
import { CATEGORY_HUE, isCategory } from "@/lib/categories";
import { relativeTime } from "@/lib/time";
import type { PostView } from "@/lib/serialize";

type Props = {
  post: PostView;
  onToggleSaved: (id: number, saved: boolean) => Promise<void>;
  onPreview: (post: PostView) => void;
};

export default function PostRow({
  post,
  onToggleSaved,
  onPreview,
}: Props) {
  const [busy, setBusy] = useState<null | "save">(null);

  const hue = isCategory(post.category) ? CATEGORY_HUE[post.category] : 220;
  const read = post.viewed;
  // A reel gets a play badge on its thumbnail; both it and the summary open the post.
  const isVideo = post.mediaType === "reel" || post.mediaType === "tv";

  const run = async (kind: "save", action: () => Promise<void>) => {
    setBusy(kind);
    try {
      await action();
    } finally {
      setBusy(null);
    }
  };

  return (
    <article
      style={{ ["--hue" as string]: hue }}
      className={`group relative flex gap-4 border-b border-line py-5 pl-5 pr-1 transition-colors duration-500 sm:gap-5 sm:pl-6 ${
        read ? "bg-transparent" : "bg-surface"
      }`}
    >
      <span
        aria-hidden
        className={`spine absolute top-0 bottom-0 left-0 w-[3px] transition-opacity duration-500 ${
          read ? "opacity-25" : "opacity-100"
        }`}
      />

      <Thumbnail post={post} read={read} isVideo={isVideo} onPreview={onPreview} />

      <div className="min-w-0 flex-1">
        {post.summary ? (
          <button
            type="button"
            onClick={() => onPreview(post)}
            className={`block max-w-[62ch] text-left font-serif text-[17px] leading-relaxed hover:underline hover:decoration-line hover:underline-offset-4 ${
              read ? "text-muted" : "text-ink"
            }`}
          >
            {post.summary}
          </button>
        ) : (
          // Nothing written about it yet, so the post's own caption stands in -
          // clamped rather than cut mid-sentence, and in the caption's voice so
          // it does not read as something we wrote.
          <button
            type="button"
            onClick={() => onPreview(post)}
            className={`line-clamp-4 max-w-[62ch] text-left font-serif text-[16px] leading-relaxed hover:underline hover:decoration-line hover:underline-offset-4 ${
              read ? "text-muted" : "text-ink-soft"
            }`}
          >
            {post.caption?.trim() || placeholderFor(post)}
          </button>
        )}

        {post.items.length > 0 && (
          <p className="mt-1.5 max-w-[62ch] font-serif text-[15px] italic text-muted">
            {post.items.join(", ")}
          </p>
        )}

        {post.messageText && (
          <p className="mt-2 max-w-[58ch] border-l border-line pl-3 font-serif text-[15px] text-ink-soft">
            {post.messageText}
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]">
          <span className="flex items-center gap-1.5 text-ink-soft">
            <span aria-hidden className="dot h-2 w-2 rounded-full" />
            {post.category ?? statusLabel(post)}
          </span>
          {post.mediaType === "reel" && <span className="text-muted">reel</span>}
          <span className="text-muted">
            {post.senderUsername ? `from ${post.senderUsername}` : "shared with you"}
          </span>
          <time className="text-muted">{relativeTime(post.sharedAt)}</time>
          {post.reactedAt && (
            <span title={`Reacted ${relativeTime(post.reactedAt)}`}>{post.reactionEmoji}</span>
          )}

          <div className="flex items-center pr-3 sm:ml-auto">
            <button
              type="button"
              onClick={() => run("save", () => onToggleSaved(post.id, !post.saved))}
              disabled={busy !== null}
              aria-label={post.saved ? "Remove from saved" : "Save"}
              aria-pressed={post.saved}
              title={post.saved ? "Saved" : "Save"}
              className="group flex items-center text-accent disabled:opacity-50"
            >
              <BookmarkIcon filled={post.saved} />
            </button>
          </div>
        </div>

        {post.reactionError && (
          <p className="mt-2 max-w-[62ch] text-[13px] text-danger">
            Reaction did not send: {post.reactionError}
          </p>
        )}

        {post.analysisStatus === "error" && post.analysisError && (
          <p className="mt-2 max-w-[62ch] text-[13px] text-danger">
            Could not describe this one: {post.analysisError}
          </p>
        )}
      </div>
    </article>
  );
}

function Thumbnail({
  post,
  read,
  isVideo,
  onPreview,
}: {
  post: PostView;
  read: boolean;
  isVideo: boolean;
  onPreview: (post: PostView) => void;
}) {
  const image = post.thumbnail ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={post.thumbnail}
      alt=""
      width={96}
      height={96}
      className={`h-20 w-20 rounded-sm object-cover transition-opacity duration-500 sm:h-24 sm:w-24 ${
        read ? "opacity-50" : "opacity-100"
      }`}
    />
  ) : (
    <div className="flex h-20 w-20 items-center justify-center rounded-sm bg-sunk text-xs text-muted sm:h-24 sm:w-24">
      no image
    </div>
  );

  const badge = isVideo && (
    <span
      aria-hidden
      className="pointer-events-none absolute bottom-1 left-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/55"
    >
      <svg viewBox="0 0 10 12" className="ml-[1px] h-2.5 w-2.5 fill-white">
        <path d="M0 0l10 6-10 6z" />
      </svg>
    </span>
  );

  return (
    <button
      type="button"
      onClick={() => onPreview(post)}
      aria-label={`${isVideo ? "Watch" : "Look at"} this post: ${post.summary ?? post.shortcode}`}
      className="relative shrink-0 cursor-zoom-in self-start"
    >
      {image}
      {badge}
    </button>
  );
}

function statusLabel(post: PostView): string {
  if (post.analysisStatus === "error") return "could not describe";
  if (post.analysisStatus === "running") return "describing";
  return "not described yet";
}

/** Only reached when a post has neither a description nor a caption. */
function placeholderFor(post: PostView): string {
  if (post.analysisStatus === "error") return post.permalink;
  if (post.analysisStatus === "running") return "Describing this post...";
  return "No caption on this one.";
}

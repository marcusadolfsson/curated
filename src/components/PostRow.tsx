"use client";

import { useState } from "react";
import { BookmarkIcon } from "./icons";
import { CATEGORY_HUE, isCategory } from "@/lib/categories";
import { relativeTime } from "@/lib/time";
import type { PostView } from "@/lib/serialize";

type Props = {
  post: PostView;
  /** False with no Claude credential: no description, no category, no status. */
  describing?: boolean;
  onToggleSaved: (id: number, saved: boolean) => Promise<void>;
  onPreview: (post: PostView) => void;
};

/**
 * One post in the pile.
 *
 * The picture is the point, so it is shown at a size you can actually see
 * rather than as a thumbnail tucked beside the text. On a wide screen that is
 * the 4:5 portrait Instagram gave it, beside the words; on a phone there is no
 * room beside anything, so it becomes the top of a card and the words get the
 * full width underneath - a description is then two lines, not six.
 *
 * The words are a hierarchy rather than a stack: the description is the
 * headline, the things it names are a quieter line under it, the sender's own
 * words are a quote carrying the category's colour, and the facts sit on one
 * line at the foot. Saving lives in a corner - of the picture on a phone,
 * of the row on a desktop - so the foot never has to wrap around it.
 */
export default function PostRow({
  post,
  describing = true,
  onToggleSaved,
  onPreview,
}: Props) {
  const [busy, setBusy] = useState<null | "save">(null);

  const hue = isCategory(post.category) ? CATEGORY_HUE[post.category] : 220;
  const read = post.viewed;
  const isVideo = post.mediaType === "reel" || post.mediaType === "tv";

  const run = async (kind: "save", action: () => Promise<void>) => {
    setBusy(kind);
    try {
      await action();
    } finally {
      setBusy(null);
    }
  };

  const headline = post.summary ?? post.caption?.trim() ?? "";
  const label = `${isVideo ? "Watch" : "Look at"} this post: ${headline || post.shortcode}`;

  return (
    <article
      style={{ ["--hue" as string]: hue }}
      className={`group relative flex flex-col gap-3.5 border-b border-line py-5 pl-5 pr-4 transition-colors duration-500 sm:flex-row sm:gap-6 sm:py-6 sm:pl-7 sm:pr-6 ${
        read ? "bg-transparent" : "bg-surface"
      }`}
    >
      <span
        aria-hidden
        className={`spine absolute top-0 bottom-0 left-0 w-1 transition-opacity duration-500 ${
          read ? "opacity-25" : "opacity-100"
        }`}
      />

      <Thumbnail post={post} read={read} isVideo={isVideo} label={label} onPreview={onPreview} />

      {/* A column as tall as the picture, so the facts at the foot line up
          with its bottom edge instead of floating wherever the text ends. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="sm:pr-10">
          {post.summary ? (
            <button
              type="button"
              onClick={() => onPreview(post)}
              className={`block max-w-[56ch] text-left font-serif text-[17px] leading-snug tracking-[-0.005em] hover:underline hover:decoration-line hover:underline-offset-4 sm:text-[19px] ${
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
              className={`line-clamp-3 max-w-[56ch] text-left font-serif text-[16px] leading-snug hover:underline hover:decoration-line hover:underline-offset-4 sm:text-[17px] ${
                read ? "text-muted" : "text-ink-soft"
              }`}
            >
              {post.caption?.trim() || placeholderFor(post)}
            </button>
          )}

          {post.items.length > 0 && (
            <p className="mt-1.5 max-w-[56ch] font-serif text-[14px] italic leading-snug text-muted sm:text-[15px]">
              {post.items.join(" · ")}
            </p>
          )}

          {post.messageText && (
            <p className="quote mt-3 max-w-[52ch] border-l-2 pl-3 font-serif text-[15px] leading-snug text-ink-soft sm:text-[16px]">
              {post.messageText}
            </p>
          )}
        </div>

        <div className="mt-auto flex flex-wrap items-center gap-x-2.5 gap-y-1.5 pt-3 text-[13px] leading-none sm:gap-x-3 sm:pt-4">
          {describing && (
            <span className="flex items-center gap-1.5 text-ink-soft">
              <span aria-hidden className="dot h-2 w-2 rounded-full" />
              {post.category ?? statusLabel(post)}
            </span>
          )}
          <span className="text-muted">
            {post.senderUsername ? (
              <>
                <span className="hidden sm:inline">from </span>
                {post.senderUsername}
              </>
            ) : (
              "shared with you"
            )}
            <span aria-hidden className="mx-1.5 opacity-60">·</span>
            <time>{relativeTime(post.sharedAt)}</time>
          </span>
          {post.mediaType === "reel" && (
            <span className="rounded-sm bg-sunk px-1.5 py-[3px] text-[11px] uppercase tracking-wide text-muted">
              reel
            </span>
          )}
          {post.reactedAt && (
            <span className="text-[14px]" title={`Reacted ${relativeTime(post.reactedAt)}`}>
              {post.reactionEmoji}
            </span>
          )}

        </div>

        {post.reactionError && (
          <p className="mt-2 max-w-[56ch] text-[13px] text-danger">
            Reaction did not send: {post.reactionError}
          </p>
        )}

        {post.analysisStatus === "error" && post.analysisError && (
          <p className="mt-2 max-w-[56ch] text-[13px] text-danger">
            Could not describe this one: {post.analysisError}
          </p>
        )}
      </div>

      {/* Saving, in a corner. On a phone that corner is the top of the
          picture, where every photo app puts it, on a dark pill so it reads
          over anything. On a desktop it is the corner of the row, quiet. */}
      <button
        type="button"
        onClick={() => run("save", () => onToggleSaved(post.id, !post.saved))}
        disabled={busy !== null}
        aria-label={post.saved ? "Remove from saved" : "Save"}
        aria-pressed={post.saved}
        title={post.saved ? "Saved" : "Save"}
        className={`absolute top-7 right-6 flex h-9 w-9 items-center justify-center rounded-full bg-black/45 text-white ring-1 ring-white/20 backdrop-blur-sm transition-colors sm:top-6 sm:right-6 sm:h-8 sm:w-8 sm:bg-transparent sm:ring-0 sm:backdrop-blur-none ${
          post.saved
            ? "sm:text-accent"
            : "sm:text-muted sm:hover:bg-sunk sm:hover:text-accent"
        } disabled:opacity-50`}
      >
        <BookmarkIcon filled={post.saved} />
      </button>
    </article>
  );
}

function Thumbnail({
  post,
  read,
  isVideo,
  label,
  onPreview,
}: {
  post: PostView;
  read: boolean;
  isVideo: boolean;
  label: string;
  onPreview: (post: PostView) => void;
}) {
  const frame =
    "aspect-[4/3] w-full overflow-hidden rounded-lg bg-sunk ring-1 ring-black/[0.06] sm:aspect-[4/5] sm:w-[136px] sm:rounded-md dark:ring-white/[0.06]";

  const image = post.thumbnail ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={post.thumbnail}
      alt=""
      width={136}
      height={170}
      loading="lazy"
      className={`h-full w-full object-cover transition-[opacity,transform] duration-500 group-hover:scale-[1.02] ${
        read ? "opacity-70" : "opacity-100"
      }`}
    />
  ) : (
    <div className="flex h-full w-full items-center justify-center text-xs text-muted">no image</div>
  );

  const badge = isVideo && (
    <span
      aria-hidden
      className="pointer-events-none absolute bottom-2 left-2 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 ring-1 ring-white/20 backdrop-blur-sm"
    >
      <svg viewBox="0 0 10 12" className="ml-[1px] h-3 w-3 fill-white">
        <path d="M0 0l10 6-10 6z" />
      </svg>
    </span>
  );

  return (
    <button
      type="button"
      onClick={() => onPreview(post)}
      aria-label={label}
      className={`relative shrink-0 cursor-zoom-in self-start ${frame}`}
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

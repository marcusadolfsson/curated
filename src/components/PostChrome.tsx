"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { BookmarkIcon, CloseIcon } from "./icons";
import CategoryMenu from "./CategoryMenu";
import { CATEGORIES } from "@/lib/categories";
import { REACTIONS } from "@/lib/emoji";
import type { PostView } from "@/lib/serialize";
import { relativeTime } from "@/lib/time";
import { BAR_HEIGHT, SHEET_VH } from "./PostPreview";

/**
 * Everything about one post that is not the picture: the topic, the words,
 * the reactions, the reply, the bookmark.
 *
 * It lives apart from the viewer because the viewer now holds several posts at
 * once - the one you are looking at and its neighbours, so a swipe can carry
 * the picture under your finger. All of this is per-post state, so it is
 * mounted per post and keyed by its id; the pictures outlive it.
 */

const SHEET_PULL_PX = 40;
// Slop before a drag over the writing counts as closing rather than reading.
const SHEET_GRAB_SLOP_PX = 6;
const SHEET_SETTLE_MS = 240;
/** Room for six lines or so before the writing box stops growing. */
const BOX_MAX_PX = 160;

type Props = {
  post: PostView;
  variant: "phone" | "desktop";
  /** Phone only: the pulled-up panel with the writing in it. */
  sheetOpen: boolean;
  onSheetOpen: (open: boolean) => void;
  onClose: () => void;
  onToggleSaved: (id: number, saved: boolean) => Promise<void>;
  onReact: (id: number, emoji: string) => Promise<void>;
  onReply: (id: number, text: string) => Promise<string | null>;
  onChangeCategory: (id: number, category: string) => Promise<void>;
  /** False with no Claude credential: no categories exist to choose between. */
  describing?: boolean;
  closeRef?: RefObject<HTMLButtonElement | null>;
  /**
   * How far the card has been dragged down, so the picture above can take back
   * the room it is giving up. `animated` is false while a finger is on it.
   */
  onSheetOffset?: (pixels: number, animated: boolean) => void;
};

/**
 * Whoever sent it, over the picture. Their face where we have one, their
 * initial where we do not - the same rule the feed row uses, so a person
 * looks like the same person in both places.
 */
function SenderMark({
  post,
  name,
  size = "sm",
}: {
  post: PostView;
  name: string;
  size?: "sm" | "md";
}) {
  const box = size === "md" ? "h-6 w-6" : "h-5 w-5";
  if (post.senderAvatar) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={post.senderAvatar}
        alt=""
        className={`${box} shrink-0 rounded-full object-cover ring-1 ring-white/25`}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={`${box} flex shrink-0 items-center justify-center rounded-full bg-white/25 text-[10px] font-medium text-white`}
    >
      {name ? name[0]!.toUpperCase() : "?"}
    </span>
  );
}

export default function PostChrome({
  post,
  variant,
  sheetOpen,
  onSheetOpen,
  onClose,
  onToggleSaved,
  onReact,
  onReply,
  onChangeCategory,
  describing = true,
  closeRef,
  onSheetOffset,
}: Props) {
  const phone = variant === "phone";

  // The model's category, until you say otherwise.
  const [category, setCategory] = useState<string>(post.category ?? "Other");
  const changeCategory = (next: string) => {
    if (next === category) return;
    const previous = category;
    setCategory(next);
    void onChangeCategory(post.id, next).catch(() => setCategory(previous));
  };

  const [busy, setBusy] = useState<null | "save">(null);
  const [saved, setSaved] = useState(post.saved);
  const [sent, setSent] = useState<string | null>(post.reactionEmoji);
  const [reactError, setReactError] = useState<string | null>(null);

  // The model's draft is the starting text - to edit, not to send unread.
  const [draft, setDraft] = useState(post.replyText ? "" : (post.draftReply ?? ""));
  const [replied, setReplied] = useState<string | null>(post.replyText);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [hasDraft, setHasDraft] = useState(Boolean(post.draftReply));

  const senderName = post.senderUsername?.split(" ")[0] ?? "the sender";

  const box = useRef<HTMLTextAreaElement>(null);
  const grow = (element: HTMLTextAreaElement) => {
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, BOX_MAX_PX)}px`;
  };
  // A drafted reply arrives already written, so it needs sizing before it is
  // ever typed into.
  useEffect(() => {
    if (box.current) grow(box.current);
  }, [draft, sheetOpen]);

  const suggest = () => {
    setDrafting(true);
    setReplyError(null);
    void fetch(`/api/posts/${post.id}/draft`, { method: "POST" })
      .then(async (response) => {
        const body = (await response.json()) as { draft?: string; error?: string };
        if (body.draft) {
          setDraft(body.draft);
          setHasDraft(true);
        } else setReplyError(body.error ?? "No draft this time.");
      })
      .catch((error: unknown) => setReplyError(error instanceof Error ? error.message : String(error)))
      .finally(() => setDrafting(false));
  };

  const reply = () => {
    const text = draft.trim();
    if (!text) return;
    const previous = replied;
    setReplied(text);
    setDraft("");
    setReplyError(null);
    void onReply(post.id, text).then((error) => {
      if (error) {
        setReplied(previous);
        setDraft(text);
        setReplyError(error);
      }
    });
  };

  // Optimistic: the emoji is shown as sent the moment you tap it, and the call
  // catches up in the background. Waiting on Instagram made a one-tap gesture
  // feel like a form submission. If it fails, the previous state comes back
  // with the reason.
  const react = (emoji: string) => {
    const previous = sent;
    setSent(emoji);
    setReactError(null);
    void onReact(post.id, emoji).catch((error: unknown) => {
      setSent(previous);
      setReactError(error instanceof Error ? error.message : "That reaction did not send.");
    });
  };

  const toggleSaved = async () => {
    setBusy("save");
    try {
      await onToggleSaved(post.id, !saved);
      setSaved(!saved);
    } finally {
      setBusy(null);
    }
  };

  // On the bar: a pull upwards opens the card.
  // A ref, not a local: a render between the finger going down and coming up
  // would otherwise throw the starting point away.
  const pullStart = useRef(0);
  const onPullStart = (event: React.TouchEvent) => {
    pullStart.current = event.touches[0].clientY;
  };
  const onBarTouchEnd = (event: React.TouchEvent) => {
    if (pullStart.current - event.changedTouches[0].clientY > SHEET_PULL_PX) onSheetOpen(true);
  };

  // Dragging the card down takes it with you, and lets go of it where you
  // would expect - it does not vanish the instant you have moved far enough.
  const sheetRef = useRef<HTMLDivElement>(null);
  const [sheetDrag, setSheetDrag] = useState(0);
  const [sheetSettling, setSheetSettling] = useState(false);

  const dismissSheet = () => {
    setSheetSettling(true);
    const full = sheetRef.current?.clientHeight ?? 800;
    setSheetDrag(full);
    onSheetOffset?.(full, true);
    window.setTimeout(() => {
      onSheetOpen(false);
      setSheetSettling(false);
      setSheetDrag(0);
    }, SHEET_SETTLE_MS);
  };

  /**
   * Dragging the card down closes it, from anywhere on the card rather than
   * only from the handle at the top.
   *
   * The writing scrolls, so the two gestures have to share a finger. The rule
   * is the one every sheet uses: while the writing has somewhere left to
   * scroll up into, a downward drag scrolls it; once it is at the top, the
   * same drag takes the card with it. Which of the two this is gets decided
   * once, when the finger goes down, so a card that reaches the top mid-drag
   * does not suddenly start moving underneath you.
   *
   * Nothing calls preventDefault. At the top of its range the scroller has
   * nowhere to go, so there is no scrolling to suppress - only the overscroll
   * bounce, which `overscroll-contain` on the writing already stops.
   */
  const sheetBody = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const mayDrag = useRef(false);

  const onGrabStart = (fromHandle: boolean) => (event: React.TouchEvent) => {
    pullStart.current = event.touches[0].clientY;
    setSheetSettling(false);
    dragging.current = fromHandle;
    mayDrag.current = fromHandle || (sheetBody.current?.scrollTop ?? 0) <= 0;
    if (fromHandle) onSheetOffset?.(sheetDrag, false);
  };

  const onGrabMove = (event: React.TouchEvent) => {
    if (!dragging.current) {
      if (!mayDrag.current) return;
      // Downward, and past a little slop, so a thumb drifting while it reads
      // does not start closing the card.
      if (event.touches[0].clientY - pullStart.current <= SHEET_GRAB_SLOP_PX) return;
      dragging.current = true;
      // Measure from here, so the card does not jump by the slop.
      pullStart.current = event.touches[0].clientY;
      onSheetOffset?.(sheetDrag, false);
    }
    const travelled = Math.max(0, event.touches[0].clientY - pullStart.current);
    setSheetDrag(travelled);
    onSheetOffset?.(travelled, false);
  };

  const onGrabEnd = (event: React.TouchEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    const travelled = event.changedTouches[0].clientY - pullStart.current;
    if (travelled > SHEET_PULL_PX) dismissSheet();
    else {
      setSheetSettling(true);
      setSheetDrag(0);
      onSheetOffset?.(0, true);
      window.setTimeout(() => setSheetSettling(false), SHEET_SETTLE_MS);
    }
  };

  const header = (
    <div className="flex items-baseline justify-between gap-4 border-b border-line px-4 py-3">
      <p className="flex min-w-0 flex-1 items-baseline gap-1.5 font-serif text-[15px] text-ink">
        {describing && (
          <CategoryMenu
            value={category}
            categories={CATEGORIES.map((name) => [name, null])}
            onChange={changeCategory}
            anyLabel={null}
            align="left"
            className="font-serif text-[15px]"
          />
        )}
        {post.authorUsername && (
          <span className="min-w-0 truncate text-ink-soft">from @{post.authorUsername}</span>
        )}
      </p>
      <button
        ref={phone ? undefined : closeRef}
        type="button"
        onClick={phone ? () => onSheetOpen(false) : onClose}
        aria-label={phone ? "Close the details" : "Close"}
        title={phone ? "Close the details" : "Close"}
        className="-mr-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-sunk hover:text-ink"
      >
        <CloseIcon />
      </button>
    </div>
  );

  const words = (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      {post.summary && <p className="font-serif text-[16px] leading-relaxed text-ink">{post.summary}</p>}
      {post.items.length > 0 && (
        <p className="mt-2 font-serif text-[14px] italic text-muted">{post.items.join(", ")}</p>
      )}
      {post.messageText && (
        <p className="mt-3 border-l border-line pl-3 font-serif text-[14px] italic text-ink-soft">
          <span className="mr-1.5 text-[12px] not-italic text-muted">{senderName}</span>
          {post.messageText}
        </p>
      )}
      {replied && (
        <p className="mt-3 border-l-2 border-accent pl-3 font-serif text-[15px] text-ink">
          <span className="mr-1.5 text-[12px] text-muted not-italic">you</span>
          {replied}
        </p>
      )}
      {post.caption && (
        <p className="mt-4 border-t border-line pt-3 font-serif text-[13px] leading-relaxed text-muted">
          {post.caption}
        </p>
      )}
    </div>
  );

  // Reacting from here rather than the feed, because this is where you can
  // actually see what you are reacting to - and pick the emoji instead of
  // taking the one the model chose.
  const emojiButtons = (size: "modal" | "bar") =>
    REACTIONS.map(({ emoji, means }) => {
      const isSent = sent === emoji;
      const isSuggested = post.suggestedReaction === emoji;
      return (
        <button
          key={emoji}
          type="button"
          onClick={() => react(emoji)}
          title={isSent ? `Sent ${emoji}` : means}
          aria-label={`React with ${emoji} - ${means}`}
          className={
            size === "bar"
              ? `rounded-md px-[3px] py-1 text-[22px] leading-none transition-opacity ${
                  isSent ? "bg-white/20 ring-1 ring-white/70" : isSuggested ? "opacity-100" : "opacity-60"
                }`
              : `rounded-sm px-1.5 py-1 text-[19px] leading-none transition-opacity hover:bg-sunk disabled:opacity-40 ${
                  isSent ? "bg-sunk ring-1 ring-accent" : isSuggested ? "opacity-100" : "opacity-55 hover:opacity-100"
                }`
          }
        >
          {emoji}
        </button>
      );
    });

  const replyForm = (
    <form
      className="mt-3"
      onSubmit={(event) => {
        event.preventDefault();
        void reply();
      }}
    >
      <label className="block">
        <span className="sr-only">Reply to the sender about this post</span>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={2}
          maxLength={1000}
          placeholder={replied ? "Say something else" : "Say something back"}
          className="w-full resize-none rounded-sm border border-line bg-paper px-2.5 py-1.5 font-serif text-[14px] text-ink placeholder:text-muted focus:border-accent focus:outline-none disabled:opacity-50"
        />
      </label>
      <div className="mt-1.5 flex items-center justify-between gap-3 text-[12px]">
        <span className={`min-w-0 truncate ${replyError ? "text-danger" : "text-muted"}`}>
          {replyError ??
            (hasDraft && draft && !replied
              ? "A draft, from reading the post. Edit it before sending."
              : "Replies on this post in the thread.")}
        </span>
        <span className="flex shrink-0 items-center gap-3">
          {!replied && post.analysisStatus === "done" && (
            <button
              type="button"
              onClick={suggest}
              disabled={drafting}
              className="text-muted underline-offset-4 hover:text-ink hover:underline disabled:opacity-50"
            >
              {drafting ? "Thinking" : hasDraft ? "Another draft" : "Draft one"}
            </button>
          )}
          <button
            type="submit"
            disabled={!draft.trim()}
            className="rounded-sm bg-accent px-2.5 py-1 text-paper transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            Send
          </button>
        </span>
      </div>
    </form>
  );

  const footer = (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-x-5 gap-y-2 text-[13px]">
      <span className={reactError ? "text-danger" : "text-muted"}>
        {reactError ?? (sent ? `Reacted ${sent}` : "")}
      </span>
      <div className="flex items-center gap-5">
        {!phone && (
          <button
            type="button"
            onClick={toggleSaved}
            disabled={busy !== null}
            aria-label={saved ? "Remove from saved" : "Save"}
            aria-pressed={saved}
            title={saved ? "Saved" : "Save"}
            className="group flex items-center text-accent disabled:opacity-50"
          >
            <BookmarkIcon filled={saved} />
          </button>
        )}
        <a
          href={post.permalink}
          target="_blank"
          rel="noreferrer noopener"
          className="whitespace-nowrap text-accent underline-offset-4 hover:underline"
        >
          Open on Instagram
        </a>
      </div>
    </div>
  );

  const writing = (
    <div className="border-t border-line px-4 py-3">
      <div className="flex flex-wrap items-center gap-1">{emojiButtons("modal")}</div>
      {replyForm}
      {footer}
    </div>
  );

  if (!phone) {
    return (
      <>
        {header}
        {words}
        {writing}
      </>
    );
  }

  // The reactions float over the picture, the way they do on a message,
  // rather than sitting in a bar welded to the bottom of the screen.
  const floating = (
    <>
      {/* Whose it is and what it is, over the foot of the picture - where
          Instagram puts the caption, and for the same reason: it belongs to
          what you are looking at, not to the controls. */}
      {/* pointer-events-none on the gradient, deliberately. It is 48px of
          decoration reaching up over the picture, and while it took clicks it
          swallowed everything beneath it - on a gallery that is the thumbnail
          strip, which simply stopped responding. Only the line of text below
          is a real target, so the handlers live on it instead. */}
      <div
        className="pointer-events-none absolute inset-x-0 bg-gradient-to-t from-black/70 via-black/30 to-transparent pt-12"
        style={{ bottom: BAR_HEIGHT }}
      >
        {reactError && <p className="px-4 pb-1 text-[12px] text-danger">{reactError}</p>}
        <button
          type="button"
          onClick={() => onSheetOpen(true)}
          onTouchStart={onPullStart}
          onTouchEnd={onBarTouchEnd}
          className="pointer-events-auto flex w-full items-center gap-2 px-4 pb-2.5 text-left"
          aria-label="Show the details"
        >
          {/* Who sent it, always - more than one person can be sending. Their
              face says it faster than their name, and leaves the line to what
              they actually wrote. */}
          <SenderMark post={post} name={senderName} />
          <span className="min-w-0 flex-1 truncate text-[15px]">
            {post.messageText ? (
              <span className="font-serif italic text-white">&ldquo;{post.messageText}&rdquo;</span>
            ) : (
              <span className="font-serif text-white/90">{post.summary ?? post.caption ?? "Details"}</span>
            )}
          </span>
          <svg width="12" height="8" viewBox="0 0 12 8" aria-hidden className="shrink-0 text-white/70">
            <path d="M1 7l5-5 5 5" fill="none" stroke="currentColor" strokeWidth="1.6" />
          </svg>
        </button>
      </div>

      {/* The reactions, on their own ground below the picture. */}
      <div
        className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-[#161719] px-3 pb-[env(safe-area-inset-bottom)] pt-1.5"
        style={{ height: BAR_HEIGHT }}
        onTouchStart={onPullStart}
        onTouchEnd={onBarTouchEnd}
      >
        <div className="flex min-w-0 flex-1 items-center justify-between">{emojiButtons("bar")}</div>
        <button
          type="button"
          onClick={toggleSaved}
          disabled={busy !== null}
          aria-label={saved ? "Remove from saved" : "Save"}
          aria-pressed={saved}
          title={saved ? "Saved" : "Save"}
          className="group flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white/85 disabled:opacity-50"
        >
          <BookmarkIcon filled={saved} className="h-5 w-5" />
        </button>
      </div>
    </>
  );

  /**
   * The card that comes up over the reel.
   *
   * Dark whatever the system theme says, because it sits on top of a
   * full-screen video: a pale card over a moving picture is a torch in a dark
   * room. Laid out the way the app it came from lays this out - who posted it,
   * what it says, then somewhere to write back at the bottom.
   */
  const sheet = (
    <div
      className="absolute inset-0 z-20 bg-black/50 transition-opacity"
      style={{ opacity: sheetDrag > 0 ? Math.max(0, 1 - sheetDrag / 400) : 1 }}
      onClick={dismissSheet}
    >
      <div
        ref={sheetRef}
        className="absolute inset-x-0 bottom-0 flex flex-col rounded-t-2xl bg-[#161719] text-white"
        style={{
          height: `${SHEET_VH}vh`,
          transform: `translateY(${sheetDrag}px)`,
          transition: sheetSettling ? `transform ${SHEET_SETTLE_MS}ms ease-out` : "none",
        }}
        onClick={(event) => event.stopPropagation()}
      >
        {/* The part you can take hold of. The writing below it scrolls, so the
            drag lives up here rather than across the whole card. */}
        <div onTouchStart={onGrabStart(true)} onTouchMove={onGrabMove} onTouchEnd={onGrabEnd}>
          <div className="flex justify-center pt-2.5" aria-hidden>
            <span className="h-1 w-9 rounded-full bg-white/25" />
          </div>

          <div className="flex items-center gap-3 px-4 pb-3 pt-3">
          {post.thumbnail && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={post.thumbnail}
              alt=""
              className="h-10 w-10 shrink-0 rounded-full object-cover ring-2 ring-white/15"
            />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-semibold">
              {post.authorUsername ? `@${post.authorUsername}` : "Shared post"}
            </p>
            <p className="truncate text-[13px] text-white/50">
              from {senderName} · {relativeTime(post.sharedAt)}
            </p>
          </div>
          {describing && (
            <CategoryMenu
              value={category}
              categories={CATEGORIES.map((name) => [name, null])}
              onChange={changeCategory}
              anyLabel={null}
              align="right"
              tone="dark"
              className="rounded-full bg-white/10 px-3 py-1.5 text-[13px]"
            />
          )}
          </div>
        </div>

        <div
          ref={sheetBody}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-3"
          onTouchStart={onGrabStart(false)}
          onTouchMove={onGrabMove}
          onTouchEnd={onGrabEnd}
        >
          {post.summary && <p className="text-[15px] leading-relaxed text-white">{post.summary}</p>}
          {post.items.length > 0 && (
            <p className="mt-2 text-[13px] leading-relaxed text-white/40">{post.items.join("  ·  ")}</p>
          )}
          {post.messageText && (
            <div className="mt-4 flex items-start gap-2.5">
              <SenderMark post={post} name={senderName} size="md" />
              <p className="min-w-0 flex-1 rounded-2xl rounded-tl-md bg-white/[0.07] px-3 py-2.5 text-[14px] leading-relaxed text-white/90">
                {post.messageText}
              </p>
            </div>
          )}
          {replied && (
            <p className="mt-2 rounded-xl bg-accent/25 px-3 py-2.5 text-[14px] leading-relaxed text-white/90">
              <span className="mr-1.5 text-[12px] text-white/45">you</span>
              {replied}
            </p>
          )}
          {post.caption && (
            <p className="mt-4 text-[13px] leading-relaxed text-white/45">{post.caption}</p>
          )}
        </div>

        <div className="border-t border-white/10 px-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-2.5">
          <div className="flex items-center justify-between px-1 pb-2.5">{emojiButtons("bar")}</div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void reply();
            }}
          >
            <label className="block">
              <span className="sr-only">Reply to the sender about this post</span>
              {/* Return writes a new line; Send sends. The box grows to what
                  you have written rather than hiding it behind a scrollbar. */}
              <textarea
                ref={box}
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  grow(event.currentTarget);
                }}
                rows={2}
                maxLength={1000}
                placeholder={replied ? "Say something else" : "Start the conversation..."}
                className="w-full resize-none overflow-y-auto rounded-2xl bg-white/[0.08] px-3.5 py-2.5 text-[15px] text-white placeholder:text-white/35 focus:bg-white/[0.12] focus:outline-none"
              />
            </label>
            <div className="flex items-center justify-between gap-3 px-1 pt-1.5 text-[12px]">
              <span className={`min-w-0 truncate ${replyError ? "text-danger" : "text-white/40"}`}>
                {replyError ??
                  (hasDraft && draft && !replied
                    ? "A draft, from reading the post. Edit it before sending."
                    : sent
                      ? `Reacted ${sent}`
                      : "Replies on this post in the thread.")}
              </span>
              <span className="flex shrink-0 items-center gap-3">
                {!replied && post.analysisStatus === "done" && (
                  <button
                    type="button"
                    onClick={suggest}
                    disabled={drafting}
                    className="text-white/55 underline-offset-4 hover:text-white hover:underline disabled:opacity-50"
                  >
                    {drafting ? "Thinking" : hasDraft ? "Another draft" : "Draft one"}
                  </button>
                )}
                <button
                  type="submit"
                  disabled={!draft.trim()}
                  className="rounded-full bg-accent px-3.5 py-1.5 text-[13px] font-medium text-paper transition-opacity hover:opacity-90 disabled:opacity-40"
                >
                  Send
                </button>
              </span>
            </div>
          </form>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {!sheetOpen && floating}
      {sheetOpen && sheet}
    </>
  );
}

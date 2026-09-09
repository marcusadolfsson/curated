"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { relativeTime } from "@/lib/time";

/**
 * The conversation, live while you are in it.
 *
 * The feed waits minutes before looking, because a post is not urgent and a
 * process that answers a notification in eight seconds does not look like a
 * person. A chat is the other case entirely: someone is typing to you and
 * waiting. So this reads the thread the instant the inbox socket stirs -
 * which is only ever while this page is open and visible, the same as any
 * browser tab left on a conversation.
 *
 * The socket is the trigger; the slow timer underneath is only there in case
 * the socket is down.
 */

type Message = {
  id: string;
  text: string | null;
  senderId: string | null;
  at: string | null;
  shortcode: string | null;
  post: {
    id: number;
    summary: string | null;
    mediaType: string | null;
    thumbnail: string | null;
  } | null;
};

type Conversation = {
  threadId: string;
  title: string | null;
  me: string | null;
  users?: { id: string; username: string }[];
  messages: Message[];
  error?: string | null;
};

/** In case the socket is not there. Only ever while you are looking. */
const SAFETY_NET_MS = 45_000;
const WATCHER_POLL_MS = 3_000;

type Followed = {
  threadId: string;
  title: string | null;
  participants: string[];
  avatar: string | null;
};

export default function Chat() {
  const [chat, setChat] = useState<Conversation | null>(null);
  /** The conversations you follow, so more than one can be talked to. */
  const [followed, setFollowed] = useState<Followed[]>([]);
  const [picking, setPicking] = useState(false);
  const picker = useRef<HTMLDivElement>(null);
  /**
   * Which one is open. Held in the URL as well as in state, so a reload or a
   * shared link comes back to the same conversation rather than to whichever
   * the server would have picked.
   */
  const [threadId, setThreadId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const chosen = useRef<string | null>(null);

  useEffect(() => {
    if (!picking) return;
    const away = (event: PointerEvent) => {
      if (!picker.current?.contains(event.target as Node)) setPicking(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPicking(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [picking]);
  const bottom = useRef<HTMLDivElement>(null);
  const lastEvent = useRef<string | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current || document.visibilityState === "hidden") return;
    inFlight.current = true;
    try {
      const wanted = chosen.current;
      const response = await fetch(wanted ? `/api/chat?threadId=${encodeURIComponent(wanted)}` : "/api/chat");
      if (response.ok) {
        const conversation = (await response.json()) as Conversation;
        setChat(conversation);
        // The server decides when nothing was asked for. Adopt its answer so
        // the picker agrees with what is on screen.
        if (!chosen.current && conversation.threadId) {
          chosen.current = conversation.threadId;
          setThreadId(conversation.threadId);
        }
      } else setNotice("No conversation is being watched. Pick one under Setup.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("thread");
    if (fromUrl) {
      chosen.current = fromUrl;
      setThreadId(fromUrl);
    }
    const timer = setTimeout(load, 0);
    return () => clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    void fetch("/api/threads")
      .then((response) => (response.ok ? response.json() : { threads: [] }))
      .then((body: { threads?: (Followed & { watch: boolean })[] }) =>
        setFollowed((body.threads ?? []).filter((thread) => thread.watch)),
      )
      .catch(() => {
        // only used to fill the picker; the conversation itself still loads
      });
  }, []);

  /** Switching conversation: replace the URL rather than stacking history. */
  const openThread = useCallback(
    (id: string) => {
      if (id === chosen.current) return;
      chosen.current = id;
      setThreadId(id);
      setChat(null);
      setLoading(true);
      setNotice(null);
      const url = new URL(window.location.href);
      url.searchParams.set("thread", id);
      window.history.replaceState(null, "", url);
      void load();
    },
    [load],
  );

  // The socket is the doorbell: when the watcher hears something and this page
  // is in front of you, read the thread straight away.
  useEffect(() => {
    const listen = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const response = await fetch("/api/watch");
        if (!response.ok) return;
        const state = (await response.json()) as { lastEventAt: string | null };
        if (state.lastEventAt && state.lastEventAt !== lastEvent.current) {
          const first = lastEvent.current === null;
          lastEvent.current = state.lastEventAt;
          if (!first) void load();
        }
      } catch {
        // the watcher is our own server; a blip here is not worth showing
      }
    };
    const timer = setInterval(listen, WATCHER_POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => void load(), SAFETY_NET_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [chat?.messages.length]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setNotice(null);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, threadId: chosen.current ?? undefined }),
      });
      const body = (await response.json()) as { ok?: boolean; error?: string };
      if (body.ok) {
        setDraft("");
        setTimeout(() => void load(), 1200); // let Instagram put it in the thread
      } else setNotice(body.error ?? "That did not send.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  /**
   * A share: the picture at a size you can actually read, with whatever was
   * typed sitting over its foot rather than beside it. The post opens here
   * rather than on Instagram - going to Instagram to look at a thing someone
   * sent you is the whole problem this app exists to avoid.
   */
  const SharePreview = ({ message, mine }: { message: Message; mine: boolean }) => {
    const isVideo = message.post?.mediaType === "reel" || message.post?.mediaType === "tv";
    const here = message.post ? `/?post=${message.post.id}` : null;

    // Nothing kept for this one - it predates the sync, or was never imported.
    // Say what it was, and let it go to Instagram since we have no copy.
    if (!message.post?.thumbnail) {
      return (
        <div
          className={`rounded-2xl px-3.5 py-2 font-serif text-[17px] leading-snug ${
            mine ? "bg-accent text-paper" : "bg-surface text-ink"
          }`}
        >
          <Link
            href={`https://www.instagram.com/p/${message.shortcode}/`}
            target="_blank"
            rel="noreferrer noopener"
            className={`line-clamp-2 text-[15px] underline-offset-4 hover:underline ${
              mine ? "text-paper/80" : "text-muted"
            }`}
          >
            {message.post?.summary ?? "Shared a post"}
          </Link>
          {message.text}
        </div>
      );
    }

    return (
      // Room at the foot for the pill that hangs past the picture.
      <div className={`relative w-[168px] ${message.text ? "pb-5" : ""} ${mine ? "ml-auto" : ""}`}>
        <Link
          href={here!}
          aria-label={message.post.summary ?? "Open this post"}
          className="relative block aspect-[4/5] w-full overflow-hidden rounded-xl bg-sunk ring-1 ring-black/[0.08] dark:ring-white/[0.10]"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={message.post.thumbnail} alt="" loading="lazy" className="h-full w-full object-cover" />
          {isVideo && (
            <span
              aria-hidden
              className="absolute bottom-2 left-2 flex h-7 w-7 items-center justify-center rounded-full bg-black/55 ring-1 ring-white/20 backdrop-blur-sm"
            >
              <svg viewBox="0 0 10 12" className="ml-[1px] h-3 w-3 fill-white">
                <path d="M0 0l10 6-10 6z" />
              </svg>
            </span>
          )}
        </Link>

        {message.text && (
          <p
            className={`absolute bottom-0 w-max max-w-[190px] rounded-2xl px-3 py-1.5 font-serif text-[15px] leading-snug shadow-[0_6px_18px_-6px_rgba(0,0,0,0.45)] ${
              mine
                ? "right-3 rounded-br-md bg-accent text-paper"
                : "left-3 rounded-bl-md bg-surface text-ink ring-1 ring-line"
            }`}
          >
            {message.text}
          </p>
        )}
      </div>
    );
  };

  const nameOf = (senderId: string | null) => {
    if (!senderId) return "";
    const user = chat?.users?.find((u) => u.id === senderId);
    return user?.username ?? chat?.title ?? "";
  };

  return (
    // The body carries the status bar's inset as padding, so a child asking
    // for the whole viewport hangs that far off the bottom - which is exactly
    // where the box you type in lives.
    <div className="mx-auto flex h-[calc(100dvh-env(safe-area-inset-top))] max-w-2xl flex-col px-4 sm:px-6">
      <header className="flex shrink-0 items-baseline justify-between gap-4 pb-2 pt-3">
        {/* One conversation is a heading. Several is a choice, and it belongs
            where the heading was rather than tucked away in a menu. */}
        {followed.length > 1 ? (
          <div ref={picker} className="relative min-w-0 flex-1">
            <button
              type="button"
              aria-haspopup="listbox"
              aria-expanded={picking}
              onClick={() => setPicking((state) => !state)}
              className="flex min-w-0 max-w-full items-center gap-2"
            >
              <Face thread={followed.find((t) => t.threadId === threadId)} size={30} />
              <span className="min-w-0 truncate font-serif text-2xl leading-none tracking-tight">
                {chat?.title ?? "Chat"}
              </span>
              <svg width="12" height="7" viewBox="0 0 12 7" aria-hidden className="shrink-0 opacity-60">
                <path d="M1 1l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.6" />
              </svg>
            </button>

            {picking && (
              <div
                role="listbox"
                className="absolute top-full left-0 z-20 mt-2 max-h-72 w-64 overflow-y-auto rounded-xl bg-surface p-1.5 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.25)] ring-1 ring-line"
              >
                {followed.map((thread) => (
                  <button
                    key={thread.threadId}
                    type="button"
                    role="option"
                    aria-selected={thread.threadId === threadId}
                    onClick={() => {
                      setPicking(false);
                      openThread(thread.threadId);
                    }}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-sunk ${
                      thread.threadId === threadId ? "bg-sunk text-ink" : "text-ink-soft"
                    }`}
                  >
                    <Face thread={thread} size={28} />
                    <span className="min-w-0 flex-1 truncate text-[15px]">
                      {thread.title ?? thread.participants.join(", ") ?? "Conversation"}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <h1 className="min-w-0 truncate font-serif text-2xl leading-none tracking-tight">
            {chat?.title ?? "Chat"}
          </h1>
        )}
        <Link href="/" className="shrink-0 whitespace-nowrap text-[14px] text-accent underline-offset-4 hover:underline">
          Back to Curated
        </Link>
      </header>

      {(notice ?? chat?.error) && (
        <p className="mb-2 border-l-2 border-danger pl-3 text-[13px] text-danger">
          {notice ?? chat?.error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {loading ? (
          <p className="py-16 text-center text-[15px] text-muted">Opening the conversation</p>
        ) : chat && chat.messages.length > 0 ? (
          <ol className="space-y-2">
            {chat.messages.map((message) => {
              const mine = Boolean(chat.me && message.senderId === chat.me);
              return (
                <li key={message.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                  <div className="max-w-[80%]">
                    {!mine && (
                      <p className="mb-0.5 pl-3 text-[13px] text-muted">{nameOf(message.senderId)}</p>
                    )}
                    {message.shortcode ? (
                      <SharePreview message={message} mine={mine} />
                    ) : (
                      <div
                        className={`rounded-2xl px-3.5 py-2 font-serif text-[17px] leading-snug ${
                          mine ? "bg-accent text-paper" : "bg-surface text-ink"
                        }`}
                      >
                        {message.text}
                      </div>
                    )}
                    <p
                      className={`mt-0.5 text-[12px] text-muted ${mine ? "pr-3 text-right" : "pl-3"}`}
                    >
                      {relativeTime(message.at)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="py-16 text-center text-[14px] text-muted">Nothing said yet.</p>
        )}
        <div ref={bottom} />
      </div>

      <form
        className="flex shrink-0 items-stretch gap-2 border-t border-line pt-2.5 pb-[max(env(safe-area-inset-bottom),0.75rem)]"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label className="min-w-0 flex-1">
          <span className="sr-only">Write a message</span>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            rows={1}
            maxLength={1000}
            placeholder="Write a message"
            className="block w-full resize-none rounded-2xl border border-line bg-surface px-3.5 py-2.5 font-serif text-[17px] text-ink placeholder:text-muted focus:border-accent focus:outline-none"
          />
        </label>
        <button
          type="submit"
          disabled={!draft.trim() || sending}
          className="flex shrink-0 items-center rounded-full bg-accent px-4 text-[15px] text-paper transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {sending ? "Sending" : "Send"}
        </button>
      </form>
    </div>
  );
}

/** A conversation's face, or its initial when we have never seen one. */
function Face({ thread, size }: { thread: { title: string | null; avatar: string | null } | undefined; size: number }) {
  const style = { width: size, height: size };
  if (thread?.avatar) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={thread.avatar}
        alt=""
        style={style}
        className="shrink-0 rounded-full object-cover ring-1 ring-black/[0.08] dark:ring-white/[0.10]"
      />
    );
  }
  return (
    <span
      aria-hidden
      style={style}
      className="flex shrink-0 items-center justify-center rounded-full bg-sunk text-[11px] font-medium text-muted"
    >
      {thread?.title ? thread.title[0]!.toUpperCase() : "?"}
    </span>
  );
}

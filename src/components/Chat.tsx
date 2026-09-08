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
  post: { id: number; summary: string | null } | null;
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

export default function Chat() {
  const [chat, setChat] = useState<Conversation | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const bottom = useRef<HTMLDivElement>(null);
  const lastEvent = useRef<string | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current || document.visibilityState === "hidden") return;
    inFlight.current = true;
    try {
      const response = await fetch("/api/chat");
      if (response.ok) setChat((await response.json()) as Conversation);
      else setNotice("No conversation is being watched. Pick one under Setup.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(load, 0);
    return () => clearTimeout(timer);
  }, [load]);

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
        body: JSON.stringify({ text }),
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
        <h1 className="min-w-0 truncate font-serif text-2xl leading-none tracking-tight">
          {chat?.title ?? "Chat"}
        </h1>
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
                    <div
                      className={`rounded-2xl px-3.5 py-2 font-serif text-[17px] leading-snug ${
                        mine ? "bg-accent text-paper" : "bg-surface text-ink"
                      }`}
                    >
                      {message.shortcode && (
                        <Link
                          href={`https://www.instagram.com/p/${message.shortcode}/`}
                          target="_blank"
                          rel="noreferrer noopener"
                          // A share is a mention of a post, not the post: two
                          // lines of what it is, so the talking around it stays
                          // the thing you read.
                          className={`mb-1 line-clamp-2 text-[15px] underline-offset-4 hover:underline ${
                            mine ? "text-paper/80" : "text-muted"
                          }`}
                        >
                          {message.post?.summary ?? "Shared a post"}
                        </Link>
                      )}
                      {message.text}
                    </div>
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
        className="flex shrink-0 items-end gap-2 border-t border-line pt-2.5 pb-[max(env(safe-area-inset-bottom),0.75rem)]"
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
            className="w-full resize-none rounded-2xl border border-line bg-surface px-3.5 py-2.5 font-serif text-[17px] text-ink placeholder:text-muted focus:border-accent focus:outline-none"
          />
        </label>
        <button
          type="submit"
          disabled={!draft.trim() || sending}
          className="shrink-0 rounded-full bg-accent px-4 py-2.5 text-[15px] text-paper transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {sending ? "Sending" : "Send"}
        </button>
      </form>
    </div>
  );
}

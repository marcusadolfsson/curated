"use client";

import { useEffect, useState } from "react";
import { relativeTime } from "@/lib/time";

type Thread = {
  threadId: string;
  title: string | null;
  participants: string[];
  watch: boolean;
  lastItemAt: string | null;
  postsFound: number;
};

export default function ThreadPicker() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/threads")
      .then((response) => (response.ok ? response.json() : { threads: [] }))
      .then((body: { threads: Thread[] }) => {
        setThreads(body.threads);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const response = await fetch("/api/threads/refresh", { method: "POST" });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        setError(body.error ?? "Could not read the inbox.");
      } else {
        const listing = await fetch("/api/threads");
        if (listing.ok) {
          const body = (await listing.json()) as { threads: Thread[] };
          setThreads(body.threads);
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRefreshing(false);
    }
  };

  const toggle = async (threadId: string, watch: boolean) => {
    setThreads((current) =>
      current.map((thread) => (thread.threadId === threadId ? { ...thread, watch } : thread)),
    );
    await fetch("/api/threads", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId, watch }),
    });
  };

  const watched = threads.filter((thread) => thread.watch).length;

  return (
    <section className="border-b border-line py-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-serif text-2xl">Whose messages to read</h2>
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          className="text-[13px] text-accent underline-offset-4 hover:underline disabled:opacity-50"
        >
          {refreshing ? "Reading your inbox" : "Refresh conversations"}
        </button>
      </div>
      <p className="mt-1 max-w-[58ch] text-[14px] text-muted">
        {watched > 0
          ? "Only the ticked conversations are read."
          : "Nothing is ticked, so every conversation in your inbox is read. Tick one to narrow it down."}
      </p>

      {error && (
        <p className="mt-3 max-w-[58ch] border-l-2 border-danger pl-3 text-[13px] text-danger">
          {error}
        </p>
      )}

      {loading ? (
        <p className="mt-5 text-[14px] text-muted">Loading conversations</p>
      ) : threads.length === 0 ? (
        <p className="mt-5 max-w-[58ch] text-[14px] text-muted">
          No conversations yet. Choose &quot;Refresh conversations&quot; to read your inbox - that
          lists who you talk to without importing anything.
        </p>
      ) : (
        <ul className="mt-5 max-w-xl">
          {threads.map((thread) => (
            <li key={thread.threadId} className="border-b border-line last:border-b-0">
              <label className="flex cursor-pointer items-center gap-3 py-2.5">
                <input
                  type="checkbox"
                  checked={thread.watch}
                  onChange={(event) => void toggle(thread.threadId, event.target.checked)}
                  className="h-4 w-4 accent-[var(--accent)]"
                />
                <span className="min-w-0 flex-1 truncate text-[15px]">
                  {thread.title || thread.participants.join(", ") || thread.threadId}
                </span>
                <span className="shrink-0 text-[13px] text-muted">
                  {relativeTime(thread.lastItemAt)}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

"use client";

import { useEffect, useState } from "react";
import type { SyncState } from "@/lib/sync";

type SyncResponse = {
  state: SyncState;
  lastRun: { startedAt: string | null; finishedAt: string | null; status: string; postsAdded: number; error: string | null } | null;
};

/**
 * The manual check, off the front page. New posts arrive on their own - the
 * inbox tab hears them - so this is for when you want to be sure, not a
 * button to press every time you open the app.
 */
export default function SyncPanel() {
  const [data, setData] = useState<SyncResponse | null>(null);

  const load = () =>
    fetch("/api/sync")
      .then((response) => (response.ok ? (response.json() as Promise<SyncResponse>) : null))
      .then((body) => {
        if (body) setData(body);
      })
      .catch(() => undefined);

  useEffect(() => {
    const timer = setTimeout(load, 0);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!data?.state.running) return;
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, [data?.state.running]);

  const start = async () => {
    const response = await fetch("/api/sync", { method: "POST" });
    const body = (await response.json()) as { state: SyncState };
    setData((current) => ({ state: body.state, lastRun: current?.lastRun ?? null }));
  };

  const state = data?.state;
  const last = data?.lastRun;

  return (
    <section className="border-b border-line py-8">
      <h2 className="font-serif text-2xl">Checking for posts</h2>
      <p className="mt-1 max-w-[58ch] text-[14px] text-muted">
        New posts arrive on their own while the inbox tab is listening, with a fallback look twice a
        day. This is for when you want to be sure right now.
      </p>

      <div className="mt-5 flex flex-wrap items-center gap-4 text-[14px]">
        <button
          type="button"
          onClick={start}
          disabled={state?.running}
          className="rounded-sm bg-accent px-3.5 py-2 text-paper transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {state?.running ? "Checking" : "Check for new"}
        </button>
        <span className={`text-[13px] ${state?.phase === "error" ? "text-danger" : "text-muted"}`}>
          {state?.running
            ? state.message
            : state?.phase === "error"
              ? state.error
              : last?.finishedAt
                ? `Last checked ${new Date(last.finishedAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}${
                    last.postsAdded > 0 ? `, ${last.postsAdded} new` : ", nothing new"
                  }`
                : ""}
        </span>
      </div>
    </section>
  );
}

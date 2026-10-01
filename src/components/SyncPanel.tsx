"use client";

import { useEffect, useState } from "react";
import type { SyncState } from "@/lib/sync";

type SyncResponse = {
  state: SyncState;
  lastRun: { startedAt: string | null; finishedAt: string | null; status: string; postsAdded: number; error: string | null } | null;
};

/**
 * The manual check, off the front page. New posts arrive on their own - the
 * listener hears about new messages and reads them - so this is for when you
 * want to be sure, not a button to press every time you open the app.
 */
export default function SyncPanel() {
  const [data, setData] = useState<SyncResponse | null>(null);
  /**
   * Through the API: when it last asked Instagram. Later than the last sync
   * whenever nothing has arrived since, because a sync only runs when
   * something does - so it is the truer "last checked".
   */
  const [upstreamCheckedAt, setUpstreamCheckedAt] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/watch")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { upstreamCheckedAt?: string | null } | null) => setUpstreamCheckedAt(body?.upstreamCheckedAt ?? null))
      .catch(() => undefined);
  }, []);

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
        New posts arrive on their own: Curated hears about new messages as they come in and reads them
        straight away. This is for when you want to be sure right now.
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
              : lastChecked(last ?? null, upstreamCheckedAt)}
        </span>
      </div>
    </section>
  );
}

/**
 * The later of the last sync and the API's last look at Instagram. A sync
 * says what it found; a later look found nothing, or a sync would have run.
 */
function lastChecked(last: SyncResponse["lastRun"], upstreamCheckedAt: string | null): string {
  const synced = last?.finishedAt ? new Date(last.finishedAt) : null;
  const looked = upstreamCheckedAt ? new Date(upstreamCheckedAt) : null;
  const when = (at: Date) => at.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  if (looked && (!synced || looked > synced)) return `Last checked ${when(looked)}, nothing new`;
  if (synced && last) return `Last checked ${when(synced)}${last.postsAdded > 0 ? `, ${last.postsAdded} new` : ", nothing new"}`;
  return "";
}

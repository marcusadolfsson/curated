"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import PostPreview from "./PostPreview";
import type { UpcomingEntry } from "@/app/api/upcoming/route";
import type { PostView } from "@/lib/serialize";

type UpcomingData = {
  today: string;
  entries: UpcomingEntry[];
  waiting: boolean;
  finding: { running: boolean; done: number; total: number; error: string | null };
};

const KIND: Record<UpcomingEntry["kind"], string> = {
  event: "Event",
  sale: "On sale",
  deadline: "Deadline",
  opening: "Opening",
  other: "Date",
};

/**
 * What is coming up in the posts she sent: tickets going on sale, the nights
 * of an event, the last day to book. Soonest first, by month, each with a way
 * to put it in the calendar - the point is to catch the date while it is
 * still ahead, not to find the post again once it has passed.
 */
export default function Upcoming() {
  const [data, setData] = useState<UpcomingData | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/upcoming").catch(() => null);
    if (response?.ok) setData((await response.json()) as UpcomingData);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // While the backlog is being read, watch it fill in.
  useEffect(() => {
    if (!data?.finding.running) return;
    const timer = setInterval(() => void load(), 5_000);
    return () => clearInterval(timer);
  }, [data?.finding.running, load]);

  const months = useMemo(() => {
    const groups = new Map<string, UpcomingEntry[]>();
    for (const entry of data?.entries ?? []) {
      // A span already under way belongs to this month, not the one it began in.
      const anchor = entry.start < (data?.today ?? "") ? (data?.today ?? entry.start) : entry.start;
      const key = anchor.slice(0, 7);
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    return [...groups.entries()];
  }, [data]);

  /** One post per entry, in the order shown, for the viewer to step through. */
  const sequence: PostView[] = useMemo(() => (data?.entries ?? []).map((entry) => entry.post), [data]);

  const patch = async (
    id: number,
    changes: { viewed?: boolean; saved?: boolean; category?: string; note?: string | null },
  ) => {
    await fetch(`/api/posts/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(changes),
    });
    await load();
  };

  const show = (index: number) => {
    setOpen(index);
    const post = sequence[index];
    if (post && !post.viewed) void patch(post.id, { viewed: true });
  };

  const findBacklog = async () => {
    await fetch("/api/upcoming/scan", { method: "POST" });
    await load();
  };

  if (!data) return <p className="py-16 text-center text-[14px] text-muted">Looking ahead</p>;

  const posts = new Set(data.entries.map((entry) => entry.post.id)).size;

  return (
    <div className="mx-auto max-w-3xl px-4 pb-24 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-4 pt-10 pb-5">
        <div>
          <h1 className="font-serif text-4xl leading-none tracking-tight">Upcoming</h1>
          <p className="mt-2 text-[14px] text-muted">
            {data.entries.length === 0
              ? "Nothing coming up."
              : `${data.entries.length} date${data.entries.length === 1 ? "" : "s"} from ${posts} post${posts === 1 ? "" : "s"}`}
          </p>
        </div>
        <Link href="/" className="text-[14px] text-accent underline-offset-4 hover:underline">
          Back to Curated
        </Link>
      </header>

      {(data.finding.running || data.waiting || data.finding.error) && (
        <div className="mb-6 rounded-xl bg-sunk px-4 py-3 text-[14px] text-ink-soft">
          {data.finding.running ? (
            <>Reading posts for dates: {data.finding.done} of {data.finding.total}.</>
          ) : data.finding.error ? (
            <>Reading stopped: {data.finding.error}</>
          ) : (
            <>
              Some posts have not been read for dates yet.{" "}
              <button type="button" onClick={() => void findBacklog()} className="text-accent underline-offset-4 hover:underline">
                Read them
              </button>
            </>
          )}
        </div>
      )}

      {months.map(([month, entries]) => (
        <section key={month} className="border-t border-line py-5">
          <h2 className="font-serif text-2xl">{monthName(month)}</h2>
          <ul className="mt-3 space-y-2">
            {entries.map((entry) => {
              const index = data.entries.indexOf(entry);
              return (
                <li key={entry.key} className="flex gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-sunk">
                  <DateBlock entry={entry} today={data.today} />
                  <button type="button" onClick={() => show(index)} className="min-w-0 flex-1 text-left">
                    <span className="flex flex-wrap items-baseline gap-x-2 text-[15px] text-ink">
                      {!entry.post.viewed && (
                        <span aria-label="unread" className="h-1.5 w-1.5 shrink-0 self-center rounded-full bg-accent" />
                      )}
                      <span>{entry.label}</span>
                      <span className="text-[12px] text-muted">
                        {KIND[entry.kind]} · {soon(entry, data.today)}
                      </span>
                    </span>
                    {entry.post.summary && (
                      <span className="mt-0.5 line-clamp-2 block text-[13px] text-muted">{entry.post.summary}</span>
                    )}
                  </button>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    {entry.post.thumbnail ? (
                      <button type="button" onClick={() => show(index)} aria-label="Open the post">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={entry.post.thumbnail} alt="" className="h-14 w-14 rounded-lg object-cover" />
                      </button>
                    ) : null}
                    <a
                      href={`/api/upcoming/ics?post=${entry.post.id}&date=${entry.index}`}
                      className="text-[12px] text-accent underline-offset-4 hover:underline"
                    >
                      Add to calendar
                    </a>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {open !== null && sequence[open] && (
        <PostPreview
          sequence={sequence}
          index={open}
          onIndexChange={show}
          onClose={() => setOpen(null)}
          onToggleSaved={(id, saved) => patch(id, { saved })}
          onReact={async (id, emoji) => {
            const response = await fetch(`/api/posts/${id}/react`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(emoji ? { emoji } : {}),
            });
            if (!response.ok) {
              const body = (await response.json()) as { error?: string };
              throw new Error(body.error ?? "That reaction did not send.");
            }
            void load();
          }}
          onReply={async (id, text) => {
            const response = await fetch(`/api/posts/${id}/reply`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ text }),
            });
            const body = (await response.json()) as { error?: string | null };
            void load();
            return response.ok ? null : (body.error ?? "That reply did not send.");
          }}
          onNote={(id, note) => patch(id, { note })}
          onChangeCategory={(id, category) => patch(id, { category })}
        />
      )}
    </div>
  );
}

/** The day, large, with its weekday; a span shows where it runs to. */
function DateBlock({ entry, today }: { entry: UpcomingEntry; today: string }) {
  const start = day(entry.start);
  const ongoing = entry.start < today;
  return (
    <div className="w-14 shrink-0 text-center leading-none">
      {ongoing ? (
        <span className="block pt-1 text-[12px] font-medium text-accent">Now</span>
      ) : (
        <>
          <span className="block font-serif text-[26px] text-ink">{start.getUTCDate()}</span>
          <span className="mt-0.5 block text-[11px] uppercase tracking-wide text-muted">
            {start.toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" })}
          </span>
        </>
      )}
      {entry.end && (
        <span className="mt-1 block text-[11px] text-muted">
          to {day(entry.end).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })}
        </span>
      )}
    </div>
  );
}

/** How soon, in words: today, tomorrow, in 5 days, in 3 weeks, until Dec 31. */
function soon(entry: UpcomingEntry, today: string): string {
  const days = Math.round((day(entry.start).getTime() - day(today).getTime()) / 86_400_000);
  if (days < 0) {
    return entry.end
      ? `until ${day(entry.end).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })}`
      : "under way";
  }
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 14) return `in ${days} days`;
  if (days < 60) return `in ${Math.round(days / 7)} weeks`;
  return `in ${Math.round(days / 30)} months`;
}

function day(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function monthName(month: string): string {
  return day(`${month}-01`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
}

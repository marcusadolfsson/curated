"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import PostPreview from "./PostPreview";
import type { TravelCountry, TravelPost } from "@/app/api/travel/route";

type TravelData = {
  countries: TravelCountry[];
  places: number;
  regions: number;
  waiting: boolean;
  locating: { running: boolean; done: number; total: number; error: string | null };
};

/**
 * Every place she has sent, by country and then region.
 *
 * A region she keeps coming back to gets its name as a heading with the posts
 * under it; a place she sent once is a single line. Tapping one opens it in
 * the same viewer as the feed, moving through the list in the order shown.
 */
export default function Travel() {
  const [data, setData] = useState<TravelData | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [sort, setSort] = useState<Sort>("alpha");
  /** Regions showing their posts, by `country / region`. Everything starts folded. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // The sort is a per-viewer convenience, so it lives in this browser only.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(SORT_KEY);
      if (saved === "alpha" || saved === "count") setSort(saved);
    } catch {
      // private mode or storage blocked: alphabetical it is
    }
  }, []);
  const chooseSort = (next: Sort) => {
    setSort(next);
    try {
      window.localStorage.setItem(SORT_KEY, next);
    } catch {
      // nothing to remember into
    }
  };

  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const load = useCallback(async () => {
    const response = await fetch("/api/travel").catch(() => null);
    if (response?.ok) setData((await response.json()) as TravelData);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // While the backlog is being placed, watch it fill in.
  useEffect(() => {
    if (!data?.locating.running) return;
    const timer = setInterval(() => void load(), 4_000);
    return () => clearInterval(timer);
  }, [data?.locating.running, load]);

  /** Countries and their regions in the chosen order. */
  const countries = useMemo(() => {
    const byName = (a: string, b: string) => a.localeCompare(b);
    return (data?.countries ?? [])
      .map((country) => ({
        ...country,
        regions: [...country.regions].sort((a, b) =>
          sort === "count"
            ? b.posts.length - a.posts.length || byName(a.region, b.region)
            : byName(a.region, b.region),
        ),
      }))
      .sort((a, b) => (sort === "count" ? b.count - a.count || byName(a.country, b.country) : byName(a.country, b.country)));
  }, [data, sort]);

  /** Every post in the order the page shows them, for the viewer to step through. */
  const sequence = useMemo(() => countries.flatMap((c) => c.regions.flatMap((r) => r.posts)), [countries]);

  const allKeys = useMemo(
    () => countries.flatMap((c) => c.regions.map((r) => regionKey(c.country, r.region))),
    [countries],
  );
  const everythingOpen = allKeys.length > 0 && allKeys.every((key) => expanded.has(key));

  const patch = async (id: number, changes: { viewed?: boolean; saved?: boolean; category?: string }) => {
    await fetch(`/api/posts/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(changes),
    });
    await load();
  };

  const show = (post: TravelPost) => {
    setOpen(sequence.findIndex((p) => p.id === post.id));
    if (!post.viewed) void patch(post.id, { viewed: true });
  };

  const placeBacklog = async () => {
    await fetch("/api/travel/locate", { method: "POST" });
    await load();
  };

  if (!data) return <p className="py-16 text-center text-[14px] text-muted">Finding places</p>;

  const locating = data.locating;

  return (
    <div className="mx-auto max-w-3xl px-4 pb-24 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-4 pt-10 pb-6">
        <div>
          <h1 className="font-serif text-4xl leading-none tracking-tight">Travel</h1>
          <p className="mt-2 text-[14px] text-muted">
            {data.places === 0
              ? "No places yet."
              : `${data.places} post${data.places === 1 ? "" : "s"} across ${data.regions} place${data.regions === 1 ? "" : "s"} in ${data.countries.length} countr${data.countries.length === 1 ? "y" : "ies"}`}
          </p>
        </div>
        <Link href="/" className="text-[14px] text-accent underline-offset-4 hover:underline">
          Back to Curated
        </Link>
      </header>

      {countries.length > 0 && (
        <div className="mb-4 flex items-center justify-between gap-3">
          <div role="group" aria-label="Sort" className="flex rounded-full bg-sunk p-0.5 text-[13px]">
            {(
              [
                ["alpha", "A–Z"],
                ["count", "Most posts"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={sort === value}
                onClick={() => chooseSort(value)}
                className={`rounded-full px-3 py-1 transition-colors ${
                  sort === value ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setExpanded(everythingOpen ? new Set() : new Set(allKeys))}
            className="text-[13px] text-accent underline-offset-4 hover:underline"
          >
            {everythingOpen ? "Collapse all" : "Expand all"}
          </button>
        </div>
      )}

      {(locating.running || data.waiting || locating.error) && (
        <div className="mb-6 rounded-xl bg-sunk px-4 py-3 text-[14px] text-ink-soft">
          {locating.running ? (
            <>Placing travel posts on the map: {locating.done} of {locating.total}.</>
          ) : locating.error ? (
            <>Placing stopped: {locating.error}</>
          ) : (
            <>
              Some travel posts have not been placed yet.{" "}
              <button type="button" onClick={() => void placeBacklog()} className="text-accent underline-offset-4 hover:underline">
                Place them
              </button>
            </>
          )}
        </div>
      )}

      {countries.map((country) => (
        <section key={country.country} className="border-t border-line py-5">
          <h2 className="flex items-baseline justify-between gap-3">
            <span className="font-serif text-2xl">{country.country}</span>
            <span className="text-[13px] text-muted">{country.count}</span>
          </h2>

          <ul className="mt-2">
            {country.regions.map((region) => {
              const key = regionKey(country.country, region.region);
              const isOpen = expanded.has(key);
              // A region that is the whole section - Peru in Peru, Antarctica
              // with no country - holds the posts about it in general.
              const sameAsSection = region.region === country.country;
              const single = region.posts.length === 1 ? region.posts[0] : null;
              // A place sent once is named by the place itself.
              const label = sameAsSection
                ? `Across ${region.region}`
                : single?.place && !single.place.includes(region.region)
                  ? single.place
                  : region.region;
              const detail =
                single?.place && !sameAsSection && label === single.place ? region.region : null;
              const unread = region.posts.filter((post) => !post.viewed).length;

              return (
                <li key={region.region}>
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() => toggle(key)}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-sunk"
                  >
                    <Chevron open={isOpen} />
                    <span className="min-w-0 flex-1 truncate text-[15px] text-ink">
                      {label}
                      {detail && <span className="text-[13px] text-muted"> · {detail}</span>}
                    </span>
                    {unread > 0 && (
                      <span aria-label={`${unread} unread`} className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                    )}
                    <span className="w-6 shrink-0 text-right text-[13px] text-muted">{region.posts.length}</span>
                  </button>

                  {isOpen && (
                    <ul className="mt-0.5 mb-2 space-y-1 pl-6">
                      {region.posts.map((post) => (
                        <PlaceRow
                          key={post.id}
                          post={post}
                          // Under its own heading, a post is named by its place,
                          // or by its description when it is about the area.
                          title={single ? null : post.place}
                          onOpen={show}
                        />
                      ))}
                    </ul>
                  )}
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
          onIndexChange={(index) => {
            setOpen(index);
            const post = sequence[index];
            if (post && !post.viewed) void patch(post.id, { viewed: true });
          }}
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
          onChangeCategory={(id, category) => patch(id, { category })}
        />
      )}
    </div>
  );
}

type Sort = "alpha" | "count";
const SORT_KEY = "curated.travel.sort";

function regionKey(country: string, region: string) {
  return `${country} / ${region}`;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
      className={`shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`}
    >
      <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * One post. With no place of its own to name - a post about the region as a
 * whole - the description is the title, rather than the region's name over
 * and over.
 */
function PlaceRow({
  post,
  title,
  detail = null,
  onOpen,
}: {
  post: TravelPost;
  title: string | null;
  detail?: string | null;
  onOpen: (post: TravelPost) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(post)}
        className="flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-sunk"
      >
        {post.thumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={post.thumbnail} alt="" className="h-14 w-14 shrink-0 rounded-lg object-cover" />
        ) : (
          <span className="h-14 w-14 shrink-0 rounded-lg bg-sunk" />
        )}
        <span className="min-w-0 flex-1">
          {title ? (
            <>
              <span className="flex items-center gap-1.5 text-[15px] text-ink">
                {!post.viewed && <span aria-label="unread" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
                <span className="truncate">{title}</span>
                {detail && <span className="shrink-0 text-[13px] text-muted">· {detail}</span>}
              </span>
              {post.summary && <span className="mt-0.5 line-clamp-2 text-[13px] text-muted">{post.summary}</span>}
            </>
          ) : (
            <span className="flex items-start gap-1.5">
              {!post.viewed && (
                <span aria-label="unread" className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
              )}
              <span className="line-clamp-2 text-[14px] text-ink">{post.summary ?? "A post about the area"}</span>
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

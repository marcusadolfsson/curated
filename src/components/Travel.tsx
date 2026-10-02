"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import PostPreview from "./PostPreview";
import TravelMap from "./TravelMap";
import type { TravelCountry, TravelPost } from "@/app/api/travel/route";

type TravelData = {
  countries: TravelCountry[];
  places: number;
  regions: number;
  waiting: boolean;
  locating: { running: boolean; done: number; total: number; error: string | null };
};

type View = "map" | "list";
const VIEW_KEY = "curated.travel.view";

/**
 * Every place she has sent, two ways.
 *
 * Map: a world map counting posts in circles, and under it every post inside
 * the area on screen - pan or zoom and the list follows, so a tap on a circle
 * is also a filter. A–Z: every country and the regions in it, folded, a
 * region opening to show its posts. Either way a post opens in the same
 * viewer as the feed, stepping through whatever the tab lists, in its order.
 */
export default function Travel() {
  const [data, setData] = useState<TravelData | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [view, setView] = useState<View>("map");
  /** The posts inside the area the map shows. */
  const [inView, setInView] = useState<TravelPost[]>([]);
  /** Regions showing their posts, by `country / region`. Everything starts folded. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Which tab is a per-viewer convenience, so it lives in this browser only.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(VIEW_KEY);
      if (saved === "map" || saved === "list") setView(saved);
    } catch {
      // private mode or storage blocked: the map it is
    }
  }, []);
  const chooseView = (next: View) => {
    setView(next);
    setOpen(null);
    try {
      window.localStorage.setItem(VIEW_KEY, next);
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

  /** Countries and their regions, alphabetically. */
  const countries = useMemo(() => {
    const byName = (a: string, b: string) => a.localeCompare(b);
    return (data?.countries ?? [])
      .map((country) => ({
        ...country,
        regions: [...country.regions].sort((a, b) => byName(a.region, b.region)),
      }))
      .sort((a, b) => byName(a.country, b.country));
  }, [data]);

  /** Every placed post, for the map and the A–Z list. */
  const everything = useMemo(() => countries.flatMap((c) => c.regions.flatMap((r) => r.posts)), [countries]);

  /** What the map lists under it, grouped and in order. */
  const inViewGroups = useMemo(() => groupPosts(inView), [inView]);

  /** The posts the viewer steps through: whatever the open tab lists, in its order. */
  const sequence = useMemo(
    () => (view === "map" ? inViewGroups.flatMap((g) => g.places.flatMap((p) => p.posts)) : everything),
    [view, inViewGroups, everything],
  );

  const allKeys = useMemo(
    () => countries.flatMap((c) => c.regions.map((r) => regionKey(c.country, r.region))),
    [countries],
  );
  const everythingOpen = allKeys.length > 0 && allKeys.every((key) => expanded.has(key));

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
      <header className="flex flex-wrap items-end justify-between gap-4 pt-10 pb-5">
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

      {everything.length > 0 && (
        <div className="mb-5 flex items-center justify-between gap-3">
          <div role="tablist" aria-label="View" className="flex rounded-full bg-sunk p-0.5 text-[14px]">
            {(
              [
                ["map", "Map"],
                ["list", "A–Z"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={view === value}
                onClick={() => chooseView(value)}
                className={`rounded-full px-4 py-1.5 transition-colors ${
                  view === value ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {view === "list" && (
            <button
              type="button"
              onClick={() => setExpanded(everythingOpen ? new Set() : new Set(allKeys))}
              className="text-[13px] text-accent underline-offset-4 hover:underline"
            >
              {everythingOpen ? "Collapse all" : "Expand all"}
            </button>
          )}
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

      {view === "map" && everything.length > 0 && (
        <>
          <TravelMap posts={everything} onOpen={show} onViewChange={setInView} />
          <InView groups={inViewGroups} total={inView.length} onOpen={show} />
        </>
      )}

      {view === "list" &&
        countries.map((country) => (
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
                // A place sent once is named by its city, not the spot - the
                // spot is in the post underneath, one tap away.
                const label = sameAsSection ? `Across ${region.region}` : (single?.city ?? region.region);
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
                      <span className="min-w-0 flex-1 truncate text-[15px] text-ink">{label}</span>
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
          onNote={(id, note) => patch(id, { note })}
          onChangeCategory={(id, category) => patch(id, { category })}
        />
      )}
    </div>
  );
}

type Group = { country: string; count: number; places: { region: string; posts: TravelPost[] }[] };

/** Posts by country, then place - the biggest first, since that is the question a view of the map asks. */
function groupPosts(posts: TravelPost[]): Group[] {
  const byCountry = new Map<string, Map<string, TravelPost[]>>();
  for (const post of posts) {
    const country = post.country ?? post.region;
    const places = byCountry.get(country) ?? new Map<string, TravelPost[]>();
    const list = places.get(post.region) ?? [];
    list.push(post);
    places.set(post.region, list);
    byCountry.set(country, places);
  }
  return [...byCountry.entries()]
    .map(([country, places]) => ({
      country,
      count: [...places.values()].reduce((sum, list) => sum + list.length, 0),
      places: [...places.entries()]
        .map(([region, list]) => ({ region, posts: list }))
        .sort((a, b) => b.posts.length - a.posts.length || a.region.localeCompare(b.region)),
    }))
    .sort((a, b) => b.count - a.count || a.country.localeCompare(b.country));
}

/**
 * Everything inside the area the map shows, under it.
 *
 * With several places in view each one is a folded line - a count and an
 * unread dot - opened by a tap, the same as the A–Z list; a long scroll of
 * posts under a map of a continent answers nothing. Zoomed in to a single
 * place there is nothing to choose between, so its posts show straight away.
 */
function InView({
  groups,
  total,
  onOpen,
}: {
  groups: Group[];
  total: number;
  onOpen: (post: TravelPost) => void;
}) {
  /** Places opened by hand. Kept while the map moves, so a pan does not shut them. */
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setOpened((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const places = groups.reduce((sum, group) => sum + group.places.length, 0);
  const folded = places > 1;

  const summary =
    groups.length === 0
      ? "nothing in this part of the map"
      : groups.length === 1
        ? groups[0].places.length === 1
          ? groups[0].places[0].region
          : `${groups[0].places.length} places in ${groups[0].country}`
        : `${groups.length} countries`;

  return (
    <div className="mt-4">
      <p className="px-1 text-[14px] text-ink">
        <span className="font-medium">
          {total} post{total === 1 ? "" : "s"} in view
        </span>
        <span className="text-muted"> · {summary}</span>
      </p>

      <div className="mt-2 space-y-4">
        {groups.map((group) => (
          <section key={group.country} className="border-t border-line pt-3">
            <h2 className="flex items-baseline justify-between font-serif text-xl">
              {group.country}
              <span className="font-sans text-[13px] text-muted">{group.count}</span>
            </h2>

            {folded ? (
              <ul className="mt-1.5">
                {group.places.map((place) => {
                  const key = regionKey(group.country, place.region);
                  const isOpen = opened.has(key);
                  const single = place.posts.length === 1 ? place.posts[0] : null;
                  const label =
                    place.region === group.country ? `Across ${place.region}` : (single?.city ?? place.region);
                  const unread = place.posts.filter((post) => !post.viewed).length;
                  return (
                    <li key={place.region}>
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        onClick={() => toggle(key)}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-sunk"
                      >
                        <Chevron open={isOpen} />
                        <span className="min-w-0 flex-1 truncate text-[15px] text-ink">{label}</span>
                        {unread > 0 && (
                          <span aria-label={`${unread} unread`} className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                        )}
                        <span className="w-6 shrink-0 text-right text-[13px] text-muted">{place.posts.length}</span>
                      </button>
                      {isOpen && (
                        <ul className="mt-0.5 mb-2 space-y-1 pl-6">
                          {place.posts.map((post) => (
                            <PlaceRow key={post.id} post={post} title={single ? null : post.place} onOpen={onOpen} />
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              group.places.map((place) => (
                <ul key={place.region} className="mt-1.5 space-y-1">
                  {place.posts.map((post) => (
                    <PlaceRow key={post.id} post={post} title={post.place ?? post.city} onOpen={onOpen} />
                  ))}
                </ul>
              ))
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

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
  onOpen,
}: {
  post: TravelPost;
  title: string | null;
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

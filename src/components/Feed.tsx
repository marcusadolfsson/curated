"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import PostRow from "./PostRow";
import PostPreview from "./PostPreview";
import CategoryMenu from "./CategoryMenu";
import type { PostView } from "@/lib/serialize";
import type { SyncState } from "@/lib/sync";
import { PHONE, useMediaQuery } from "@/lib/useMediaQuery";

/**
 * One opening per launch, held outside the component.
 *
 * Coming back from the chat page remounts this, and that is not a launch - the
 * viewer used to open a second or two after you had deliberately returned to
 * the list. A ref inside the component cannot tell the two apart; a new
 * document can.
 */
const launched = { done: false };

type FeedResponse = {
  posts: PostView[];
  total: number;
  unread: number;
  saved: number;
  categories: Record<string, number>;
  /** False when there is no Claude credential: nothing is described or filed. */
  analysis?: boolean;
};

type SessionInfo = { connected: boolean; username: string | null };

type Watcher = { listening: boolean; lastEventAt: string | null; syncsTriggered: number };

type Pause = { paused: boolean; until: string | null; reason: string | null };

type StateFilter = "unread" | "all" | "read" | "saved";

export default function Feed() {
  const [data, setData] = useState<FeedResponse | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sync, setSync] = useState<SyncState | null>(null);
  const [pause, setPause] = useState<Pause | null>(null);
  const [watcher, setWatcher] = useState<Watcher | null>(null);
  const [stateFilter, setStateFilter] = useState<StateFilter>("unread");
  const [category, setCategory] = useState("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<PostView | null>(null);
  const searchTimer = useRef<NodeJS.Timeout | null>(null);

  const loadFeed = useCallback(async () => {
    const query = new URLSearchParams({ state: stateFilter, category });
    if (search.trim()) query.set("q", search.trim());

    const response = await fetch(`/api/posts?${query}`);
    if (response.ok) setData((await response.json()) as FeedResponse);
    setLoading(false);
  }, [stateFilter, category, search]);

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => void loadFeed(), search ? 250 : 0);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [loadFeed, search]);

  useEffect(() => {
    void fetch("/api/sync")
      .then((r) => r.json())
      .then((body: { pause?: Pause }) => body.pause && setPause(body.pause))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const load = () =>
      void fetch("/api/watch")
        .then((r) => (r.ok ? r.json() : null))
        .then((body: Watcher | null) => body && setWatcher(body))
        .catch(() => undefined);
    load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    void fetch("/api/session")
      .then((r) => r.json())
      .then(setSession)
      .catch(() => setSession({ connected: false, username: null }));
  }, []);

  // New posts arrive on the hour whether or not the tab is open, so refresh
  // quietly in the background rather than waiting for a reload.
  useEffect(() => {
    const timer = setInterval(() => void loadFeed(), 120_000);
    return () => clearInterval(timer);
  }, [loadFeed]);

  // While a sync runs, poll it and refresh the feed as posts land.
  useEffect(() => {
    if (!sync?.running) return;
    const timer = setInterval(async () => {
      const response = await fetch("/api/sync");
      if (!response.ok) return;
      const body = (await response.json()) as { state: SyncState; pause?: Pause };
      setSync(body.state);
      if (body.pause) setPause(body.pause);
      void loadFeed();
    }, 2000);
    return () => clearInterval(timer);
  }, [sync?.running, loadFeed]);

  const resume = async () => {
    await fetch("/api/pause", { method: "DELETE" });
    setPause({ paused: false, until: null, reason: null });
  };

  // The list as it stood when the modal opened. Swiping walks through that,
  // not the live list: on the unread tab the post you are looking at leaves
  // the live list the moment it is marked read, which would make "next"
  // jump around under you.
  const [sequence, setSequence] = useState<PostView[]>([]);

  // Leaving a post is what marks it read, not opening it: you have seen it once
  // you have moved past it. Glancing at the top of the pile and putting the
  // phone down therefore costs nothing.
  const openPreview = (post: PostView) => {
    setSequence(data?.posts ?? []);
    setPreview(post);
  };

  const closePreview = () => {
    if (preview) markRead(preview);
    setPreview(null);
  };

  const positionOf = (post: PostView) => sequence.findIndex((p) => p.id === post.id);

  // On a phone the app opens on the first unread post, full screen, and does
  // so again every time it comes back to the foreground - the list is where
  // you go when you swipe out, not where you land.
  const phone = useMediaQuery(PHONE);
  // On a clean open the list is never shown: it would be a flash of something
  // you did not ask for, on the way to the post you did. It starts true on the
  // server too, so the dark is in the very first bytes rather than waiting for
  // hydration - and it is hidden above phone widths, so a desktop never sees it.
  const [launching, setLaunching] = useState(true);
  useEffect(() => {
    if (!phone) {
      const settle = setTimeout(() => setLaunching(false), 0);
      return () => clearTimeout(settle);
    }

    const openUnread = async () => {
      try {
        const response = await fetch("/api/posts?state=unread&category=all");
        if (!response.ok) return;
        const body = (await response.json()) as FeedResponse;
        if (body.posts.length === 0) return;
        setStateFilter("unread");
        setCategory("all");
        setSearch("");
        setData(body);
        setSequence(body.posts);
        setPreview(body.posts[0]);
      } finally {
        setLaunching(false);
      }
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") void openUnread();
    };
    document.addEventListener("visibilitychange", onVisible);

    // Coming back from another page in the app is not a launch, so the list is
    // what you get - but the foreground still opens the pile.
    let settle: ReturnType<typeof setTimeout> | undefined;
    if (!launched.done) {
      launched.done = true;
      void openUnread();
    } else {
      settle = setTimeout(() => setLaunching(false), 0);
    }

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      if (settle) clearTimeout(settle);
    };
  }, [phone]);

  const stepTo = (at: number) => {
    const next = sequence[at];
    if (!next) return;
    if (preview) markRead(preview); // the one being left behind
    // The live copy if it is still there (fresher saved/reacted state), else the snapshot.
    setPreview(data?.posts.find((p) => p.id === next.id) ?? next);
  };

  // The snapshot a post came from keeps saying unread after it is marked, so
  // swiping back and forth over one would send the same patch again.
  const marked = useRef<Set<number>>(new Set());
  // Warm the next post while you are looking at this one, the way a reel
  // buffers the one below it. Only what is missing: the endpoint answers from
  // the cache otherwise and asks Instagram nothing. Fetching it now also means
  // the next reel's player mounts with its source already set, which is what
  // lets it start with sound inside the swipe.
  const prefetched = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (!preview) return;
    const index = sequence.findIndex((p) => p.id === preview.id);
    const next = index >= 0 ? sequence[index + 1] : undefined;
    if (!next || next.mediaReady || prefetched.current.has(next.id)) return;

    // A beat first, so flicking through a run of posts does not fetch every one.
    const timer = setTimeout(() => {
      if (document.visibilityState === "hidden") return;
      prefetched.current.add(next.id);
      void fetch(`/api/posts/${next.id}/images`)
        .then((response) => (response.ok ? (response.json() as Promise<{ video?: string | null }>) : null))
        .then((body) => {
          if (!body) return;
          const fill = (post: PostView) =>
            post.id === next.id
              ? { ...post, video: body.video ?? post.video, mediaReady: true }
              : post;
          setSequence((current) => current.map(fill));
          setData((current) => (current ? { ...current, posts: current.posts.map(fill) } : current));
        })
        .catch(() => undefined);
    }, 600);

    return () => clearTimeout(timer);
  }, [preview, sequence]);

  const markRead = (post: PostView) => {
    if (post.viewed || marked.current.has(post.id)) return;
    marked.current.add(post.id);
    void patch(post.id, { viewed: true });
  };

  const toggleSaved = async (id: number, saved: boolean) => {
    await patch(id, { saved });
  };

  const patch = async (id: number, changes: { viewed?: boolean; saved?: boolean; category?: string }) => {
    await fetch(`/api/posts/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(changes),
    });
    await loadFeed();
  };

  const replyTo = async (id: number, text: string): Promise<string | null> => {
    const response = await fetch(`/api/posts/${id}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const body = (await response.json()) as { error?: string | null };
    void loadFeed();
    return response.ok ? null : (body.error ?? "That reply did not send.");
  };

  const react = async (id: number, emoji?: string) => {
    const response = await fetch(`/api/posts/${id}/react`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(emoji ? { emoji } : {}),
    });
    if (!response.ok) {
      const body = (await response.json()) as { error?: string };
      throw new Error(body.error ?? "That reaction did not send.");
    }
    void loadFeed();
  };

  /** Default true, so the filter does not blink out while the first load runs. */
  const describing = data?.analysis ?? true;

  const categories = useMemo(() => {
    const entries = Object.entries(data?.categories ?? {});
    return entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [data?.categories]);

  return (
    <div className="mx-auto max-w-4xl px-4 pb-24 sm:px-6">
      {/* Nothing but the dark until the post is up. The list is behind it
          either way; showing it first only advertises the wait. */}
      {launching && !preview && <div className="fixed inset-0 z-50 bg-black md:hidden" />}
      <header className="flex flex-wrap items-end justify-between gap-4 pt-8 pb-5 sm:pt-10 sm:pb-6">
        <div>
          <h1 className="font-serif text-[34px] leading-none tracking-tight sm:text-[40px]">Curated</h1>
          <p className="mt-2 text-[14px] text-muted sm:text-[15px]">
            {headline(data, session)}
            {watcher?.listening && (
              <span className="ml-2 inline-flex items-center gap-1.5 text-accent">
                <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
                live
              </span>
            )}
          </p>
        </div>

        <nav className="flex items-center gap-1 text-[14px]" aria-label="Pages">
          {[
            ["/chat", "Chat"],
            ["/report", "Report"],
            ["/setup", "Setup"],
          ].map(([href, label]) => (
            <Link
              key={href}
              href={href}
              className="rounded-full px-3 py-1.5 text-ink-soft transition-colors hover:bg-sunk hover:text-ink"
            >
              {label}
            </Link>
          ))}
        </nav>
      </header>

      {sync && (sync.running || sync.phase === "error" || sync.postsAdded > 0) && (
        <p
          className={`mb-4 border-l-2 pl-3 text-[13px] ${
            sync.phase === "error" ? "border-danger text-danger" : "border-line text-muted"
          }`}
        >
          {sync.phase === "error" ? sync.error : syncLine(sync)}
        </p>
      )}

      {pause?.paused && (
        <p className="mb-4 border-l-2 border-danger pl-3 text-[13px] text-danger">
          Syncing is stopped until {new Date(pause.until as string).toLocaleString()}.{" "}
          {pause.reason}{" "}
          <button type="button" onClick={resume} className="underline underline-offset-4">
            Start again now
          </button>
        </p>
      )}

      {session?.connected === false && (
        <p className="mb-4 border-l-2 border-danger pl-3 text-[13px] text-danger">
          Not signed in to Instagram.{" "}
          <Link href="/setup" className="underline underline-offset-4">
            Sign in on the setup page
          </Link>{" "}
          to start reading your messages.
        </p>
      )}

      <div className="sticky top-0 z-10 -mx-4 mb-1 border-b border-line bg-paper/92 px-4 py-2.5 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-center gap-x-1 gap-y-2 text-[13px] sm:gap-x-1.5">
          {(["unread", "all", "read", "saved"] as StateFilter[]).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setStateFilter(value)}
              aria-pressed={stateFilter === value}
              className={`rounded-full px-3 py-1.5 transition-colors ${
                stateFilter === value
                  ? "bg-sunk text-ink"
                  : "text-muted hover:bg-sunk/60 hover:text-ink"
              }`}
            >
              {LABELS[value]}
              {value === "saved" && (data?.saved ?? 0) > 0 && (
                <span className="ml-1.5 tabular-nums opacity-70">{data?.saved}</span>
              )}
            </button>
          ))}

          <span aria-hidden className="mx-1.5 hidden h-4 w-px bg-line sm:block" />

          {describing && (
            <CategoryMenu value={category} categories={categories} onChange={setCategory} />
          )}

          <label className="ml-auto flex items-center gap-2">
            <span className="sr-only">Search these posts</span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search"
              className="w-28 rounded-full bg-sunk/70 px-3 py-1.5 text-[13px] placeholder:text-muted focus:bg-sunk focus:outline-none focus:ring-2 focus:ring-accent/60 sm:w-40"
            />
          </label>
        </div>
      </div>

      {loading ? (
        <p className="py-16 text-center text-[14px] text-muted">Opening Curated</p>
      ) : data && data.posts.length > 0 ? (
        <div>
          {data.posts.map((post) => (
            <PostRow
              key={post.id}
              post={post}
              describing={describing}
              onToggleSaved={toggleSaved}
              onPreview={openPreview}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          stateFilter={stateFilter}
          hasAny={(data?.total ?? 0) > 0}
          connected={session?.connected ?? false}
        />
      )}
      {preview && (
        // Not keyed by post: the viewer holds the neighbouring pictures too,
        // and they have to survive the post changing under them.
        <PostPreview
          sequence={positionOf(preview) >= 0 ? sequence : [preview]}
          index={Math.max(0, positionOf(preview))}
          onIndexChange={stepTo}
          onClose={closePreview}
          onToggleSaved={toggleSaved}
          onReact={react}
          onReply={replyTo}
          onChangeCategory={(id, category) => patch(id, { category })}
          describing={describing}
        />
      )}
    </div>
  );
}

const LABELS: Record<StateFilter, string> = {
  unread: "Unread",
  all: "Everything",
  read: "Read",
  saved: "Saved",
};

function EmptyState({
  stateFilter,
  hasAny,
  connected,
}: {
  stateFilter: StateFilter;
  hasAny: boolean;
  connected: boolean;
}) {
  if (!connected) {
    return (
      <div className="py-16">
        <p className="font-serif text-xl">Nothing here yet.</p>
        <p className="mt-2 max-w-[46ch] text-[14px] text-muted">
          Sign in to Instagram on the setup page, choose whose messages to follow, and check for new
          posts.
        </p>
        <Link
          href="/setup"
          className="mt-4 inline-block rounded-sm bg-accent px-3.5 py-2 text-[14px] text-paper"
        >
          Go to setup
        </Link>
      </div>
    );
  }

  if (!hasAny) {
    return (
      <div className="py-16">
        <p className="font-serif text-xl">Nothing here yet.</p>
        <p className="mt-2 max-w-[46ch] text-[14px] text-muted">
          Check for new posts and anything shared into your DMs will land here, read and sorted.
        </p>
      </div>
    );
  }

  return (
    <div className="py-16">
      <p className="font-serif text-xl">
        {stateFilter === "unread"
          ? "Nothing unread."
          : stateFilter === "saved"
            ? "Nothing saved yet."
            : "Nothing matches that."}
      </p>
      <p className="mt-2 text-[14px] text-muted">
        {stateFilter === "unread"
          ? "You are caught up. Switch to Everything to look back."
          : stateFilter === "saved"
            ? "Save a post and it stays here, whether or not you have read it."
            : "Try a different kind, or clear the search."}
      </p>
    </div>
  );
}

function headline(data: FeedResponse | null, session: SessionInfo | null): string {
  if (!data) return "Loading";
  const parts: string[] = [];
  parts.push(data.unread === 0 ? "Nothing unread" : `${data.unread} unread`);
  parts.push(`${data.total} in all`);
  if (session?.username) parts.push(`signed in as ${session.username}`);
  return parts.join(", ");
}

function syncLine(sync: SyncState): string {
  if (!sync.running) {
    return sync.postsAdded > 0
      ? `Added ${sync.postsAdded} post${sync.postsAdded === 1 ? "" : "s"}`
      : "Nothing new";
  }
  if (sync.phase === "analyzing" && sync.analysisTotal > 0) {
    return `Describing posts, ${sync.postsAnalyzed} of ${sync.analysisTotal} done`;
  }
  return sync.message || "Working";
}

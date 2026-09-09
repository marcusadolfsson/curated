"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import PostRow from "./PostRow";
import PostPreview from "./PostPreview";
import HeaderMenu from "./HeaderMenu";
import FilterMenu, { type Person } from "./FilterMenu";
import { ChatIcon, SearchIcon } from "./icons";
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
  senders?: Person[];
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
  const [sender, setSender] = useState("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<PostView | null>(null);
  const searchTimer = useRef<NodeJS.Timeout | null>(null);
  /** The search field is folded away until asked for; the header holds a glass. */
  const [searching, setSearching] = useState(false);
  const searchBox = useRef<HTMLInputElement | null>(null);
  /** A post asked for by ?post=<id>, until it has been opened. */
  const wanted = useRef<number | null>(null);
  /** The query string the data on screen came from. */
  const loadedQuery = useRef<string>("");

  const loadFeed = useCallback(async () => {
    const query = new URLSearchParams({ state: stateFilter, category });
    if (sender !== "all") query.set("sender", sender);
    if (search.trim()) query.set("q", search.trim());

    const asked = query.toString();
    const response = await fetch(`/api/posts?${query}`);
    if (response.ok) {
      loadedQuery.current = asked;
      setData((await response.json()) as FeedResponse);
    }
    setLoading(false);
  }, [stateFilter, category, sender, search]);

  /**
   * A link to one post, which is how the chat opens a share here rather than
   * sending you to Instagram. The whole pile is loaded rather than the current
   * filter, because the post being linked to is usually one you have already
   * read and the default view is unread.
   */
  useEffect(() => {
    const asked = Number(new URLSearchParams(window.location.search).get("post"));
    if (!Number.isFinite(asked) || asked <= 0) return;
    wanted.current = asked;
    setStateFilter("all");
    setCategory("all");
    // Leave the address bar clean, so a reload does not reopen it forever.
    const url = new URL(window.location.href);
    url.searchParams.delete("post");
    window.history.replaceState(null, "", url);
  }, []);

  // Once the pile holding it has arrived, open it.
  useEffect(() => {
    if (wanted.current === null || !data) return;

    const post = data.posts.find((p) => p.id === wanted.current);
    if (post) {
      wanted.current = null;
      setSequence(data.posts);
      setPreview(post);
      return;
    }

    // Not here - but the first payload to land is usually the unread list the
    // page opens with, and a post being linked to from the conversation has
    // almost always been read. Only give up once the whole pile has actually
    // arrived, rather than on whatever answered first.
    if (loadedQuery.current === new URLSearchParams({ state: "all", category: "all" }).toString()) {
      wanted.current = null;
    }
  }, [data]);

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
  /**
   * The post the phone opened by itself at launch.
   *
   * Backing out of that one does not count as having read it: you were put
   * there, you did not go. Swiping past it to the next post does count, and so
   * does opening it yourself from the list afterwards - both clear this.
   */
  const landedOn = useRef<number | null>(null);

  const openPreview = (post: PostView) => {
    landedOn.current = null; // you chose this one
    setSequence(data?.posts ?? []);
    setPreview(post);
  };

  const closePreview = () => {
    // Give the hash entry back, and let its listener do the closing, so the X
    // and the back gesture end in exactly the same state.
    if (hashHeld.current) {
      window.history.back();
      return;
    }
    const current = showing.current ?? preview;
    if (current && current.id !== landedOn.current) markRead(current);
    landedOn.current = null;
    setPreview(null);
  };

  const positionOf = (post: PostView) => sequence.findIndex((p) => p.id === post.id);

  /**
   * The post on screen right now, for anything that needs it outside a render.
   */
  const showing = useRef<PostView | null>(null);
  useEffect(() => {
    showing.current = preview;
  }, [preview]);

  /**
   * A post is a place, so back should leave the post rather than the app.
   *
   * Without an entry of its own the phone's back gesture ran on the page
   * history: swipe right out of a reel and you landed on whatever you had
   * visited before the feed, which for anyone who had opened the chat was the
   * chat.
   *
   * The entry is a location hash rather than history.pushState. Next patches
   * pushState and answers it by re-rendering the route, which resets this
   * component and closes the very post it was asked to remember. A hash change
   * pushes a real history entry without going anywhere near that.
   */
  const hashHeld = useRef(false);
  useEffect(() => {
    if (!preview) return;

    if (window.location.hash !== "#post") {
      window.location.hash = "post";
      hashHeld.current = true;
    }

    const onHashChange = () => {
      if (window.location.hash === "#post") return; // still open
      hashHeld.current = false;
      const current = showing.current;
      if (current && current.id !== landedOn.current) markRead(current);
      landedOn.current = null;
      setPreview(null);
    };

    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
    // Only as the preview opens and closes; stepping between posts keeps the
    // one entry rather than stacking one per post.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview !== null]);

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
      // Asked for a particular post: that wins over the newest unread.
      if (wanted.current !== null) {
        setLaunching(false);
        return;
      }
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
        landedOn.current = body.posts[0].id;
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
    if (preview) markRead(preview); // the one being left behind - swiping past it counts
    landedOn.current = null;
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

  /**
   * Everyone who sends, not just everyone in the view you are looking at.
   *
   * The people come from the current query, so switching to Read - where maybe
   * only one of them has anything - would drop the control out of the bar and
   * shift the row under your thumb mid-tap. Once someone has appeared they stay
   * in the list, with the count from whatever is on screen now.
   */
  const everSent = useRef<Map<string, Person>>(new Map());
  const people = useMemo(() => {
    for (const person of data?.senders ?? []) everSent.current.set(person.username, person);
    const here = new Map((data?.senders ?? []).map((person) => [person.username, person]));
    return [...everSent.current.values()]
      .map((person) => here.get(person.username) ?? { ...person, count: 0 })
      .sort((a, b) => b.count - a.count || a.username.localeCompare(b.username));
  }, [data?.senders]);

  const categories = useMemo(() => {
    const entries = Object.entries(data?.categories ?? {});
    return entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [data?.categories]);

  return (
    <div className="mx-auto max-w-4xl px-4 pb-24 sm:px-6">
      {/* Nothing but the dark until the post is up. The list is behind it
          either way; showing it first only advertises the wait. */}
      {launching && !preview && <div className="fixed inset-0 z-50 bg-black md:hidden" />}
      {/* One row: the name, and two round buttons. What used to be three words
          of links is a chat bubble and a cog, which is what a phone expects
          and what leaves the name room to be the name. */}
      <header className="flex items-start justify-between gap-4 pt-5 pb-4 sm:pt-8 sm:pb-5">
        <div className="min-w-0">
          <h1 className="font-serif text-[32px] leading-none tracking-tight sm:text-[40px]">Curated</h1>
          <p className="mt-1.5 text-[13.5px] text-muted sm:mt-2 sm:text-[15px]">
            {headline(data)}
            {watcher?.listening && (
              <span className="ml-2 inline-flex items-center gap-1.5 text-accent">
                <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
                live
              </span>
            )}
          </p>
        </div>

        <nav className="-mr-2 flex shrink-0 items-center gap-0.5 pt-0.5 sm:-mr-2.5" aria-label="Pages">
          <Link href="/chat" aria-label="Chat" title="Chat" className={ICON_BUTTON}>
            <ChatIcon />
          </Link>
          <button
            type="button"
            aria-label="Search"
            aria-expanded={searching || Boolean(search)}
            title="Search"
            onClick={() => {
              const next = !(searching || search);
              setSearching(next);
              if (!next) setSearch("");
              // Focus after the field exists.
              if (next) requestAnimationFrame(() => searchBox.current?.focus());
            }}
            className={`${ICON_BUTTON} ${searching || search ? "bg-sunk text-ink" : ""}`}
          >
            <SearchIcon />
          </button>
          <HeaderMenu className={ICON_BUTTON} />
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
        {/* One row, always. Wrapping put Filter on a line of its own and made
            the whole bar - and the list under it - jump down by a row. So the
            four states are the part that gives: they scroll sideways on a
            screen too narrow for them, and Filter keeps its place on the end. */}
        <div className="flex items-center gap-x-1 text-[13px] sm:gap-x-1.5">
          <div className="scroll-row -my-1.5 flex min-w-0 items-center gap-x-1 overflow-x-auto py-1.5 sm:gap-x-1.5">
            {(["unread", "all", "read", "saved"] as StateFilter[]).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setStateFilter(value)}
                aria-pressed={stateFilter === value}
                aria-label={LABELS[value]}
                className={`shrink-0 rounded-full px-2.5 py-1.5 transition-colors sm:px-3 ${
                  stateFilter === value
                    ? "bg-sunk text-ink"
                    : "text-muted hover:bg-sunk/60 hover:text-ink"
                }`}
              >
                {/* "Everything" is the honest word and there is room for it on
                    a desktop. A phone gets the short one. */}
                <span className="sm:hidden">{SHORT_LABELS[value]}</span>
                <span className="hidden sm:inline">{LABELS[value]}</span>
                {value === "saved" && (data?.saved ?? 0) > 0 && (
                  <span className="ml-1.5 tabular-nums opacity-70">{data?.saved}</span>
                )}
              </button>
            ))}
          </div>

          <span aria-hidden className="mx-1.5 hidden h-4 w-px bg-line sm:block" />

          {/* One menu: what kind, and who from. Either half appears only when
              there is a choice inside it. */}
          {(describing || people.length > 1) && (
            <FilterMenu
              className="shrink-0"
              category={category}
              categories={describing ? categories : []}
              onCategory={setCategory}
              sender={sender}
              people={people}
              onSender={setSender}
            />
          )}

          {(searching || search) && (
            <label className="ml-auto flex shrink-0 items-center gap-2">
              <span className="sr-only">Search these posts</span>
              <input
                ref={searchBox}
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  setSearch("");
                  setSearching(false);
                }}
                placeholder="Search"
                className="w-36 rounded-full bg-sunk/70 px-3 py-1.5 text-[13px] placeholder:text-muted focus:bg-sunk focus:outline-none focus:ring-2 focus:ring-accent/60 sm:w-48"
              />
            </label>
          )}
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

/** A round, thumb-sized target. Quiet until touched. */
const ICON_BUTTON =
  "flex h-10 w-10 items-center justify-center rounded-full text-ink-soft transition-colors hover:bg-sunk hover:text-ink active:bg-sunk";

const LABELS: Record<StateFilter, string> = {
  unread: "Unread",
  all: "Everything",
  read: "Read",
  saved: "Saved",
};

/** The phone's version of the same four, where the row is 358px wide. */
const SHORT_LABELS: Record<StateFilter, string> = {
  unread: "Unread",
  all: "All",
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

function headline(data: FeedResponse | null): string {
  if (!data) return "Loading";
  const parts: string[] = [];
  parts.push(data.unread === 0 ? "Nothing unread" : `${data.unread} unread`);
  parts.push(`${data.total} in all`);
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

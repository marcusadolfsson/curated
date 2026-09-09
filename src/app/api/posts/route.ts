import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, inArray, isNull, like, or, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { posts, threads } from "@/db/schema";
import { toPostView } from "@/lib/serialize";
import { analysisAvailable } from "@/lib/claude-auth";

export const dynamic = "force-dynamic";

/** Posts the model has not described yet still need somewhere to be counted. */
const UNCATEGORISED = "Not described";

// GET /api/posts?state=unread|read|all&category=Food&q=pasta
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const state = params.get("state") ?? "all";
  const category = params.get("category");
  const sender = params.get("sender");
  const search = params.get("q")?.trim();

  // Two sets: what limits the list, and what the category counts are measured
  // against. The counts follow the state and the search but not the category
  // itself - otherwise choosing one would zero every other number and there
  // would be no way back.
  const scope: SQL[] = [];
  const filters: SQL[] = [];

  // Only the conversations you follow. The first sync ran before anything was
  // ticked, so it imported the whole inbox; those posts stay in the database
  // but should not be in the feed. With nothing ticked, everything shows -
  // same rule the sync itself uses.
  const watched = await db
    .select({ threadId: threads.threadId })
    .from(threads)
    .where(eq(threads.watch, true));

  if (watched.length > 0) {
    scope.push(inArray(posts.threadId, watched.map((thread) => thread.threadId)));
  }
  if (state === "unread") scope.push(eq(posts.viewed, false));
  if (state === "read") scope.push(eq(posts.viewed, true));
  if (state === "saved") scope.push(eq(posts.saved, true));
  if (category === UNCATEGORISED) {
    filters.push(isNull(posts.category));
  } else if (category && category !== "all") {
    filters.push(eq(posts.category, category));
  }
  // Who sent it, when you follow more than one person. Filtered like the
  // category rather than scoped like the state, so the people list keeps
  // showing everyone while one of them is selected.
  if (sender && sender !== "all") filters.push(eq(posts.senderUsername, sender));

  if (search) {
    const term = `%${search}%`;
    const match = or(
      like(posts.summary, term),
      like(posts.caption, term),
      like(posts.items, term),
      like(posts.authorUsername, term),
    );
    if (match) scope.push(match);
  }

  filters.push(...scope);

  const rows = await db
    .select()
    .from(posts)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(posts.sharedAt), desc(posts.id));

  // Category counts within the current view.
  const inScope = await db
    .select({
      category: posts.category,
      senderUsername: posts.senderUsername,
      senderAvatarFile: posts.senderAvatarFile,
    })
    .from(posts)
    .where(scope.length > 0 ? and(...scope) : undefined);

  const counts: Record<string, number> = {};
  for (const row of inScope) {
    const key = row.category ?? UNCATEGORISED;
    counts[key] = (counts[key] ?? 0) + 1;
  }

  // The header totals stay global, so "12 unread" means the same thing
  // wherever you are standing.
  const everything = await db
    .select({ viewed: posts.viewed, saved: posts.saved })
    .from(posts)
    .where(
      watched.length > 0
        ? inArray(posts.threadId, watched.map((thread) => thread.threadId))
        : undefined,
    );

  // Everyone who has sent something in this view, most first. The avatar is
  // whichever of their posts carries one, so a person has a face in the filter
  // for the same reason they have one in the row.
  const senderCounts = new Map<string, { username: string; avatar: string | null; count: number }>();
  for (const row of inScope) {
    const username = row.senderUsername;
    if (!username) continue;
    const seen = senderCounts.get(username) ?? { username, avatar: null, count: 0 };
    seen.count += 1;
    if (!seen.avatar && row.senderAvatarFile) seen.avatar = `/api/media/${row.senderAvatarFile}`;
    senderCounts.set(username, seen);
  }
  const senders = [...senderCounts.values()].sort(
    (a, b) => b.count - a.count || a.username.localeCompare(b.username),
  );

  return NextResponse.json({
    posts: rows.map(toPostView),
    senders,
    total: everything.length,
    unread: everything.filter((row) => !row.viewed).length,
    saved: everything.filter((row) => row.saved).length,
    shown: inScope.length,
    categories: counts,
    // Without a Claude credential nothing is described or categorised, and the
    // interface should not offer filters for a thing that will stay empty.
    analysis: analysisAvailable(),
  });
}

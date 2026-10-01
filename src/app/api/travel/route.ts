import { NextResponse } from "next/server";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/db";
import { posts } from "@/db/schema";
import { ownIdentity } from "@/lib/instagram/client";
import { locateState } from "@/lib/places";
import { toPostView, type PostView } from "@/lib/serialize";

export const dynamic = "force-dynamic";

export type TravelPost = PostView & { place: string | null; city: string | null };
export type TravelRegion = { region: string; posts: TravelPost[] };
export type TravelCountry = { country: string; count: number; regions: TravelRegion[] };

/**
 * Every place shared as a travel post, by country and then region.
 *
 * A read; placing posts happens in sync, or by POST /api/travel/locate. The
 * account's own shares are left out: this is the list of where she wants to
 * go, not of where it sent her.
 */
export async function GET() {
  const me = await ownIdentity();
  const rows = (
    await db
      .select()
      .from(posts)
      .where(and(eq(posts.category, "Travel"), isNotNull(posts.placeRegion)))
  ).filter((post) => !(post.senderId && me.ids.has(post.senderId)));

  const byCountry = new Map<string, Map<string, TravelPost[]>>();
  for (const post of rows) {
    // Antarctica, the Arctic, the Red Sea: no country, so the region is
    // its own section rather than "somewhere".
    const country = post.placeCountry ?? (post.placeRegion as string);
    const region = post.placeRegion as string;
    const regions = byCountry.get(country) ?? new Map<string, TravelPost[]>();
    const list = regions.get(region) ?? [];
    list.push({ ...toPostView(post), place: post.place, city: post.placeCity || null });
    regions.set(region, list);
    byCountry.set(country, regions);
  }

  const newestFirst = (a: TravelPost, b: TravelPost) => (b.sharedAt ?? "").localeCompare(a.sharedAt ?? "");
  const countries: TravelCountry[] = [...byCountry.entries()]
    .map(([country, regions]) => ({
      country,
      count: [...regions.values()].reduce((sum, list) => sum + list.length, 0),
      // The regions she keeps coming back to first, then by name.
      regions: [...regions.entries()]
        .map(([region, list]) => ({ region, posts: list.sort(newestFirst) }))
        .sort((a, b) => b.posts.length - a.posts.length || a.region.localeCompare(b.region)),
    }))
    .sort((a, b) => a.country.localeCompare(b.country));

  const [waiting] = await db
    .select({ id: posts.id })
    .from(posts)
    .where(and(eq(posts.category, "Travel"), eq(posts.analysisStatus, "done"), isNull(posts.placedAt)))
    .limit(1);

  return NextResponse.json({
    countries,
    places: rows.length,
    regions: countries.reduce((sum, c) => sum + c.regions.length, 0),
    /** Travel posts not placed yet - nonzero until the backlog has been read. */
    waiting: Boolean(waiting),
    locating: locateState(),
  });
}

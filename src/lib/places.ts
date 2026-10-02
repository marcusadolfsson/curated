import { query } from "@anthropic-ai/claude-agent-sdk";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/db";
import { posts, type Post } from "@/db/schema";
import { agentEnv, claudeAuth } from "@/lib/claude-auth";
import { getSettings } from "@/lib/settings";

/**
 * Where a travel post is, for the Travel list.
 *
 * Read off what the analysis already wrote - the summary, the things it named,
 * the caption - rather than the picture again: 404 of 406 travel posts name
 * their place in words, and a text pass costs a fraction of a look.
 *
 * Posts go in batches, each with the regions already in use, so the model
 * files "Zermatt" under the "Swiss Alps" it used last week instead of
 * inventing "Zermatt area". Grouping is the point of the list, and grouping
 * only works if the names agree.
 */

const BATCH = 25;

const SYSTEM_PROMPT = `You place shared travel posts on a personal travel list. For each post, say where it is.

- place: the most specific named spot the post is about - a hotel, restaurant, beach, trail, viewpoint or town - written as it would appear on a list, with its town when that helps ("Igludorf, Zermatt", "Hotel Yellowstone, Jackson Hole"). Null when the post is not about one location (a cruise ship's features, packing advice, an airline, a general announcement) or the spot cannot be identified.
- region: the area this belongs to, at the level a person would plan a trip around and group a list by. That is a major city (Paris, New York City, Kyoto), a famous named area (Swiss Alps, Amalfi Coast, Banff National Park, Bali, Lake Como, the Dolomites), or - in the United States, Canada and Australia, when the place is not in a famous named area - the state or province (Colorado, Arizona, British Columbia). A town or a single site is a place, never a region: St. Moritz and Val d'Anniviers are places in the Swiss Alps; Estes Park and the Black Canyon of the Gunnison are places in Colorado. Several posts sharing a region is the point, so prefer the broader well-known area to a town.
- city: the town or city the place is in, or nearest to - just its name ("Ocala", "Saratoga", "Charlotte Amalie", "Zermatt"). For a spot in a national park or the wilderness, the park or the nearest town a visitor would stay in. Null when place is null.
- country: the country, its common English name ("United States", "Italy"). For a place in a US state or similar, the state belongs in the region or place, not here.
- lat, lng: where to put it on a map, in decimal degrees - the spot when you know it, otherwise its city, otherwise the middle of its region. Approximate is fine. Null only when there is no location at all.

Regions already on the list are given. When a post belongs to one of them, use that exact name; make a new region only when none fits.

Whenever there is a place or a country, there is a region. When a post is about a destination in general rather than a spot in it ("a three-day guide to Lisbon"), leave place null but set region and country; when it is about a whole country, the region is the country. When there is no location at all, set all three to null. Never guess a location the post does not support.`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    posts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          place: { type: ["string", "null"] },
          city: { type: ["string", "null"] },
          region: { type: ["string", "null"] },
          country: { type: ["string", "null"] },
          lat: { type: ["number", "null"] },
          lng: { type: ["number", "null"] },
        },
        required: ["id", "place", "city", "region", "country", "lat", "lng"],
        additionalProperties: false,
      },
    },
  },
  required: ["posts"],
  additionalProperties: false,
} as const;

type Located = {
  id: number;
  place: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  lat: number | null;
  lng: number | null;
};

type LocateState = { running: boolean; done: number; total: number; error: string | null };
const globalForPlaces = globalThis as unknown as { __places?: LocateState };
const state: LocateState = (globalForPlaces.__places ??= { running: false, done: 0, total: 0, error: null });

export function locateState(): LocateState {
  return { ...state };
}

/** Travel posts that have been described but not yet placed. */
async function pending(): Promise<Post[]> {
  return db
    .select()
    .from(posts)
    .where(and(eq(posts.category, "Travel"), eq(posts.analysisStatus, "done"), isNull(posts.placedAt)));
}

/**
 * Places every travel post still waiting, a batch at a time.
 *
 * One batch after another rather than several at once: each batch is told the
 * regions the ones before it chose, which is what keeps the names consistent.
 */
export async function locatePending(): Promise<{ placed: number; checked: number }> {
  if (state.running) return { placed: 0, checked: 0 };
  if (!claudeAuth().ok) return { placed: 0, checked: 0 };

  const waiting = await pending();
  if (waiting.length === 0) return { placed: 0, checked: 0 };

  Object.assign(state, { running: true, done: 0, total: waiting.length, error: null });
  let placed = 0;
  try {
    for (let start = 0; start < waiting.length; start += BATCH) {
      const batch = waiting.slice(start, start + BATCH);
      const results = await locate(batch, await knownRegions());
      const byId = new Map(results.map((r) => [r.id, r]));
      for (const post of batch) {
        const found = byId.get(post.id);
        // A post the model skipped stays unplaced and is asked about again.
        if (!found) continue;
        // A place or a country with no region would fall off the list, which
        // only shows regions; the most specific name there is stands in.
        const region = clean(found.region) ?? clean(found.place) ?? clean(found.country);
        await db
          .update(posts)
          .set({
            place: clean(found.place),
            placeCity: clean(found.city),
            placeRegion: region,
            placeCountry: clean(found.country),
            ...coordinates(found.lat, found.lng),
            placedAt: new Date(),
          })
          .where(eq(posts.id, post.id));
        if (region) placed += 1;
      }
      state.done = Math.min(start + batch.length, waiting.length);
    }
    console.log(`[places] placed ${placed} of ${waiting.length} travel post(s)`);
    if (placed > 0) await consolidateRegions();
    await fillCities();
    await fillCoordinates();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    console.error("[places] stopped:", error);
  } finally {
    state.running = false;
  }
  return { placed, checked: waiting.length };
}

const MERGE_PROMPT = `You tidy the regions on a personal travel list, so that posts about one area sit together.

You get every region on the list, by country, with how many posts each has and the places in it. Say which regions should be folded into another region of the same country:

- Merge a region into another when it lies inside it, or is the same area under another name: Kauai into Hawaii, Havasupai into Grand Canyon, the Bavarian Alps into Bavaria or the other way round - whichever is the better-known name for the area as a whole.
- Keep the level a person would plan a trip around. A famous named area (Banff National Park, the Dolomites, the Swiss Alps) stays itself and is not folded into its state or province; but a state or province whose places all lie in such an area folds into it.
- A region named after the whole country takes posts that are about the country in general. Leave it alone.
- Never merge two separate areas because they are near each other, and never merge across countries.
- When in doubt, do not merge. Return only the merges you are sure of; an empty list is a fine answer.`;

const MERGE_SCHEMA = {
  type: "object",
  properties: {
    merges: {
      type: "array",
      items: {
        type: "object",
        properties: {
          country: { type: ["string", "null"] },
          from: { type: "string" },
          into: { type: "string" },
        },
        required: ["country", "from", "into"],
        additionalProperties: false,
      },
    },
  },
  required: ["merges"],
  additionalProperties: false,
} as const;

/**
 * Folds regions that are one area under two names into one.
 *
 * Placing is done in batches, and the first batches choose before the list of
 * regions has filled in, so the same area can end up as Havasupai in one batch
 * and Grand Canyon in a later one. One look at the whole list afterwards puts
 * them back together. Only ever merges within a country, and only names it was
 * given, so it cannot invent a region or move a post abroad.
 */
export async function consolidateRegions(): Promise<number> {
  const rows = await db
    .select({ country: posts.placeCountry, region: posts.placeRegion, place: posts.place })
    .from(posts)
    .where(and(eq(posts.category, "Travel"), isNotNull(posts.placeRegion)));

  const byRegion = new Map<string, { country: string | null; region: string; count: number; places: Set<string> }>();
  for (const row of rows) {
    const key = `${row.country ?? ""}\u0000${row.region}`;
    const entry = byRegion.get(key) ?? { country: row.country, region: row.region as string, count: 0, places: new Set() };
    entry.count += 1;
    if (row.place && entry.places.size < 6) entry.places.add(row.place);
    byRegion.set(key, entry);
  }
  if (byRegion.size < 2) return 0;

  const listing = [...byRegion.values()]
    .sort((a, b) => (a.country ?? "").localeCompare(b.country ?? "") || b.count - a.count)
    .map((r) => `${r.country ?? "(no country)"} > ${r.region} (${r.count}): ${[...r.places].join("; ") || "-"}`)
    .join("\n");

  const settings = await getSettings();
  const stream = query({
    prompt: `The regions on the list:\n${listing}`,
    options: {
      model: settings.analysisModel || undefined,
      effort: "low",
      systemPrompt: { type: "custom", prompt: MERGE_PROMPT },
      tools: [],
      settingSources: [],
      persistSession: false,
      env: agentEnv(),
      maxTurns: 3,
      outputFormat: { type: "json_schema", schema: MERGE_SCHEMA as unknown as Record<string, unknown> },
    },
  });

  let merges: { country: string | null; from: string; into: string }[] = [];
  for await (const message of stream) {
    if (message.type !== "result" || message.subtype !== "success") continue;
    merges = (message.structured_output as { merges?: typeof merges } | undefined)?.merges ?? [];
  }

  let applied = 0;
  for (const merge of merges) {
    const country = merge.country ?? null;
    const known = (name: string) => byRegion.has(`${country ?? ""}\u0000${name}`);
    // Only names that are on the list, in the same country, and not a no-op.
    if (merge.from === merge.into || !known(merge.from) || !known(merge.into)) continue;
    await db
      .update(posts)
      .set({ placeRegion: merge.into })
      .where(
        and(
          eq(posts.placeRegion, merge.from),
          country === null ? isNull(posts.placeCountry) : eq(posts.placeCountry, country),
        ),
      );
    applied += 1;
    console.log(`[places] merged ${country ?? "(no country)"} > ${merge.from} into ${merge.into}`);
  }
  return applied;
}

const CITY_PROMPT = `For each place on a personal travel list, give the town or city it is in, or nearest to - just its name ("Ocala", "Saratoga", "Charlotte Amalie", "Zermatt"). For a spot in a national park or the wilderness, the park or the nearest town a visitor would stay in. Use the region, country and description to tell which. Null only when there is no telling.`;

const CITY_SCHEMA = {
  type: "object",
  properties: {
    posts: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "integer" }, city: { type: ["string", "null"] } },
        required: ["id", "city"],
        additionalProperties: false,
      },
    },
  },
  required: ["posts"],
  additionalProperties: false,
} as const;

/**
 * The city for places placed before the list kept one.
 *
 * Separate from placing, so the regions those posts were already filed under
 * stay exactly as they are. Marked done either way, by an empty string when
 * there is no telling, so a post is asked about once.
 */
export async function fillCities(): Promise<number> {
  const waiting = await db
    .select()
    .from(posts)
    .where(and(eq(posts.category, "Travel"), isNotNull(posts.place), isNull(posts.placeCity)));
  if (waiting.length === 0) return 0;

  const settings = await getSettings();
  let filled = 0;
  for (let start = 0; start < waiting.length; start += 40) {
    const batch = waiting.slice(start, start + 40);
    const input = batch.map((post) => ({
      id: post.id,
      place: post.place,
      region: post.placeRegion,
      country: post.placeCountry,
      summary: post.summary,
    }));
    const stream = query({
      prompt: `The places:\n${JSON.stringify(input, null, 1)}`,
      options: {
        model: settings.analysisModel || undefined,
        effort: "low",
        systemPrompt: { type: "custom", prompt: CITY_PROMPT },
        tools: [],
        settingSources: [],
        persistSession: false,
        env: agentEnv(),
        maxTurns: 3,
        outputFormat: { type: "json_schema", schema: CITY_SCHEMA as unknown as Record<string, unknown> },
      },
    });
    let results: { id: number; city: string | null }[] = [];
    for await (const message of stream) {
      if (message.type !== "result" || message.subtype !== "success") continue;
      results = (message.structured_output as { posts?: typeof results } | undefined)?.posts ?? [];
    }
    const byId = new Map(results.map((r) => [r.id, r.city]));
    for (const post of batch) {
      if (!byId.has(post.id)) continue;
      const city = clean(byId.get(post.id));
      await db.update(posts).set({ placeCity: city ?? "" }).where(eq(posts.id, post.id));
      if (city) filled += 1;
    }
  }
  console.log(`[places] cities for ${filled} of ${waiting.length} place(s)`);
  return filled;
}

/** Only coordinates that are on the globe; anything else is no coordinate. */
function coordinates(lat: unknown, lng: unknown): { placeLat: number | null; placeLng: number | null } {
  const valid =
    typeof lat === "number" && typeof lng === "number" && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
  return valid ? { placeLat: lat, placeLng: lng } : { placeLat: null, placeLng: null };
}

const COORDINATES_PROMPT = `For each entry on a personal travel list, give where to put its dot on a world map, in decimal degrees: the spot when you know it, otherwise its city, otherwise the middle of its region. Approximate is fine - a few kilometres off does not matter. Null only when there is no location at all.`;

const COORDINATES_SCHEMA = {
  type: "object",
  properties: {
    posts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          lat: { type: ["number", "null"] },
          lng: { type: ["number", "null"] },
        },
        required: ["id", "lat", "lng"],
        additionalProperties: false,
      },
    },
  },
  required: ["posts"],
  additionalProperties: false,
} as const;

/**
 * Coordinates for places that were placed before the list kept them. A text
 * pass like the city one: places and regions stay exactly as they are.
 */
export async function fillCoordinates(): Promise<number> {
  const waiting = await db
    .select()
    .from(posts)
    .where(and(eq(posts.category, "Travel"), isNotNull(posts.placeRegion), isNull(posts.placeLat)));
  if (waiting.length === 0) return 0;

  const settings = await getSettings();
  let filled = 0;
  for (let start = 0; start < waiting.length; start += 40) {
    const batch = waiting.slice(start, start + 40);
    const input = batch.map((post) => ({
      id: post.id,
      place: post.place,
      city: post.placeCity || null,
      region: post.placeRegion,
      country: post.placeCountry,
    }));
    const stream = query({
      prompt: `The entries:\n${JSON.stringify(input, null, 1)}`,
      options: {
        model: settings.analysisModel || undefined,
        effort: "low",
        systemPrompt: { type: "custom", prompt: COORDINATES_PROMPT },
        tools: [],
        settingSources: [],
        persistSession: false,
        env: agentEnv(),
        maxTurns: 3,
        outputFormat: { type: "json_schema", schema: COORDINATES_SCHEMA as unknown as Record<string, unknown> },
      },
    });
    let results: { id: number; lat: number | null; lng: number | null }[] = [];
    for await (const message of stream) {
      if (message.type !== "result" || message.subtype !== "success") continue;
      results = (message.structured_output as { posts?: typeof results } | undefined)?.posts ?? [];
    }
    for (const result of results) {
      const point = coordinates(result.lat, result.lng);
      if (point.placeLat === null) continue; // asked again next time
      if (!batch.some((post) => post.id === result.id)) continue;
      await db.update(posts).set(point).where(eq(posts.id, result.id));
      filled += 1;
    }
  }
  console.log(`[places] coordinates for ${filled} of ${waiting.length} place(s)`);
  return filled;
}

async function knownRegions(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ region: posts.placeRegion, country: posts.placeCountry })
    .from(posts)
    .where(isNotNull(posts.placeRegion));
  return rows.map((row) => `${row.region} (${row.country ?? "?"})`).sort();
}

async function locate(batch: Post[], regions: string[]): Promise<Located[]> {
  const settings = await getSettings();
  const input = batch.map((post) => ({
    id: post.id,
    summary: post.summary,
    named: parseItems(post.items),
    caption: post.caption ? truncate(post.caption, 400) : null,
    said: post.transcript ? truncate(post.transcript, 400) : null,
    author: post.authorUsername,
  }));

  const prompt = [
    "Place these travel posts.",
    "",
    regions.length > 0 ? `Regions already on the list:\n${regions.join("\n")}` : "No regions on the list yet.",
    "",
    `Posts:\n${JSON.stringify(input, null, 1)}`,
  ].join("\n");

  const stream = query({
    prompt,
    options: {
      model: settings.analysisModel || undefined,
      effort: "low",
      systemPrompt: { type: "custom", prompt: SYSTEM_PROMPT },
      tools: [],
      settingSources: [],
      persistSession: false,
      env: agentEnv(),
      maxTurns: 3,
      outputFormat: { type: "json_schema", schema: OUTPUT_SCHEMA as unknown as Record<string, unknown> },
    },
  });

  for await (const message of stream) {
    if (message.type !== "result") continue;
    if (message.subtype !== "success") throw new Error(`Agent stopped: ${message.subtype}`);
    const output = message.structured_output as { posts?: Located[] } | undefined;
    return (output?.posts ?? []).filter((p) => typeof p.id === "number");
  }
  throw new Error("Agent produced no result.");
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function parseItems(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

/**
 * A fixed set of categories, so the colour rail down the feed stays meaningful
 * across syncs. The model must pick one of these.
 */
export const CATEGORIES = [
  "Food",
  "Home",
  "Garden",
  "Travel",
  "Style",
  "Beauty",
  "Fitness",
  "Health",
  "Family",
  "Pets",
  "Craft",
  "Shopping",
  "Humor",
  "Art",
  "Music",
  "Learning",
  "Other",
] as const;

export type Category = (typeof CATEGORIES)[number];

/** Hue per category, used for the rail and filter dots. */
export const CATEGORY_HUE: Record<Category, number> = {
  Food: 18,
  Home: 40,
  Garden: 96,
  Travel: 196,
  Style: 320,
  Beauty: 338,
  Fitness: 8,
  Health: 158,
  Family: 268,
  Pets: 28,
  Craft: 246,
  Shopping: 216,
  Humor: 52,
  Art: 288,
  Music: 178,
  Learning: 232,
  Other: 220,
};

export function isCategory(value: string | null | undefined): value is Category {
  return Boolean(value) && (CATEGORIES as readonly string[]).includes(value as string);
}

/**
 * The emoji a reaction can use.
 *
 * Deliberately short. Instagram's own reaction tray is a small set, a reaction
 * is a gesture rather than a review, and a fixed heart on everything says
 * nothing - the point is that the right one tells her you actually looked.
 */
export const REACTIONS = [
  { emoji: "❤️", means: "love it, or it is simply beautiful" },
  { emoji: "😍", means: "want it - covetable, gorgeous, aspirational" },
  { emoji: "🤤", means: "food that looks worth making or eating" },
  { emoji: "🔥", means: "impressive, striking, a strong result" },
  { emoji: "👏", means: "skill or craft worth applauding" },
  { emoji: "💡", means: "a practical idea worth remembering or doing" },
  { emoji: "😂", means: "funny" },
  { emoji: "😮", means: "surprising or unexpected" },
  { emoji: "👍", means: "noted - fine, but nothing stronger" },
] as const;

export const REACTION_EMOJI = REACTIONS.map((r) => r.emoji);

export const DEFAULT_REACTION = "❤️";

export function isReactionEmoji(value: string | null | undefined): boolean {
  return Boolean(value) && (REACTION_EMOJI as readonly string[]).includes(value as string);
}

/** The guidance handed to the model when it picks one. */
export function reactionGuide(): string {
  return REACTIONS.map((r) => `${r.emoji} - ${r.means}`).join("\n");
}

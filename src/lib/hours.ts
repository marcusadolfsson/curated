import { between } from "@/lib/pace";

/**
 * The hours this app is willing to touch Instagram.
 *
 * A desktop that gets locked at night does not read DMs at four in the
 * morning, and neither should this. The window was in three files with three
 * copies of the same two numbers; it belongs in one, because a rule about
 * looking human is worth nothing if half the code has its own version of it.
 */

export const AWAKE_FROM = 7;
export const AWAKE_UNTIL = 23;

export function isAwake(at: Date = new Date()): boolean {
  const hour = at.getHours();
  return hour >= AWAKE_FROM && hour < AWAKE_UNTIL;
}

/** Until the morning, plus a few random minutes so it is never on the dot. */
export function msUntilAwake(): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(AWAKE_FROM, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime() + between(0, 20 * 60_000);
}

/** Until bedtime, brought forward by a few random minutes for the same reason. */
export function msUntilBed(): number {
  const now = new Date();
  const bed = new Date(now);
  bed.setHours(AWAKE_UNTIL, 0, 0, 0);
  if (bed <= now) bed.setDate(bed.getDate() + 1);
  return bed.getTime() - now.getTime() - between(0, 20 * 60_000);
}

/**
 * Pauses shaped like a person, not a loop.
 *
 * A script does the next thing the instant the last one finished; someone
 * reading their inbox does not. Every gap between two requests goes through
 * here so that no two runs have the same rhythm.
 */
export function pause(minMs: number, maxMs: number): Promise<void> {
  const wait = minMs + Math.random() * Math.max(0, maxMs - minMs);
  return new Promise((resolve) => setTimeout(resolve, wait));
}

export function between(minMs: number, maxMs: number): number {
  return minMs + Math.random() * Math.max(0, maxMs - minMs);
}

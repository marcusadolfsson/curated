import { db } from "@/db";
import { settings } from "@/db/schema";
import { eq } from "drizzle-orm";

/**
 * A stop, held across restarts.
 *
 * When Instagram pushes back, the wrong response is to try again shortly. An
 * account driven too hard gets locked, and once the traffic leaves through a
 * home connection the cost of a misbehaving loop is no longer a disposable
 * server address - it is the address the household browses from. So a refusal
 * stops the automation until a person looks at it.
 */

const PAUSED_UNTIL = "pausedUntil";
const PAUSE_REASON = "pauseReason";
const DEFAULT_HOURS = 6;

export type PauseState = { paused: boolean; until: string | null; reason: string | null };

export async function pauseAutomation(reason: string, hours = DEFAULT_HOURS) {
  const until = new Date(Date.now() + hours * 3600_000);
  await write(PAUSED_UNTIL, until.toISOString());
  await write(PAUSE_REASON, reason.slice(0, 500));
  console.warn(`[pause] automation paused until ${until.toISOString()}: ${reason}`);
}

export async function resumeAutomation() {
  await write(PAUSED_UNTIL, "");
  await write(PAUSE_REASON, "");
}

export async function pauseState(): Promise<PauseState> {
  const until = await read(PAUSED_UNTIL);
  const reason = await read(PAUSE_REASON);

  if (!until) return { paused: false, until: null, reason: null };

  const expires = new Date(until);
  if (!Number.isFinite(expires.getTime()) || expires <= new Date()) {
    return { paused: false, until: null, reason: null };
  }

  return { paused: true, until: expires.toISOString(), reason: reason || null };
}

async function read(key: string): Promise<string> {
  const rows = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  return rows[0]?.value ?? "";
}

async function write(key: string, value: string) {
  await db
    .insert(settings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

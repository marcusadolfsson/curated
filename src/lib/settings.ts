import { db } from "@/db";
import { settings } from "@/db/schema";
import { eq } from "drizzle-orm";

export const DEFAULTS = {
  /** Model the analysis agent runs on. Empty string = whatever the CLI defaults to. */
  analysisModel: "claude-sonnet-5",
  /** low | medium | high | xhigh | max */
  analysisEffort: "low",
  /** Appended to the analysis prompt, so you can steer categories without editing code. */
  analysisInstructions: "",
  /** Threads scanned per sync (newest first). A page of the inbox is 20. */
  inboxLimit: "20",
  /**
   * How far back to read a conversation the first time it is watched.
   *
   * After that the depth is not a setting at all: a sync reads back to
   * wherever the last one finished, however long ago that was, so a machine
   * that slept for three days catches up on three days.
   */
  historyDays: "7",
  /** Analyse posts automatically as they are imported. */
  autoAnalyze: "true",
  /**
   * Transcribe what is said in a reel on this Mac with Whisper, for the
   * description to read. Needs whisper.cpp and its models; without them it
   * does nothing.
   */
  transcribeReels: "true",
  /**
   * Listen for new messages on the Instagram API's update feed and sync when
   * one arrives. Off, posts arrive only when you check by hand.
   */
  realtime: "false",
  /** React to each post in the DM thread once it has been read. */
  autoReact: "false",
  /** Used only when the model did not choose one. */
  reactionEmoji: "❤️",
  /**
   * The account's username, and its id from before the API: posts shared
   * then carry it, so it is how the account's own shares are recognised.
   */
  sessionUsername: "",
  sessionUserId: "",
  /** Where the Instagram API answers - the far end of Muse's tunnel. */
  instagramApiBase: "http://127.0.0.1:8000",
  /** The newest `sent_at` the API listener has seen; it asks for what came after. */
  apiUpdatesSince: "",
} as const;

export type SettingKey = keyof typeof DEFAULTS;

export async function getSetting(key: SettingKey): Promise<string> {
  const row = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  const value = row[0]?.value;
  return value === undefined || value === null || value === "" ? DEFAULTS[key] : value;
}

export async function getSettings(): Promise<Record<SettingKey, string>> {
  const rows = await db.select().from(settings);
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  const result = {} as Record<SettingKey, string>;
  for (const key of Object.keys(DEFAULTS) as SettingKey[]) {
    const value = stored.get(key);
    result[key] = value === undefined || value === null || value === "" ? DEFAULTS[key] : value;
  }
  return result;
}

export async function setSettings(values: Partial<Record<SettingKey, string>>) {
  for (const [key, value] of Object.entries(values)) {
    if (!(key in DEFAULTS)) continue;
    await db
      .insert(settings)
      .values({ key, value: String(value), updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: String(value), updatedAt: new Date() },
      });
  }
}

export function asBool(value: string): boolean {
  return value === "true" || value === "1";
}

export function asInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

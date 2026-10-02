import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { posts } from "@/db/schema";
import { DATA_DIR, MEDIA_DIR } from "@/lib/paths";
import { asBool, getSetting } from "@/lib/settings";

const run = promisify(execFile);

/**
 * What is said in a reel, transcribed on this Mac.
 *
 * A reel used to be judged from its cover frame and caption, so one whose
 * point arrives halfway through got a thin description. Whisper - whisper.cpp
 * on the GPU, with a voice-activity model in front of it - turns the speech
 * into text for the description to read, and for the date and place passes.
 * Nothing leaves the machine.
 *
 * The voice-activity model matters as much as Whisper: on a reel that is all
 * music, Whisper on its own writes a confident sentence nobody said. With
 * Silero deciding where the speech is first, music comes back empty.
 *
 * The audio comes out of the mp4 with afconvert, which macOS has anyway, so
 * the only things to install are whisper.cpp and the two models. Without them
 * this switches itself off and reels are described the old way.
 */

const MODELS_DIR = path.join(DATA_DIR, "models");
const WHISPER_MODEL = path.join(MODELS_DIR, "ggml-large-v3-turbo-q5_0.bin");
const VAD_MODEL = path.join(MODELS_DIR, "ggml-silero-v5.1.2.bin");
const WHISPER_CANDIDATES = ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"];
/** Fewer words than this is a stray word in the music, not something said. */
const MIN_WORDS = 3;

function whisperBinary(): string | null {
  return WHISPER_CANDIDATES.find((candidate) => fs.existsSync(candidate)) ?? null;
}

/** Whether transcription can run here at all, and whether it is wanted. */
export async function transcriptionAvailable(): Promise<boolean> {
  if (!asBool(await getSetting("transcribeReels"))) return false;
  return Boolean(whisperBinary()) && fs.existsSync(WHISPER_MODEL) && fs.existsSync(VAD_MODEL);
}

/** The spoken words in a video file, or "" when nothing is said. */
async function transcribeFile(videoPath: string): Promise<string> {
  const binary = whisperBinary();
  if (!binary) throw new Error("whisper-cli is not installed");

  const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), "curated-whisper-"));
  try {
    const wav = path.join(work, "audio.wav");
    // 16 kHz mono 16-bit: what Whisper wants, straight out of the mp4. Some
    // reels have no audio track at all - VP9 video and nothing else - and
    // afconvert refuses those; nothing is said in them, which is an answer.
    try {
      await run("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", videoPath, wav], {
        timeout: 60_000,
      });
    } catch {
      return "";
    }
    const out = path.join(work, "transcript");
    await run(
      binary,
      ["-m", WHISPER_MODEL, "--vad", "-vm", VAD_MODEL, "-f", wav, "-l", "auto", "-nt", "-np", "-otxt", "-of", out],
      { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 },
    );
    const text = (await fs.promises.readFile(`${out}.txt`, "utf8")).replace(/\s+/g, " ").trim();
    return text.split(" ").filter(Boolean).length < MIN_WORDS ? "" : text;
  } finally {
    await fs.promises.rm(work, { recursive: true, force: true });
  }
}

type TranscribeState = { running: boolean; done: number; total: number; error: string | null };
const globalForTranscribe = globalThis as unknown as { __transcribe?: TranscribeState };
const state: TranscribeState = (globalForTranscribe.__transcribe ??= {
  running: false,
  done: 0,
  total: 0,
  error: null,
});

export function transcribeState(): TranscribeState {
  return { ...state };
}

/**
 * Transcribes reels whose video is on disk and that have not been tried, one
 * at a time - the GPU does one well and two badly. `ids` limits it to those
 * posts, which is how a sync does only what it just brought in.
 *
 * Returns the ids of posts that turned out to have something said in them.
 */
export async function transcribePending(ids?: number[]): Promise<number[]> {
  if (state.running || !(await transcriptionAvailable())) return [];

  const conditions = [
    or(eq(posts.mediaType, "reel"), eq(posts.mediaType, "tv")),
    isNotNull(posts.videoFile),
    isNull(posts.transcribedAt),
  ];
  if (ids) {
    if (ids.length === 0) return [];
    conditions.push(inArray(posts.id, ids));
  }
  const waiting = (await db.select().from(posts).where(and(...conditions))).filter((post) =>
    fs.existsSync(path.join(MEDIA_DIR, post.videoFile as string)),
  );
  if (waiting.length === 0) return [];

  Object.assign(state, { running: true, done: 0, total: waiting.length, error: null });
  const spoken: number[] = [];
  try {
    for (const post of waiting) {
      try {
        const text = await transcribeFile(path.join(MEDIA_DIR, post.videoFile as string));
        await db
          .update(posts)
          .set({ transcript: text || null, transcribedAt: new Date() })
          .where(eq(posts.id, post.id));
        if (text) spoken.push(post.id);
      } catch (error) {
        // One bad file is not a reason to stop; it is tried again next time.
        console.warn(`[transcribe] ${post.shortcode}:`, error instanceof Error ? error.message : error);
      }
      state.done += 1;
    }
    console.log(`[transcribe] ${spoken.length} of ${waiting.length} reel(s) had something said`);
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.running = false;
  }
  return spoken;
}

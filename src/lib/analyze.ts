import { query } from "@anthropic-ai/claude-agent-sdk";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { posts, type Post } from "@/db/schema";
import { CATEGORIES } from "@/lib/categories";
import { DEFAULT_REACTION, REACTION_EMOJI, reactionGuide } from "@/lib/emoji";
import { MEDIA_DIR } from "@/lib/paths";
import { mediaExists, mediaPath } from "@/lib/instagram/media";
import { asInt, getSettings } from "@/lib/settings";
import { agentEnv, claudeAuth } from "@/lib/claude-auth";

/**
 * Reads a shared post and says what it is.
 *
 * This runs through the Claude Agent SDK, which drives the locally installed
 * Claude Code - so it uses this machine's existing Claude credentials and needs
 * no API key. The agent gets one tool, Read, pointed at the downloaded
 * thumbnail.
 *
 * It used to say here that the picture is the only real signal because most
 * reels say nothing useful in their caption. Measured over 1,107 described
 * posts that is not true: 78% carry a substantial caption once hashtags,
 * credits and emoji are stripped, median 136 characters - and only about a
 * fifth of the words in the summaries were coming from them. The caption is
 * where the facts live; the picture is what fills the gaps and carries the
 * 22% that have nothing to say. Hence the order the prompt works in.
 */

export type Analysis = {
  category: string;
  summary: string;
  captionStrength: string | null;
  sentiment: string | null;
  items: string[];
  reaction: string;
  reply: string;
};

export type AnalysisResult =
  | { ok: true; analysis: Analysis; model: string | null; costUsd: number }
  | { ok: false; error: string };

const REPLY_GUIDE = `It is a starting point the reader will edit, never sent as is. Write it the way one half of a couple texts the other: first person, one short sentence, maybe two, lowercase-casual is fine, no greeting and no sign-off. React to the specific thing in the post - the dish, the place, the trick - the way you would if you had just watched it. Answer whatever the sender's own note asks or suggests ("should we try this?"). Match the sentiment you just named - do not be warm about something you called forgettable. No hashtags, no marketing tone, at most one emoji and usually none.`;

const SYSTEM_PROMPT = `You write the one line a private feed shows above a post someone shared over Instagram DMs. The reader can already see the picture. Your job is to tell them what they cannot see.

Work in this order, and fill the fields in this order.

1. WEIGH THE CAPTION. The caption is the author's own account of the post, and usually the only place the facts live. Strip the packaging: hooks like "send this to", hashtags, @credits, "link in bio", emoji, and marketing voice. Translate anything not in English. Then judge what survives:
   - "rich": real information - a place, a price, a time, a method, a list, a claim, a punchline.
   - "thin": a few words, a mood, a joke with no substance behind it.
   - "none": no caption, or nothing left once the packaging is gone.

2. READ THE PICTURE. Take what the caption leaves out or is vague about: what the thing actually is, where it is, what it is made of, what is happening. When the caption is thin or none the picture carries the whole line - never return a weak line just because the caption was weak.

3. WRITE THE LINE, from both. One sentence, two at the very most.
   The voice matters more than any single word:
   - Plain and declarative. Present tense. Lead with the thing itself.
   - Never sell it. No "stunning", "gorgeous", "must-see", "a must", "game changer".
   - Specifics over adjectives: the place, the number, the material, the method.
   - Never narrate what the picture plainly shows. "A man holds a blanket on a bed" tells the reader nothing.
   - Never open with "A reel that", "This post shows", or the account name.
   - Do not repeat the sender's own note; it is shown beside your line.

4. NAME THE SENTIMENT of the line you just wrote - the register the post is in and what it asks of the reader. A few words, lowercase: "practical, worth saving", "funny, no substance", "aspirational travel", "a real skill on show". The emoji and the reply both come from this, so it must fit the line rather than the picture in general.

5. PICK THE EMOJI from that sentiment, as the person receiving this would - the one they would actually tap, not the warmest available. Reserve the strongest for posts that earn it; when nothing stands out, say so with a mild one.

6. DRAFT THE REPLY from that same sentiment. ${REPLY_GUIDE}`;


const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    captionStrength: {
      type: "string",
      enum: ["rich", "thin", "none"],
      description: "How much the caption carried once hooks, hashtags, credits and marketing voice were stripped.",
    },
    category: {
      type: "string",
      enum: [...CATEGORIES],
      description: "The single best fit for this post.",
    },
    summary: {
      type: "string",
      description:
        "One sentence, two at most, saying what the reader cannot already see. Built from the stripped caption and the picture together. No preamble, no marketing language, no narrating the image, and no restating the sender's note.",
    },
    items: {
      type: "array",
      items: { type: "string" },
      maxItems: 8,
      description:
        "Concrete things the post names or calls for - ingredients, materials, products, places, exercises. Short noun phrases. Empty if the post names nothing concrete.",
    },
    sentiment: {
      type: "string",
      description:
        "A few lowercase words naming the register of the line you wrote and what it asks of the reader. The emoji and the reply both follow from this.",
    },
    reaction: {
      type: "string",
      enum: [...REACTION_EMOJI],
      description: `The emoji to react with:\n${reactionGuide()}`,
    },
    reply: {
      type: "string",
      description:
        "A short, casual first-person reply to the sender about this post, one or two sentences, specific to what is in it. A draft they will edit.",
    },
  },
  required: ["captionStrength", "category", "summary", "items", "sentiment", "reaction", "reply"],
  additionalProperties: false,
} as const;

export async function analyzePost(post: Post): Promise<AnalysisResult> {
  const auth = claudeAuth();
  if (!auth.ok) return { ok: false, error: auth.detail };

  const settings = await getSettings();
  const hasImage = mediaExists(post.thumbnailFile);

  const facts = [
    `Permalink: ${post.permalink}`,
    `Type: ${post.mediaType === "reel" ? "Reel (video)" : post.mediaType}`,
    post.authorUsername ? `Posted by: @${post.authorUsername}` : null,
    post.caption ? `Caption: ${truncate(post.caption, 2000)}` : "Caption: (none)",
    post.messageText ? `The sender's own words with the share: ${truncate(post.messageText, 500)}` : null,
    hasImage
      ? `Image: ${mediaPath(post.thumbnailFile as string)} - read this file first; for a reel it is the cover frame.`
      : "Image: not available, work from the caption alone.",
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = [
    "Write the line for this shared Instagram post.",
    "",
    facts,
    settings.analysisInstructions.trim()
      ? `\nAdditional instructions from the feed's owner:\n${settings.analysisInstructions.trim()}`
      : "",
  ].join("\n");

  try {
    const stream = query({
      prompt,
      options: {
        model: settings.analysisModel || undefined,
        effort: settings.analysisEffort as "low" | "medium" | "high" | "xhigh" | "max",
        systemPrompt: { type: "custom", prompt: SYSTEM_PROMPT },
        tools: hasImage ? ["Read"] : [],
        allowedTools: hasImage ? ["Read"] : [],
        permissionMode: "dontAsk",
        additionalDirectories: [MEDIA_DIR],
        cwd: MEDIA_DIR,
        env: agentEnv(),
        settingSources: [], // ignore this machine's Claude Code settings and CLAUDE.md
        persistSession: false,
        maxTurns: 6,
        outputFormat: { type: "json_schema", schema: OUTPUT_SCHEMA as unknown as Record<string, unknown> },
      },
    });

    for await (const message of stream) {
      if (message.type !== "result") continue;

      if (message.subtype !== "success") {
        return { ok: false, error: `Agent stopped: ${message.subtype}` };
      }

      const analysis = coerceAnalysis(message.structured_output);
      if (!analysis) {
        return { ok: false, error: "Agent returned no usable analysis." };
      }

      return {
        ok: true,
        analysis,
        model: Object.keys(message.modelUsage ?? {})[0] ?? settings.analysisModel,
        costUsd: message.total_cost_usd ?? 0,
      };
    }

    return { ok: false, error: "Agent produced no result." };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Analyse a post and write the outcome back to its row. */
export async function analyzeAndStore(post: Post): Promise<AnalysisResult> {
  await db.update(posts).set({ analysisStatus: "running" }).where(eq(posts.id, post.id));

  const result = await analyzePost(post);

  if (result.ok) {
    await db
      .update(posts)
      .set({
        analysisStatus: "done",
        category: result.analysis.category,
        summary: result.analysis.summary,
        items: JSON.stringify(result.analysis.items),
        suggestedReaction: result.analysis.reaction,
        captionStrength: result.analysis.captionStrength,
        sentiment: result.analysis.sentiment,
        draftReply: result.analysis.reply || null,
        analysisModel: result.model,
        analysisCostUsd: result.costUsd,
        analysisError: null,
        analyzedAt: new Date(),
      })
      .where(eq(posts.id, post.id));
  } else {
    await db
      .update(posts)
      .set({
        analysisStatus: "error",
        analysisError: result.error.slice(0, 1000),
        analyzedAt: new Date(),
      })
      .where(eq(posts.id, post.id));
  }

  return result;
}

function coerceAnalysis(value: unknown): Analysis | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;

  const category = typeof record.category === "string" ? record.category : null;
  const summary = typeof record.summary === "string" ? record.summary : null;
  if (!category || !summary) return null;

  const items = Array.isArray(record.items)
    ? record.items.filter((item): item is string => typeof item === "string")
    : [];

  const reaction = typeof record.reaction === "string" ? record.reaction : DEFAULT_REACTION;

  const reply = typeof record.reply === "string" ? record.reply.trim() : "";

  const captionStrength =
    typeof record.captionStrength === "string" ? record.captionStrength : null;
  const sentiment =
    typeof record.sentiment === "string" && record.sentiment.trim() ? record.sentiment.trim() : null;

  return { category, summary, items, reaction, reply, captionStrength, sentiment };
}

/**
 * Drafts a reply for a post that was described before replies were drafted.
 * Text only, off the summary and the sender's note; re-reading the image would
 * cost a full analysis for a sentence.
 */
export async function draftReplyFor(post: Post): Promise<string | null> {
  if (!post.summary) return null;

  const facts = [
    `Category: ${post.category ?? "unknown"}`,
    `Summary: ${post.summary}`,
    post.items ? `Things it names: ${post.items}` : null,
    post.caption ? `Caption: ${truncate(post.caption, 800)}` : null,
    post.messageText ? `The sender's own note with the share: ${truncate(post.messageText, 500)}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const stream = query({
      prompt: `Draft the reply for this shared Instagram post.\n\n${facts}`,
      options: {
        model: "claude-haiku-4-5",
        effort: "low",
        systemPrompt: { type: "custom", prompt: REPLY_GUIDE },
        tools: [],
        settingSources: [],
        persistSession: false,
        maxTurns: 2,
        outputFormat: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { reply: { type: "string" } },
            required: ["reply"],
            additionalProperties: false,
          } as unknown as Record<string, unknown>,
        },
      },
    });

    for await (const message of stream) {
      if (message.type !== "result" || message.subtype !== "success") continue;
      const output = message.structured_output as { reply?: unknown } | undefined;
      if (typeof output?.reply === "string" && output.reply.trim()) return output.reply.trim();
    }
  } catch (error) {
    console.error(`[reply] could not draft a reply for post ${post.id}:`, error);
  }

  return null;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

/**
 * Picks a reaction for a post that was described before the model was asked to
 * choose one. Text only, off the summary we already have - re-reading the image
 * would cost the same as the original analysis for a single emoji.
 */
export async function chooseReaction(post: Post): Promise<string | null> {
  if (!post.summary) return null;

  const facts = [
    `Category: ${post.category ?? "unknown"}`,
    `Summary: ${post.summary}`,
    post.items ? `Things it names: ${post.items}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const stream = query({
      prompt: `Choose the emoji to react with for this shared Instagram post.\n\n${facts}`,
      options: {
        model: "claude-haiku-4-5",
        effort: "low",
        systemPrompt: {
          type: "custom",
          prompt: `Pick the emoji a person would actually tap after seeing this post. Reserve the strongest for posts that earn it; when nothing stands out, use a mild one.\n\n${reactionGuide()}`,
        },
        tools: [],
        settingSources: [],
        persistSession: false,
        maxTurns: 2,
        outputFormat: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { reaction: { type: "string", enum: [...REACTION_EMOJI] } },
            required: ["reaction"],
            additionalProperties: false,
          } as unknown as Record<string, unknown>,
        },
      },
    });

    for await (const message of stream) {
      if (message.type !== "result" || message.subtype !== "success") continue;
      const output = message.structured_output as { reaction?: unknown } | undefined;
      if (typeof output?.reaction === "string") return output.reaction;
    }
  } catch (error) {
    console.error(`[reactions] could not choose an emoji for post ${post.id}:`, error);
  }

  return null;
}

/** Concurrency for batch analysis; each post is a separate agent run. */
export function analysisConcurrency(): number {
  return asInt(process.env.ANALYSIS_CONCURRENCY ?? "2", 2);
}

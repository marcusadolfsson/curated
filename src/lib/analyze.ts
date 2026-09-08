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
 * thumbnail: most reels say nothing useful in the caption, and the picture is
 * the only real signal.
 */

export type Analysis = {
  category: string;
  summary: string;
  items: string[];
  reaction: string;
  reply: string;
};

export type AnalysisResult =
  | { ok: true; analysis: Analysis; model: string | null; costUsd: number }
  | { ok: false; error: string };

const REPLY_GUIDE = `Also draft the reply the recipient might text back to the sender about this post. It is a starting point they will edit, never sent as is. Write it the way one half of a couple texts the other: first person, one short sentence, maybe two, lowercase-casual is fine, no greeting and no sign-off. React to the specific thing in the post - the dish, the place, the trick - the way you would if you had just watched it. Answer whatever the sender's own note asks or suggests ("should we try this?"). No hashtags, no marketing tone, at most one emoji and usually none.`;

const SYSTEM_PROMPT = `You describe posts that someone shared over Instagram DMs, for a private feed its owner reads later.

Say what the post actually is, plainly and without selling it. Report only what you can see or read - never invent detail that is not in the image or caption. If the post is unreadable, say so in the summary and use the category "Other".

Write the summary the way you would describe it to someone across the room:

- Two sentences at most, and one is usually enough.
- Lead with the thing itself. Do not open with "A reel that", "This post shows", or the account name - the feed already shows who posted it.
- Do not repeat the sender's own note back; it is displayed next to your summary.
- Keep the specifics that make it worth opening: quantities, places, materials, times.

Also choose the emoji to react with in the thread, as the person receiving this would. Pick the one a person would actually tap after looking at the post - not the warmest available. Reserve the strongest for posts that earn it; when nothing stands out, say so with a mild one.

${REPLY_GUIDE}`;


const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    category: {
      type: "string",
      enum: [...CATEGORIES],
      description: "The single best fit for this post.",
    },
    summary: {
      type: "string",
      description:
        "At most two plain sentences saying what the post is. No preamble, no marketing language, and no restating the sender's note.",
    },
    items: {
      type: "array",
      items: { type: "string" },
      maxItems: 8,
      description:
        "Concrete things the post names or calls for - ingredients, materials, products, places, exercises. Short noun phrases. Empty if the post names nothing concrete.",
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
  required: ["category", "summary", "items", "reaction", "reply"],
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
    "Describe this shared Instagram post.",
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

  return { category, summary, items, reaction, reply };
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

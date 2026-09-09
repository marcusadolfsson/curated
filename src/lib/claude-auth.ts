import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * How the analysis agent authenticates.
 *
 * The Agent SDK spawns Claude Code, which resolves credentials the same way the
 * CLI does. Nothing here is app-specific - it just reports which source is
 * present, so the setup page can say why analysis is failing instead of
 * surfacing a bare agent error.
 */

export type ClaudeAuthSource = "token" | "api-key" | "login" | "none";

export type ClaudeAuth = {
  ok: boolean;
  source: ClaudeAuthSource;
  detail: string;
};

/**
 * Whether the describing half of the app is switched on at all.
 *
 * Claude is optional. With no credential the app is still a reader: it
 * collects what people send you, keeps read and unread, saves, reacts and
 * replies. What it does not do is invent a description or a category, so the
 * post's own caption stands in and the category rail is left out entirely
 * rather than showing a column of "not described yet".
 */
export function analysisAvailable(): boolean {
  return claudeAuth().ok;
}

export function claudeAuth(): ClaudeAuth {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return {
      ok: true,
      source: "token",
      detail: "Using CLAUDE_CODE_OAUTH_TOKEN from the environment.",
    };
  }

  if (process.env.ANTHROPIC_API_KEY) {
    return {
      ok: true,
      source: "api-key",
      detail: "Using ANTHROPIC_API_KEY - billed per request rather than to your plan.",
    };
  }

  const credentials = path.join(claudeHome(), ".credentials.json");
  if (fs.existsSync(credentials)) {
    return {
      ok: true,
      source: "login",
      detail: `Using the Claude login at ${credentials}.`,
    };
  }

  return {
    ok: false,
    source: "none",
    detail:
      "No Claude credentials. Set CLAUDE_CODE_OAUTH_TOKEN (make one with `claude setup-token`), or sign in with `claude` on this machine.",
  };
}

function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

/**
 * Environment for the agent subprocess. The SDK REPLACES the environment when
 * this is passed rather than merging, so process.env has to be spread in or the
 * child loses PATH and HOME.
 */
export function agentEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    CLAUDE_AGENT_SDK_CLIENT_APP: "the-pile/1.0",
  };
}

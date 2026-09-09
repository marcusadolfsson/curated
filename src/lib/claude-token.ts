import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The analysis agent's credential, on disk and in this process.
 *
 * `deploy/mac/run.sh` reads this file at boot and exports it, which was the
 * only way it ever got set - so changing it meant a terminal, a `claude
 * setup-token`, a redirect into a file, and a restart. That is four steps too
 * many for something the app can be handed.
 *
 * Writing it also sets it on the running process, because the Agent SDK reads
 * the environment when it spawns and would otherwise keep using the old value
 * until the app was restarted.
 */

export const TOKEN_DIR = path.join(os.homedir(), ".curated");
export const TOKEN_PATH = path.join(TOKEN_DIR, "claude-token");

/**
 * Long-lived tokens from `claude setup-token` start with this. Checked so a
 * pasted API key or a stray line of shell output is refused here rather than
 * failing later inside an agent, where the error says nothing useful.
 */
const TOKEN_SHAPE = /^sk-ant-[A-Za-z0-9_-]{20,}$/;

export type TokenOutcome = { ok: true } | { ok: false; message: string };

export function setToken(raw: string): TokenOutcome {
  const token = raw.trim();
  if (!token) return { ok: false, message: "Paste the token." };
  if (/\s/.test(token)) {
    return { ok: false, message: "That has whitespace in it - it is probably not just the token." };
  }
  if (!TOKEN_SHAPE.test(token)) {
    return {
      ok: false,
      message:
        "That does not look like a token from `claude setup-token`. They begin sk-ant-.",
    };
  }

  // 700 and 600: this is a credential, and the directory is shared with
  // anything else kept out of the repo on purpose.
  fs.mkdirSync(TOKEN_DIR, { recursive: true });
  fs.chmodSync(TOKEN_DIR, 0o700);
  fs.writeFileSync(TOKEN_PATH, `${token}\n`, { mode: 0o600 });
  fs.chmodSync(TOKEN_PATH, 0o600);

  process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
  return { ok: true };
}

export function clearToken(): void {
  fs.rmSync(TOKEN_PATH, { force: true });
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
}

/** Whether a token file exists, without reading what is in it. */
export function hasTokenFile(): boolean {
  return fs.existsSync(TOKEN_PATH);
}

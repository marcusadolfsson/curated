import { getSetting } from "@/lib/settings";
import * as api from "./api";
import { RateLimitedError } from "./errors";

export { RateLimitedError };

/**
 * The account, as far as this app needs to know it.
 *
 * Instagram is read through the Instagram API on Muse, which holds the
 * session; there is no browser here and nothing to sign in to. What is left
 * is whether the API answers, and who the account is.
 */

export type SessionStatus = {
  connected: boolean;
  username: string | null;
  userId: string | null;
  /** When the API last answered. */
  verifiedAt: string | null;
  checkedAt: string;
  message?: string;
};

/**
 * Whether the API answers. Its /health is local to the API and makes no
 * Instagram request, so this is asked fresh every time rather than cached.
 */
export async function getSessionStatus(): Promise<SessionStatus> {
  const health = await api.health();
  const { username } = await storedIdentity();
  const now = new Date().toISOString();
  return {
    connected: health.ok,
    username,
    userId: health.accountId,
    verifiedAt: health.ok ? now : null,
    checkedAt: now,
    message: health.ok ? undefined : "The Instagram API is not answering. The tunnel from Muse may be down.",
  };
}

/**
 * This account, as the sender of a message: its username and every id it goes
 * by. Posts from before the API carry the browser-era user id, posts since
 * carry the API's, and the table holds both.
 *
 * Needed because a thread's participant list leaves the account itself out,
 * so a post it shared found no name there and took the conversation's title -
 * the other person's full name. Its own shares were filed under them.
 */
export async function ownIdentity(): Promise<{ username: string | null; ids: Set<string> }> {
  const { username, userId } = await storedIdentity();
  const ids = new Set<string>();
  if (userId) ids.add(userId);
  const { accountId } = await api.health();
  if (accountId) ids.add(accountId);
  return { username, ids };
}

async function storedIdentity(): Promise<{ username: string | null; userId: string | null }> {
  const username = (await getSetting("sessionUsername")).trim() || null;
  const userId = (await getSetting("sessionUserId")).trim() || null;
  return { username, userId };
}

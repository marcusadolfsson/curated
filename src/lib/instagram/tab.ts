import type { Page } from "playwright";
import { getContext, markSessionDead, markSessionVerified } from "./client";
import { RateLimitedError, SessionExpiredError } from "./errors";

/**
 * The one Instagram tab.
 *
 * Everything the app says to Instagram is said from inside a page open on the
 * DM inbox: reads, media downloads, reactions, replies, and the realtime
 * listening. A request made from Node with the browser's cookies attached is
 * not the same thing as a request the browser makes. Compared side by side, the
 * Node one arrived with no Sec-Fetch-* headers, no Client Hints, an Origin on a
 * GET, and an older Accept-Encoding - on every single call, which is a clean
 * way to tell the two apart. fetch() inside the page gets all of that right
 * without trying, because it is the browser doing it.
 *
 * One tab, not one per job: a person has one inbox open.
 */

export const IG_ORIGIN = "https://www.instagram.com";
const INBOX_URL = `${IG_ORIGIN}/direct/inbox/`;
const IG_APP_ID = "936619743392459"; // the web client's app id
const ASBD_ID = "359341"; // the web client's current x-asbd-id

type TabListener = {
  /** A new page exists and is about to load the inbox: attach listeners here. */
  open?: (page: Page) => void;
  close?: () => void;
};

type TabRuntime = {
  page: Page | null;
  opening: Promise<Page> | null;
  listeners: Set<TabListener>;
  /** Fetches in flight inside the page. A reload waits for them. */
  busy: number;
};

const globalForTab = globalThis as unknown as { __igTab?: TabRuntime };
const runtime: TabRuntime = (globalForTab.__igTab ??= {
  page: null,
  opening: null,
  listeners: new Set(),
  busy: 0,
});

export function onTab(listener: TabListener): () => void {
  runtime.listeners.add(listener);
  return () => runtime.listeners.delete(listener);
}

export function currentTab(): Page | null {
  const page = runtime.page;
  return page && !page.isClosed() ? page : null;
}

/**
 * Being turned away, which is final, and not being on the inbox, which is not.
 *
 * These were one test - "anywhere but /direct/ means signed out" - and that
 * was wrong in a way that cost a working session. A navigation that aborts
 * leaves the tab on about:blank, and the next look at it read that blank page
 * as Instagram having thrown us out, marked the session dead, and stopped
 * everything until a cookie was pasted by hand. The cookie was fine.
 *
 * So: only a login page or a challenge is a verdict. Anywhere else is a tab
 * that needs loading again.
 */
function turnedAway(url: string): boolean {
  return url.includes("/accounts/login") || url.includes("/challenge/");
}

function onInbox(url: string): boolean {
  return url.includes("/direct/");
}

/**
 * The inbox tab, opened if there is none. With `refresh`, the tab loads the
 * inbox again - the page tokens drift over hours, and a new session cookie is
 * only proven by a page that loads with it.
 */
export async function inboxTab(options: { refresh?: boolean } = {}): Promise<Page> {
  const existing = currentTab();

  if (existing && !options.refresh) {
    if (turnedAway(existing.url())) {
      await closeInboxTab();
      markSessionDead();
      throw new SessionExpiredError("Instagram signed this session out.");
    }
    if (onInbox(existing.url())) {
      // Keeps the browser's idle shutdown from firing while the tab is in use.
      await getContext();
      return existing;
    }
    // Somewhere else entirely, which usually means a navigation did not
    // finish. Load it again rather than drawing a conclusion from it.
  }

  runtime.opening ??= load(existing).finally(() => {
    runtime.opening = null;
  });
  return runtime.opening;
}

async function load(existing: Page | null): Promise<Page> {
  let page = existing;

  if (!page) {
    const context = await getContext();
    page = await context.newPage();
    runtime.page = page;
    const created = page;
    page.on("close", () => {
      if (runtime.page === created) runtime.page = null;
      for (const listener of runtime.listeners) listener.close?.();
    });
    for (const listener of runtime.listeners) listener.open?.(page);
  }

  // Navigating out from under a fetch aborts it - or worse, hands back a
  // redirect that reads as "signed out". Let what is in flight finish first.
  for (let waited = 0; runtime.busy > 0 && waited < 30_000; waited += 200) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const response = await page.goto(INBOX_URL, { waitUntil: "domcontentloaded" });

  if (response && response.status() === 429) {
    await closeInboxTab();
    throw new RateLimitedError("Instagram answered 429 for the inbox page");
  }
  const landed = page.url();
  if (turnedAway(landed)) {
    await closeInboxTab();
    markSessionDead();
    throw new SessionExpiredError(
      landed.includes("/challenge/")
        ? "Instagram wants a device check. Clear it at instagram.com, then paste a fresh session cookie."
        : "Instagram sent the inbox to the login page: the session is not signed in.",
    );
  }
  if (!onInbox(landed)) {
    // Not the inbox and not a refusal either - a fault worth retrying, not a
    // reason to throw the session away.
    await closeInboxTab();
    throw new Error(`The inbox did not open; the tab ended up at ${landed}`);
  }

  markSessionVerified();

  // Let the page settle - scripts run, the realtime sockets come up - before
  // anything is asked of it. A moment, not a fixed one.
  await page.waitForTimeout(2500 + Math.random() * 2000);
  return page;
}

export async function closeInboxTab() {
  const page = runtime.page;
  runtime.page = null;
  if (page && !page.isClosed()) await page.close().catch(() => undefined);
}

export type IgResponse = {
  status: number;
  ok: boolean;
  url: string;
  headers: Record<string, string>;
  body: Buffer;
  text(): string;
  json<T>(): T;
};

type FetchOptions = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /**
   * An instagram.com endpoint: the web client's headers and the session's
   * cookies go with it. Off for the CDN, which a browser fetches bare.
   * Defaults from the URL.
   */
  api?: boolean;
};

type FetchHead =
  | { error: string }
  | { redirected: true }
  | { status: number; ok: boolean; url: string; headers: Record<string, string>; size: number };

const SLICE = 4 * 1024 * 1024;

/**
 * fetch() from inside the inbox tab. The body comes back through the page in
 * slices, because a reel is tens of megabytes and one round trip that size is
 * asking for trouble.
 */
export async function igFetch(pathOrUrl: string, options: FetchOptions = {}): Promise<IgResponse> {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${IG_ORIGIN}${pathOrUrl}`;
  const api = options.api ?? url.startsWith(IG_ORIGIN);

  const first = await fetchInPage(url, api, options);
  if (!("redirected" in first)) return first;

  // One redirect is not a verdict. It also happens when the page navigated
  // mid-request. If the tab is still on the inbox a moment later, ask once
  // more; a second redirect is the real answer.
  await new Promise((resolve) => setTimeout(resolve, 1_500 + Math.random() * 1_500));
  const page = await inboxTab();
  if (turnedAway(page.url())) {
    markSessionDead();
    throw new SessionExpiredError("Instagram signed this session out.");
  }
  const second = await fetchInPage(url, api, options);
  if ("redirected" in second) {
    markSessionDead();
    throw new SessionExpiredError("Instagram redirected to the login page: the session is not signed in.");
  }
  return second;
}

async function fetchInPage(
  url: string,
  api: boolean,
  options: FetchOptions,
): Promise<IgResponse | { redirected: true }> {
  const page = await inboxTab();
  const key = `__igDownload_${Math.random().toString(36).slice(2)}`;
  runtime.busy += 1;
  try {
    return await fetchOnce(page, url, api, options, key);
  } finally {
    runtime.busy = Math.max(0, runtime.busy - 1);
  }
}

async function fetchOnce(
  page: Page,
  url: string,
  api: boolean,
  options: FetchOptions,
  key: string,
): Promise<IgResponse | { redirected: true }> {
  const head: FetchHead = await page.evaluate(
    async ({ url, method, headers, body, api, appId, asbd, key }) => {
      const sent: Record<string, string> = { ...headers };
      if (api) {
        const csrf = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/)?.[1] ?? "";
        let claim = "0";
        try {
          claim = window.sessionStorage.getItem("www-claim-v2") || "0";
        } catch {
          // storage blocked; the default is what a first visit sends anyway
        }
        Object.assign(sent, {
          "x-ig-app-id": appId,
          "x-asbd-id": asbd,
          "x-csrftoken": csrf,
          "x-ig-www-claim": claim,
          "x-requested-with": "XMLHttpRequest",
        });
      }

      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers: sent,
          body,
          credentials: api ? "include" : "omit",
          redirect: "manual",
        });
      } catch (error) {
        return { error: String(error) };
      }
      if (response.type === "opaqueredirect") return { redirected: true as const };

      const blob = await response.blob();
      (window as unknown as Record<string, Blob>)[key] = blob;

      const out: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        out[name] = value;
      });
      return { status: response.status, ok: response.ok, url: response.url, headers: out, size: blob.size };
    },
    {
      url,
      method: options.method ?? "GET",
      headers: options.headers ?? {},
      body: options.body,
      api,
      appId: IG_APP_ID,
      asbd: ASBD_ID,
      key,
    },
  );

  if ("error" in head) {
    throw new Error(`The browser could not fetch ${url}: ${head.error}`);
  }
  if ("redirected" in head) {
    if (api) return { redirected: true };
    throw new Error(`Unexpected redirect fetching ${url}`);
  }

  const parts: Buffer[] = [];
  try {
    for (let offset = 0; offset < head.size; offset += SLICE) {
      const encoded: string = await page.evaluate(
        async ({ key, offset, length }) => {
          const blob = (window as unknown as Record<string, Blob | undefined>)[key];
          if (!blob) return "";
          const bytes = new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
          let binary = "";
          for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          }
          return btoa(binary);
        },
        { key, offset, length: SLICE },
      );
      parts.push(Buffer.from(encoded, "base64"));
    }
  } finally {
    await page
      .evaluate((key) => {
        delete (window as unknown as Record<string, unknown>)[key];
      }, key)
      .catch(() => undefined);
  }

  const body = Buffer.concat(parts);
  return {
    status: head.status,
    ok: head.ok,
    url: head.url,
    headers: head.headers,
    body,
    text: () => body.toString("utf8"),
    json: <T>() => JSON.parse(body.toString("utf8")) as T,
  };
}

/** GET an instagram.com JSON endpoint, as the web client would. */
export async function igJson<T>(pathname: string): Promise<T> {
  const response = await igFetch(pathname, { api: true });

  if (response.status === 429) {
    throw new RateLimitedError(`Instagram answered 429 for ${pathname}`);
  }
  if (response.status === 401 || response.status === 403) {
    const text = response.text();
    if (text.includes("login_required") || text.includes("checkpoint")) markSessionDead();
    throw new SessionExpiredError(`Instagram rejected the request (${response.status}): ${text.slice(0, 200)}`);
  }
  if (!response.ok) {
    throw new Error(`Instagram returned ${response.status} for ${pathname}: ${response.text().slice(0, 400)}`);
  }
  return response.json<T>();
}

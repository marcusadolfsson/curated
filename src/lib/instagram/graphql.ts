import type { Page } from "playwright";
import { inboxTab } from "./tab";

/**
 * Instagram's web GraphQL, called from inside the inbox tab.
 *
 * Everything here was learned by watching the real client: the endpoint is
 * /api/graphql (not /graphql/query, which answers 200 with a null response and
 * does nothing), a write needs fb_dtsg, lsd, jazoest and av from the page HTML,
 * and even with all of those copied exactly the call is refused when it comes
 * from an HTTP client - so it is made with fetch() inside the page, which is also
 * what guarantees the tokens belong to the session making the call.
 *
 * The page is the shared inbox tab. A stale token is cured by reloading it.
 */

export async function graphqlPage(fresh = false): Promise<Page> {
  return inboxTab(fresh ? { refresh: true } : {});
}

export type GraphqlReply = {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message?: string }>;
  error?: number;
  errorSummary?: string;
};

/** Posts one persisted mutation and returns the raw reply text. */
export async function postGraphql(
  page: Page,
  call: { docId: string; friendlyName: string; variables: unknown },
): Promise<string> {
  return page.evaluate(
    async ({ docId, friendlyName, variables }) => {
      const html = document.documentElement.innerHTML;
      const grab = (re: RegExp) => {
        const m = html.match(re);
        return m ? m[1] : "";
      };

      const fbDtsg =
        grab(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/) ||
        grab(/"dtsg":\s*\{\s*"token":\s*"([^"]+)"/);
      const lsd = grab(/"LSD",\[\],\{"token":"([^"]+)"/);
      const actorId = grab(/"actorID":"(\d+)"/) || grab(/"USER_ID":"(\d+)"/);
      const rev = grab(/"__spin_r":(\d+)/) || grab(/"server_revision":(\d+)/);

      let sum = 0;
      for (const char of fbDtsg) sum += char.charCodeAt(0);

      const form = new URLSearchParams({
        av: actorId,
        __d: "www",
        __user: "0",
        __a: "1",
        __req: "1b",
        dpr: "1",
        __ccg: "EXCELLENT",
        __rev: rev,
        __comet_req: "7",
        __crn: "comet.igweb.PolarisDirectInboxRoute",
        lsd,
        fb_dtsg: fbDtsg,
        jazoest: `2${sum}`,
        fb_api_caller_class: "RelayModern",
        fb_api_req_friendly_name: friendlyName,
        server_timestamps: "true",
        doc_id: docId,
        variables,
      });

      const response = await fetch("/api/graphql", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-fb-friendly-name": friendlyName,
          "x-fb-lsd": lsd,
          "x-asbd-id": "359341",
          "x-ig-app-id": "936619743392459",
        },
        body: form.toString(),
        credentials: "include",
      });

      return await response.text();
    },
    { docId: call.docId, friendlyName: call.friendlyName, variables: JSON.stringify(call.variables) },
  );
}

/** Strips the anti-hijacking prefix and parses. Null when it is not JSON. */
export function parseGraphql(body: string): GraphqlReply | null {
  try {
    return JSON.parse(body.replace(/^for\s*\(;;\);/, "")) as GraphqlReply;
  } catch {
    return null;
  }
}

/** The generic refusal Instagram gives when the page's tokens no longer hold. */
export function looksStale(body: string): boolean {
  return body.includes('"error":1357054') || body.includes("errorSummary");
}

/**
 * The client's offline_threading_id: 41 bits of the current time followed by
 * 22 random bits, as a decimal string. Reproduced exactly rather than
 * approximated, since it is what the server dedupes on.
 */
export function offlineThreadingId(now = Date.now()): string {
  const one = BigInt(1);
  const random = BigInt(Math.floor(Math.random() * 4_294_967_296)) & ((one << BigInt(22)) - one);
  const combined = (BigInt(now) << BigInt(22)) | random;
  return (combined & ((one << BigInt(63)) - one)).toString();
}

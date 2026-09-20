export class SessionExpiredError extends Error {
  constructor(message = "Instagram session expired") {
    super(message);
    this.name = "SessionExpiredError";
  }
}

/** Instagram asked us to stop. Worth treating as a full stop, not a retry. */
export class RateLimitedError extends Error {
  constructor(message = "Instagram is rate-limiting this host") {
    super(message);
    this.name = "RateLimitedError";
  }
}

/**
 * Instagram said the quiet part: it thinks this account is scraping.
 *
 * Its own words, on /accounts/scraping_warning/. That is not a fault to retry
 * and not merely a dead session - it is the last warning before a lock, and
 * the only correct response is to stop everything and leave it stopped until a
 * person has read it. Kept separate from SessionExpiredError for exactly that
 * reason: signing back in and carrying on is the worst available answer.
 */
export class ScrapingWarningError extends Error {
  constructor(public readonly url: string) {
    super(
      "Instagram served a scraping warning. Everything is stopped. " +
        "Open Instagram yourself, clear the warning, and leave the automation off for a while.",
    );
    this.name = "ScrapingWarningError";
  }
}

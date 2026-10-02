/**
 * Instagram, or the API in front of it, saying stop. The answer is to stop
 * until a person looks - the automation pauses on this, and nothing retries.
 */
export class RateLimitedError extends Error {
  constructor(message = "Instagram is rate-limiting this host") {
    super(message);
    this.name = "RateLimitedError";
  }
}

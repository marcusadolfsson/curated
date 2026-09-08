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

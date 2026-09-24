// An in-memory stand-in for `enforceRateLimit` with the same semantics, for
// unit tests that need a limiter that actually COUNTS.
//
// WHY. A mocked limiter that resolves or rejects on command proves the code
// calls it and reacts to it; it cannot prove that two buckets compose — that a
// ceiling keyed on the token refuses a caller the per-address ceiling would
// have let through. This one keeps a counter per `${endpoint}:${identifier}`
// per window, increments before comparing, and throws on the first window
// that is over, exactly as lib/infra/rate-limit.ts does against
// `rate_limit_buckets`. The clock is the test's, so windows are deterministic.
//
// The error is built by the caller, because each test file mocks
// `RateLimitError` with its own class and the code under test checks
// `instanceof` against that one.

type Limits = { maxPerMinute?: number; maxPerHour?: number; maxPerDay?: number };

const WINDOWS = [
  ["minute", 60_000, "maxPerMinute"],
  ["hour", 3_600_000, "maxPerHour"],
  ["day", 86_400_000, "maxPerDay"],
] as const;

export function makeFakeRateLimiter(makeError: (bucketKey: string) => Error) {
  const counts = new Map<string, number>();
  let nowMs = 0;

  async function enforce(endpoint: string, identifier: string, config: Limits): Promise<void> {
    for (const [name, size, field] of WINDOWS) {
      const limit = config[field];
      if (limit === undefined) continue;
      const key = `${endpoint}:${identifier}:${name}:${Math.floor(nowMs / size)}`;
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (count > limit) throw makeError(key);
    }
  }

  return {
    enforce,
    /** Moves the test clock forward. */
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

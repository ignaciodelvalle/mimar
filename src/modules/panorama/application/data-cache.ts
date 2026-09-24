// Shared helper for the Panorama cross-request (Vercel Data Cache) layers.
//
// WHY: Next's `unstable_cache` requires the incremental cache, which only exists
// inside a request/render (route handlers, server components). OUTSIDE one — unit
// tests, scripts, any non-App-Router context — its first call throws an
// "incrementalCache missing" invariant (tagged __NEXT_ERROR_CODE "E469"). The
// Panorama caches must degrade to "no L2 cache" in those contexts instead of
// failing: caching is an optimization, never a correctness requirement. In every
// production request path the incremental cache is present, so this fallback is
// a no-op there.

/**
 * Detect Next's "incrementalCache missing in unstable_cache" invariant. Matches
 * the stable error code first, the message as a secondary guard in case the code
 * changes across a minor version. Any OTHER error is a genuine failure and must
 * propagate.
 */
export function isIncrementalCacheMissing(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { __NEXT_ERROR_CODE?: string }).__NEXT_ERROR_CODE;
  return code === "E469" || err.message.includes("incrementalCache missing");
}

/**
 * One-shot observability for the incremental-cache-missing fallback. In unit
 * tests / scripts the Data Cache is legitimately absent, so the Panorama loaders
 * degrade to UNCACHED compute silently. In PRODUCTION every render path has the
 * incremental cache, so this fallback firing signals a real Data Cache outage —
 * which otherwise degrades performance INVISIBLY (every layer/KPI request recomputes
 * the full fan-out). Warn ONCE per process so a prod outage is visible in the logs
 * without spamming a line per request (or per test).
 */
let warnedIncrementalCacheMissing = false;
export function warnIncrementalCacheMissingOnce(context: string): void {
  if (warnedIncrementalCacheMissing) return;
  warnedIncrementalCacheMissing = true;
  console.warn(
    `[panorama-cache] Data Cache unavailable (incrementalCache missing) — serving ${context} UNCACHED. Expected in unit tests/scripts; in production this signals a Data Cache outage (every request recomputes the full fan-out). Logged once per process.`,
  );
}

// Bounded DB fan-out helper — "never hang, never crash".
//
// LIVED IN src/modules/panorama/application/ UNTIL 2026-08-21, because that is
// where the incident below happened. Its consumers said otherwise long before
// it moved: 13 of the 23 files that use it are outside panorama — the public
// credential page, /refugios, three admin surfaces, /api/health, the gob
// worklist. It is infrastructure that a module happened to be holding.
//
// The move was forced by an architectural check rather than noticed by anyone:
// Track 2 extracts the credential loader into src/modules/pets/, the loader
// bounds its fan-out with this helper, and `pets:panorama` is not an allowed
// edge in check-dependency-direction.ts. Adding the edge would have legitimised
// a dependency that never made sense; lowering the helper to lib/ is the fix,
// and module -> lib is always allowed.
//
// PRODUCTION INCIDENT (task #74): the universal-scope admin console fires ~11
// aggregate queries via Promise.all + the layer fetchers. On the shared micro DB
// under contention, once the transaction pooler degrades these queries HANG
// indefinitely. Two failure modes followed:
//   1. The Vercel lambda's RSC stream truncated — the page shows loading
//      skeletons forever with zero client errors.
//   2. A rejected query that no longer had a consumer (Promise.all had already
//      settled on another rejection, abandoning its siblings) surfaced as an
//      UNHANDLED REJECTION that crashed the lambda mid-response
//      ("Node.js process exited"), which abandoned pooler slots and fed the
//      death spiral.
//
// withDbBudget bounds a DB promise on BOTH axes:
//   - TIME: races the promise against a timeout; on expiry it resolves a
//     caller-supplied degraded `fallback` so the response renders a
//     degraded-but-honest state instead of hanging the stream.
//   - CRASH-SAFETY: it always attaches a `.catch` to the underlying promise, so
//     a rejection that arrives AFTER the timeout already resolved the race
//     (the abandoned-sibling case) is swallowed-and-logged and can never become
//     an unhandledRejection.
//
// Semantics by outcome:
//   - resolves before the budget  → the real value.
//   - rejects  before the budget  → withDbBudget REJECTS (propagates) so the
//                                    caller (route handler) can answer with a
//                                    503 envelope. A page caller adds its own
//                                    `.catch(fallback)` to degrade instead.
//   - budget elapses first        → resolves `fallback` (degraded). Any later
//                                    settle of the underlying promise is
//                                    swallowed (value dropped / rejection logged).

/**
 * Run `promise` with a time budget and crash-safety.
 *
 * @param promise  the DB work to bound (e.g. a fan-out Promise.all/allSettled).
 * @param ms       budget in milliseconds; on expiry `fallback` is resolved.
 * @param label    short identifier for logs (e.g. "GET /api/panorama/kpis").
 * @param fallback the degraded value to resolve when the budget elapses.
 */
export async function withDbBudget<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  fallback: T,
): Promise<T> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      console.warn(`[db-budget] ${label} exceeded ${ms}ms budget — returning degraded result`);
      resolve(fallback);
    }, ms);
  });

  // Always attach a catch. Before the timeout, rethrow so the rejection wins the
  // race and propagates to the caller. After the timeout, the caller has already
  // moved on with `fallback`, so a late rejection is swallowed-and-logged — this
  // is the guard that prevents the abandoned-query crash.
  const guarded: Promise<T> = promise.catch((err) => {
    if (timedOut) {
      console.error(`[db-budget] ${label} rejected after budget elapsed (swallowed):`, err);
      return fallback;
    }
    throw err;
  });

  try {
    return await Promise.race([guarded, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Thrown by `withDbBudgetOrThrow` when the time budget elapses. Typed so a caller
 * can distinguish a bounded give-up from a genuine loader failure. */
export class DbBudgetExceededError extends Error {
  constructor(label: string, ms: number) {
    super(`[db-budget] ${label} exceeded ${ms}ms budget`);
    this.name = "DbBudgetExceededError";
  }
}

/**
 * Like `withDbBudget`, but on budget expiry it THROWS `DbBudgetExceededError`
 * instead of resolving a degraded fallback — for callers that must NOT persist a
 * degraded value on timeout.
 *
 * The motivating case (task #39, incident `panorama/layer-cache-revalidation-crash`):
 * the layer Data Cache wraps the raw loader in `unstable_cache` and keeps the
 * budget OUTSIDE the cache so a degraded envelope is never stored. But Next's
 * stale-while-revalidate BACKGROUND re-invocation then re-runs the raw loader with
 * NO budget and NO rejection consumer — a >300s Postgres 57014 escaped as an
 * unhandled rejection and killed the process. Wrapping the cached body with THIS
 * helper bounds that background work AND, by THROWING (not returning a value),
 * makes `unstable_cache` keep the stale entry rather than cache a degraded one.
 *
 * CRASH-SAFETY (identical discipline to `withDbBudget`): a `.catch` is always
 * attached to the underlying promise, so a DB rejection that arrives AFTER the
 * budget already lost the race is swallowed-and-logged and can NEVER become an
 * unhandledRejection. The only rejection that propagates is the typed timeout
 * error, which the request path degrades on (call-site budget) and the background
 * path is backstopped against by the process-level crash guard.
 *
 * Semantics by outcome:
 *   - resolves before the budget → the real value.
 *   - rejects  before the budget → propagates the real error.
 *   - budget elapses first       → throws `DbBudgetExceededError`; any later
 *                                   settle of the underlying promise is swallowed.
 */
export async function withDbBudgetOrThrow<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      console.warn(
        `[db-budget] ${label} exceeded ${ms}ms budget — throwing (revalidation keeps the stale entry)`,
      );
      reject(new DbBudgetExceededError(label, ms));
    }, ms);
  });

  // Always attach a catch. Before the timeout, rethrow so the real rejection wins
  // the race. After the timeout, the race already rejected with the typed error,
  // so a late DB rejection is swallowed-and-logged (resolving this now-ignored
  // promise) — the guard that prevents the abandoned-query unhandledRejection.
  const guarded: Promise<T> = promise.catch((err) => {
    if (timedOut) {
      console.error(`[db-budget] ${label} rejected after budget elapsed (swallowed):`, err);
      return undefined as unknown as T;
    }
    throw err;
  });

  try {
    return await Promise.race([guarded, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

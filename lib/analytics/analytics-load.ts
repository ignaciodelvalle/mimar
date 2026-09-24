// lib/analytics-load.ts — bounded loading for the admin analytics dashboards (D2)
// and, since the platform-budget pass (T3), other heavy admin pages too.
//
// The admin analytics pages (/admin/programa, /censo, /poblacion) await a
// Promise.all of population-scale fetchers in a force-dynamic server component.
// If one fetcher is pathologically slow (a missing index, a lock, a degraded
// DB) the whole request hangs and the operator stares at a blank/loading page
// with no escape. loadWithTimeout races the fetch against a deadline and folds
// a rejection into the same shape, so the page can render an honest
// "tardando… reintentar" state instead of hanging forever.
//
// T3 widened the audience beyond analytics: /admin/auditoria bounds its whole
// fetch group with loadWithTimeout, and /admin/inteligencia races one deadline
// PER STREAMED PANEL (three independent budgets instead of a single all-or-
// nothing Promise.all race). Same contract everywhere: the deadline bounds the
// wait, it does NOT cancel the underlying queries.

import { reportError } from "@/lib/observability/report-error";
import { unstable_rethrow } from "next/navigation";

/** Deadline for an analytics page's fetcher set before it degrades (D2: 10 s). */
export const ANALYTICS_LOAD_TIMEOUT_MS = 10_000;

/**
 * Discriminated result: data on success, a reason on timeout/error.
 *
 * `id` (QA fix 6) is a short correlation id minted on every failure: the same
 * id is logged server-side with the REAL error (this module used to swallow
 * the rejection entirely) and rendered subtly by AnalyticsLoadFallback
 * ("Código: <id>") so a human report can be matched to the server log line.
 * Optional in the type so hand-built fixtures/older constructions still fit.
 */
export type AnalyticsLoad<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "timeout" | "error"; id?: string };

/** Short, human-quotable correlation id (8 hex chars of a UUID). */
function newCorrelationId(): string {
  try {
    return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  } catch {
    // Extremely defensive — every supported runtime (Node 18+, edge) has
    // crypto.randomUUID; keep the fallback so the degraded path can't throw.
    return Math.random().toString(36).slice(2, 10);
  }
}

/**
 * Race `promise` against a `ms` deadline.
 *
 * - Resolves `{ ok: true, value }` when the promise settles first.
 * - Resolves `{ ok: false, reason: "timeout", id }` when the deadline wins.
 * - Resolves `{ ok: false, reason: "error", id }` when the promise rejects.
 *
 * Never rejects — the caller branches on `ok`. The timer is always cleared so a
 * fast success does not keep the event loop alive.
 *
 * Failures report the underlying error through `lib/observability/report-error`
 * tagged with the correlation id the fallback UI displays. The id travels in
 * the report's `context` subtree, NOT at its top level: `buildErrorReport`
 * keeps the error's own fields (`message`, `name`, `stack`, `digest`, `ts`)
 * separate from caller-supplied context, because the two are scrubbed by
 * different rules — free text by denylist, context by a closed allowlist.
 * Read `report.context.correlationId`, never `report.correlationId`.
 *
 * NOTE: a timeout does not cancel the underlying work (DB queries keep running
 * to completion in the background); it only bounds how long the request waits.
 */
export async function loadWithTimeout<T>(
  promise: Promise<T>,
  ms: number = ANALYTICS_LOAD_TIMEOUT_MS,
): Promise<AnalyticsLoad<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Settled-once guard: when the deadline wins the race, the abandoned
  // promise keeps running and its LATER rejection used to mint a SECOND
  // correlation id and log a second line — two ids for one user-visible
  // failure, and the id the operator quotes from the fallback UI may be the
  // one that names the timeout, not the real error. First settle owns the id;
  // the late rejection is swallowed (the timeout line already logged, and the
  // caller can no longer observe anything).
  let deadlineWon = false;
  const deadline = new Promise<AnalyticsLoad<T>>((resolve) => {
    timer = setTimeout(() => {
      deadlineWon = true;
      const id = newCorrelationId();
      reportError(new Error(`analytics load timed out after ${ms} ms`), {
        source: "loadWithTimeout",
        correlationId: id,
      });
      resolve({ ok: false, reason: "timeout", id });
    }, ms);
  });

  try {
    return await Promise.race([
      promise.then(
        (value): AnalyticsLoad<T> => ({ ok: true, value }),
        (err): AnalyticsLoad<T> => {
          // NEXT'S CONTROL FLOW IS NOT A FAILURE, and swallowing it here would
          // be the worst kind of bug: silent, and pointed at the wrong person.
          //
          // `redirect()` and `notFound()` signal by THROWING a sentinel that the
          // framework catches upstream. This handler turns every rejection into
          // `{ok:false}`, so a caller who wrapped anything that redirects —
          // `requireUserOrRedirect()` is the obvious one — would find the
          // redirect quietly converted into a degraded panel. A visitor with no
          // session would be shown "no pudimos cargar esto" instead of the login
          // screen, and nothing anywhere would report a problem.
          //
          // This is not hypothetical in this repo: `app/org/[orgToken]/intake/
          // importar/actions.ts:277` carries a note about a NEXT_REDIRECT that a
          // loop's catch had already eaten once.
          //
          // `unstable_rethrow` is Next's own answer — it re-throws the framework
          // sentinels (redirect, notFound, dynamic-usage) and returns for
          // everything else. The `unstable_` prefix is the API's name, not a
          // warning about what it does; there is no stable alias in Next 15.
          unstable_rethrow(err);

          if (deadlineWon) {
            // Race already resolved with the timeout result — this return
            // value is discarded, so do NOT mint another id or log again.
            return { ok: false, reason: "timeout" };
          }
          const id = newCorrelationId();
          reportError(err instanceof Error ? err : new Error(String(err)), {
            source: "loadWithTimeout",
            correlationId: id,
          });
          return { ok: false, reason: "error", id };
        },
      ),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Build the "Reintentar" href for a degraded analytics page: the page path plus
 * the current period search params (so retrying keeps the operator's filter).
 * Undefined/empty params are dropped.
 */
export function analyticsRetryHref(
  path: string,
  sp: Record<string, string | undefined> = {},
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (value != null && value !== "") params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

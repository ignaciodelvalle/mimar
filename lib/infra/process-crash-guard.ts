// Process-level crash backstop (task #74, hardened in task #39).
//
// The last line of defence for ANY code path that leaks an unhandled rejection or
// uncaught exception: without a listener, Node ≥15 TERMINATES the process on an
// unhandled rejection — the exact failure that fed the staging pooler death spiral
// and, later, the layer-cache background-revalidation crash (incident
// `panorama/layer-cache-revalidation-crash`): a >300s Postgres 57014 from Next's
// stale-while-revalidate re-invocation escaped as an unhandledRejection.
//
// COVERAGE (be precise — the incident's open question was "does the guard even
// register in the process that received the rejection?"):
//   - This registers on the CURRENT process. It is called from `instrumentation.ts`
//     `register()` in the Node.js server runtime (NEXT_RUNTIME === "nodejs"). Next's
//     `unstable_cache` background revalidation runs IN-PROCESS in that same server
//     runtime, so a bounded revalidation rejection IS covered here.
//   - It does NOT (and cannot) cover the `pnpm`/`next start` PARENT wrapper process,
//     which runs no application code. If a child server process exits, the wrapper
//     reports ELIFECYCLE — that is the wrapper observing the child, not a rejection
//     the wrapper itself could have caught. The durable mitigation for THAT is
//     bounding the work so the child never dies (see `withDbBudgetOrThrow`).
//
// Extracted from instrumentation.ts so the registration + survive behavior is unit
// testable (instrumentation.ts can only run inside Next's boot).

const globalForGuards = globalThis as unknown as { __dimProcessGuards?: boolean };

/**
 * Register the unhandledRejection + uncaughtException backstops on the current
 * process, once. Idempotent across dev HMR re-runs (a global flag guards it).
 * Returns true if it registered this call, false if already registered.
 */
export function registerProcessCrashGuards(): boolean {
  if (globalForGuards.__dimProcessGuards) return false;
  globalForGuards.__dimProcessGuards = true;

  process.on("unhandledRejection", (reason) => {
    // Log and KEEP SERVING. Without a listener, Node terminates the process
    // (Node ≥15 default) — exactly the crash that fed the spiral.
    console.error("[unhandledRejection] kept process alive:", reason);
  });

  process.on("uncaughtException", (err, origin) => {
    // A stateless request server recovers better by staying up than by dying
    // mid-response. Log with origin; do NOT process.exit().
    console.error(`[uncaughtException] (${origin}) kept process alive:`, err);
  });

  return true;
}

/** Test-only: reset the idempotency flag so a unit test can re-register. */
export function __resetProcessCrashGuardsForTest(): void {
  globalForGuards.__dimProcessGuards = false;
}

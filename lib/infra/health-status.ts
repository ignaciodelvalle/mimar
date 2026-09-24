// Pure health-status evaluation for GET /api/health — no I/O, unit-testable.
//
// The route (app/api/health/route.ts) gathers three cheap signals — a `select 1`
// DB ping (timed), whether that ping succeeded, and a read-only count of the
// currently-stuck Supavisor backends (the same predicate reap_stuck_app_backends
// terminates on, migration 0136) — and hands them here to decide the response.
//
// Kept pure and separate from the route so the decision table is tested without
// a DB or a running server.

/** Ping latency (ms) above which a SUCCESSFUL ping still counts as degraded. */
export const DEGRADED_PING_MS = 1000;

export type HealthInputs = {
  /** Did the `select 1` ping resolve within its budget? */
  dbOk: boolean;
  /** Measured ping latency in ms (wall clock around the ping). */
  pingMs: number;
  /**
   * Count of currently-stuck Supavisor backends, or null when the read itself
   * failed / is unavailable (predicate query errored, timed out, or the DB is
   * down). null is treated as "unknown" — it never by itself marks the service
   * degraded, so the endpoint can't flip to 503 just because the saturation
   * probe couldn't run.
   */
  stuckBackends: number | null;
};

export type HealthStatus = "ok" | "degraded" | "down";

export type HealthEvaluation = {
  status: HealthStatus;
  degraded: boolean;
  /** 200 only when fully healthy; 503 otherwise (contract for the poller). */
  httpStatus: 200 | 503;
};

/**
 * Decide the health status from the gathered signals.
 *
 *   - db ping failed / timed out              → "down"     (503)
 *   - ping ok but slow (> DEGRADED_PING_MS)
 *     OR stuck backends present (> 0)          → "degraded" (503)
 *   - otherwise                                → "ok"       (200)
 */
export function evaluateHealth({ dbOk, pingMs, stuckBackends }: HealthInputs): HealthEvaluation {
  if (!dbOk) {
    return { status: "down", degraded: true, httpStatus: 503 };
  }
  const degraded = pingMs > DEGRADED_PING_MS || (stuckBackends !== null && stuckBackends > 0);
  return degraded
    ? { status: "degraded", degraded: true, httpStatus: 503 }
    : { status: "ok", degraded: false, httpStatus: 200 };
}

// GET /api/health — unauthenticated, cheap, no-store liveness + saturation probe.
//
// PURPOSE (PO ask 2026-07-10 — "agregar algún test/forma de detectar estos
// errores / baja performance"): give an EXTERNAL poller
// (.github/workflows/staging-health.yml) a single URL that answers 200 only when
// staging is truly healthy and 503 the instant the DB is unreachable, slow, or
// the transaction pooler is saturating with stuck backends (the task #74 death
// spiral). GitHub emails the repo owner when the polling workflow run fails —
// that email IS the alert. No new infra to operate.
//
// It must be CHEAP and must NEVER HANG: every DB touch carries its own short
// budget (withDbBudget) plus a fail-open catch, so a degraded DB makes the probe
// REPORT degradation quickly instead of hanging with it. It requires NO auth
// (a poller can't authenticate) and returns NO sensitive data:
//   { status, db: { ok, pingMs }, stuckBackends, degraded, ts }

import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db";
import { withDbBudget } from "@/lib/infra/db-budget";
import { evaluateHealth } from "@/lib/infra/health-status";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // postgres-js needs the Node runtime, not edge.

// Short, INDEPENDENT budgets — the probe must fail FAST, never hang with the DB.
const PING_BUDGET_MS = 2500;
const STUCK_BUDGET_MS = 2000;
const RATE_LIMIT_BUDGET_MS = 1500;

// Read-only twin of public.reap_stuck_app_backends() (migration 0136): counts
// the currently-stuck Supavisor backends WITHOUT terminating any, so the endpoint
// reports pooler saturation early. The predicate is kept in lock-step with the
// reaper (60s runaway / 30s abandoned ClientRead / 60s idle-in-transaction). If
// this read is unavailable (missing pg_stat_activity grant, heavy/slow, DB down)
// it degrades to null — never an error.
const STUCK_BACKENDS_SQL = sql`
  select count(*)::int as count
  from pg_stat_activity
  where backend_type = 'client backend'
    and application_name = 'Supavisor'
    and pid <> pg_backend_pid()
    and (
      (state = 'active' and wait_event is distinct from 'ClientRead'
        and now() - query_start > interval '60 seconds')
      or (state = 'active' and wait_event = 'ClientRead'
        and now() - query_start > interval '30 seconds')
      or (state = 'idle in transaction'
        and now() - state_change > interval '60 seconds')
    )
`;

// @no-auth-required: liveness probe. An external, credential-less poller
// (.github/workflows/staging-health.yml) is the only intended caller, so there
// is no session to resolve and no secret it could hold. The response carries no
// PII and no per-subject data — status, DB ping latency, a stuck-backend count,
// a degraded flag and a timestamp.
//
// The IP rate limit (60/min) is real but it is NOT a bound on abuse, and this
// reason used to claim it was. `enforceRateLimit` writes to the same database
// this endpoint exists to report on, and the call below is deliberately
// FAIL-OPEN: a budget timeout or any non-RateLimitError failure is swallowed so
// the probe still answers. So the limit holds exactly while the DB is healthy
// and lifts exactly when it is not — which is the state a scanner is probing
// for. Accepted knowingly: what an unlimited caller learns is the health signal
// itself, and a failing request to any other route on the deployment already
// says the same thing. Making the limit fail-CLOSED would silence the alarm
// during the incident it was built for.
export async function GET(request: Request): Promise<NextResponse> {
  // Light, FAIL-OPEN rate limit. A RateLimitError → 429; any OTHER failure (e.g.
  // the DB itself is down, so the rate-limit write throws) is swallowed so the
  // probe can still report the real health signal instead of breaking on the
  // rate-limit write.
  try {
    await withDbBudget(
      enforceRateLimit("health", callerIp(request.headers), { maxPerMinute: 60 }).then(() => null),
      RATE_LIMIT_BUDGET_MS,
      "GET /api/health rate-limit",
      null,
    );
  } catch (err) {
    if (err instanceof RateLimitError) {
      return NextResponse.json(
        { status: "rate_limited" },
        { status: 429, headers: { "cache-control": "no-store" } },
      );
    }
    // fall through — report health honestly.
  }

  // (a) Trivial DB ping with its OWN short budget + timing. The async IIFE turns
  // a synchronous throw (e.g. the missing-DATABASE_URL proxy in db/index.ts) into
  // a rejection so withDbBudget / .catch handle every failure uniformly.
  const pingStart = Date.now();
  const dbOk = await withDbBudget(
    (async () => {
      await db.execute(sql`select 1`);
      return true;
    })(),
    PING_BUDGET_MS,
    "GET /api/health db-ping",
    false,
  ).catch(() => false);
  const pingMs = Date.now() - pingStart;

  // (b) Read-only saturation probe. Only attempted when the ping succeeded (no
  // point probing a dead DB), and degrades to null on any failure.
  const stuckBackends = dbOk
    ? await withDbBudget<number | null>(
        (async () => {
          const rows = (await db.execute(STUCK_BACKENDS_SQL)) as Array<{ count: number }>;
          return Number(rows[0]?.count ?? 0);
        })(),
        STUCK_BUDGET_MS,
        "GET /api/health stuck-backends",
        null,
      ).catch(() => null)
    : null;

  const { status, degraded, httpStatus } = evaluateHealth({ dbOk, pingMs, stuckBackends });

  return NextResponse.json(
    { status, db: { ok: dbOk, pingMs }, stuckBackends, degraded, ts: new Date().toISOString() },
    { status: httpStatus, headers: { "cache-control": "no-store" } },
  );
}

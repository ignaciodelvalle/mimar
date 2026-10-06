// Cron route — rebuild the panorama aggregate cube (road-to-10 infra #1, mig 0139).
//
// GET /api/cron/refresh-cube
//
// Authentication: `Authorization: Bearer <CRON_SECRET>` (Vercel Cron contract) or
// legacy `x-cron-secret: <CRON_SECRET>` — same gate as every other cron route
// (lib/domain/cron-auth.ts).
//
// Runs the TS cube-builder (src/modules/panorama/infrastructure/cube-builder.ts),
// which REUSES the live choropleth loaders and writes panorama_cube + cube_meta in
// one transaction. SCHEDULED (cube-ON decision, K4/S3 2026-07-24): its OWN daily
// vercel.json cron entry (`0 3 * * *`, one hour ahead of the 04:00 daily bag) —
// it cannot ride the daily dispatcher because the build (~105s) exceeds the
// dispatcher's 55s budget. Registered in CRON_REGISTRY as a standalone scheduled
// job (NOT in DAILY_JOB_ORDER), so cron-health monitors it. This uses the 2nd and
// last Vercel Hobby cron slot; a sub-daily cadence (the original */15 idea) needs
// Vercel Pro (fase 3). Manual runs (`pnpm cube:refresh` locally) still work.
//
// NOTE: the builder brings its OWN lazy session-pooler clients for BOTH phases
// (task #22): reads AND the write transaction get a long statement_timeout
// (default 120s, CUBE_BUILDER_STATEMENT_TIMEOUT_MS) — the shared analyticsDb
// pool's 15s request-path backstop never applies to the build. The LOCAL
// measured rebuild is ~105s (24 province × 5 metric loader calls) — well past
// the 60s cron default, so this route pins maxDuration to 300s (the Fluid
// compute ceiling, available on Hobby). Staging
// should be faster (gru1 + session pooler), but the pin makes the cap a
// non-issue either way.
//
// Returns: { ok, status, rowCount, durationMs, watermark, builtAt, perMetric, kpi }
// `kpi` is the KPI-strip cube phase (migration 0151) — an independent failure
// domain: `ok` (and the cron_runs status) is true only when BOTH cubes swapped.

import { type NextRequest, NextResponse } from "next/server";

import { authorizeCronRequest } from "@/lib/domain/cron-auth";
import { closeAbandonedCronRuns, withCronRun, withDeadline } from "@/lib/infra/case-cron";
import {
  cubeBuilderStatementTimeoutMs,
  refreshCube,
} from "@/src/modules/panorama/infrastructure/cube-builder";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CRON_NAME = "refresh_cube";

// The whole build (retry included) must settle 60s before maxDuration, so a
// HUNG build still leaves time to finalize the cron_runs row and page. Before
// this deadline (2026-10) a hang ran into the platform's hard kill at 300s and
// the row stayed 'running' forever: 8 of 10 nightly runs on staging, with no
// alert and no error message anywhere.
const BUILD_DEADLINE_MS = 240_000;

// At the deadline the build is ABORTED (its DB clients are destroyed, so its
// pending queries reject and its own catch stamps the cube meta 'error'), and
// the route waits this long for that unwinding before finalizing the row.
// 240s + 15s still lands well inside maxDuration.
const ABORT_DRAIN_MS = 15_000;

// The abandoned-run sweep is a one-row UPDATE; a hang there must not eat the
// budget of the run that has not even opened its row yet.
const SWEEP_DEADLINE_MS = 10_000;

// A 'running' row older than this cannot belong to a live invocation (3x
// maxDuration). The sweep closes such rows as 'failed' at the next run.
const ABANDONED_AFTER_MS = 15 * 60 * 1000;

/**
 * A run is 'ok' only when BOTH cubes swapped — a KPI-only failure is a real
 * (alertable) partial failure, even though its reader degrades to live.
 */
function bothCubesSwapped(r: Awaited<ReturnType<typeof refreshCube>>): boolean {
  return r.status === "ok" && r.kpi.status === "ok";
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authError = authorizeCronRequest(req);
  if (authError) {
    return NextResponse.json({ ok: false, error: authError.error }, { status: authError.status });
  }

  // withCronRun (C04-4, 2026-09): this route used to insert and finalize its own
  // cron_runs row, so a failed build was recorded but never ALERTED (every other
  // cron pages through withCronRun / runCaseCron), and a THROW from the builder
  // left the row at 'running' until cron-health's stuck threshold noticed.
  // withCronRun finalizes on throw, and `failed` below turns a structured
  // failure into the same page.
  //
  // An earlier invocation killed at maxDuration never finalized its row; close
  // it so the history reads 'failed', not 'running' forever.
  // Best-effort and bounded: its failure or hang never blocks the run.
  await withDeadline(
    closeAbandonedCronRuns(CRON_NAME, ABANDONED_AFTER_MS),
    SWEEP_DEADLINE_MS,
    "abandoned-run sweep timed out",
  ).catch(() => null);

  const result = await withCronRun(
    CRON_NAME,
    () => {
      const controller = new AbortController();
      const startedAt = Date.now();
      const work = buildWithRetry(controller.signal, startedAt);
      return withDeadline(
        work,
        BUILD_DEADLINE_MS,
        `refresh_cube did not finish within ${BUILD_DEADLINE_MS / 1000}s (maxDuration ${maxDuration}s): the build hung and was aborted`,
        async () => {
          controller.abort("deadline");
          await withDeadline(
            work.then(
              () => undefined,
              () => undefined,
            ),
            ABORT_DRAIN_MS,
            "abort drain timed out",
          ).catch(() => undefined);
        },
      );
    },
    (r) => ({
      itemsProcessed: r.rowCount,
      details:
        r.status === "ok"
          ? { rowCount: r.rowCount, durationMs: r.durationMs, perMetric: r.perMetric, kpi: r.kpi }
          : { error: r.error ?? "unknown", kpi: r.kpi },
      failed: !bothCubesSwapped(r),
    }),
  );
  const cronStatus = bothCubesSwapped(result) ? "ok" : "failed";

  return NextResponse.json(
    {
      ok: cronStatus === "ok",
      status: result.status,
      rowCount: result.rowCount,
      durationMs: result.durationMs,
      watermark: result.watermark,
      builtAt: result.builtAt,
      perMetric: result.perMetric,
      kpi: result.kpi,
      ...(result.error ? { error: result.error } : {}),
    },
    {
      status: cronStatus === "ok" ? 200 : 500,
      headers: { "cache-control": "no-store" },
    },
  );
}

async function buildWithRetry(
  signal: AbortSignal,
  startedAt: number,
): Promise<Awaited<ReturnType<typeof refreshCube>>> {
  // One retry on a statement timeout (SQLSTATE 57014). Builder reads now run
  // on a dedicated long-timeout client (task #22), so this should be rare —
  // it covers a genuinely pathological query (cold cache + contention past
  // even the long ceiling). A failed build is already fail-safe (read errors
  // return a structured error result, last-good cube preserved, reader falls
  // to live) — the retry just avoids wasting the whole run on one cold query.
  let r = await refreshCube({ signal });
  // The KPI-strip phase (own failure domain inside the builder) participates
  // in the retry too: a cold-query timeout in its fan-out is exactly as
  // retryable as one in the layer loaders.
  const timedOut = (x: typeof r) =>
    /57014|statement timeout/i.test(`${x.error ?? ""} ${x.kpi.error ?? ""}`);
  // Retry only when a whole statement timeout still fits before the deadline:
  // a retry cut short by the abort would just be a second failure, and one
  // that started too late could race the route's finalize.
  const timeLeftMs = BUILD_DEADLINE_MS - (Date.now() - startedAt);
  if (
    (r.status !== "ok" || r.kpi.status !== "ok") &&
    timedOut(r) &&
    !signal.aborted &&
    timeLeftMs > cubeBuilderStatementTimeoutMs()
  ) {
    r = await refreshCube({ signal });
  }
  return r;
}

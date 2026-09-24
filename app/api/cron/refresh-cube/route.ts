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
import { withCronRun } from "@/lib/infra/case-cron";
import { refreshCube } from "@/src/modules/panorama/infrastructure/cube-builder";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CRON_NAME = "refresh_cube";

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
  const result = await withCronRun(
    CRON_NAME,
    async () => {
      // One retry on a statement timeout (SQLSTATE 57014). Builder reads now run
      // on a dedicated long-timeout client (task #22), so this should be rare —
      // it covers a genuinely pathological query (cold cache + contention past
      // even the long ceiling). A failed build is already fail-safe (read errors
      // return a structured error result, last-good cube preserved, reader falls
      // to live) — the retry just avoids wasting the whole run on one cold query.
      let r = await refreshCube();
      // The KPI-strip phase (own failure domain inside the builder) participates
      // in the retry too: a cold-query timeout in its fan-out is exactly as
      // retryable as one in the layer loaders.
      const timedOut = (x: typeof r) =>
        /57014|statement timeout/i.test(`${x.error ?? ""} ${x.kpi.error ?? ""}`);
      if ((r.status !== "ok" || r.kpi.status !== "ok") && timedOut(r)) {
        r = await refreshCube();
      }
      return r;
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

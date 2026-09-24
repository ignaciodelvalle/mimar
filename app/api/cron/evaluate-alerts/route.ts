// Cron route — evaluate every active alert subscription and open firings for
// new breaches (Paquete K). Runs daily so triage does not depend on an admin
// opening /admin/programa.
//
// GET /api/cron/evaluate-alerts
//
// Authentication: `Authorization: Bearer <CRON_SECRET>` (Vercel Cron) or the
// legacy `x-cron-secret` header — see lib/cron-auth.ts.
//
// Idempotent: evaluateAndRecordFiringsForAllAdmins dedupes via shouldOpenFiring
// (one open firing per subscription), so a re-run never duplicates an open alert.

import { type NextRequest, NextResponse } from "next/server";

import { evaluateAndRecordFiringsForAllAdmins } from "@/app/actions/alert-firings";
import { authorizeCronRequest } from "@/lib/domain/cron-auth";
import { readLastRunDetail, withCronRun } from "@/lib/infra/case-cron";

export const dynamic = "force-dynamic";

const CRON_NAME = "evaluate_alerts";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authError = authorizeCronRequest(req);
  if (authError) {
    return NextResponse.json({ ok: false, error: authError.error }, { status: authError.status });
  }

  const start = Date.now();
  try {
    // Resume the per-owner sweep after the last owner processed by the previous
    // run (keyset cursor piggy-backed on cron_runs.details — no new table) so a
    // large admin population is swept fairly across runs (review 23 fleet ext).
    const resumeCursor = await readLastRunDetail<string | null>(CRON_NAME, "nextOwnerCursor");
    const result = await withCronRun(
      CRON_NAME,
      () =>
        evaluateAndRecordFiringsForAllAdmins({
          afterUserId: resumeCursor,
          budgetHeaders: req.headers,
        }),
      (r) => ({
        itemsProcessed: r.evaluated,
        details: {
          evaluated: r.evaluated,
          breaching: r.breaching,
          opened: r.opened,
          ownersTotal: r.ownersTotal,
          ownersEvaluated: r.ownersEvaluated,
          budgetExhausted: r.budgetExhausted,
          nextOwnerCursor: r.nextOwnerCursor ?? null,
        },
      }),
    );
    return NextResponse.json({
      ok: true,
      ...result,
      durationMs: Date.now() - start,
    });
  } catch (err) {
    console.error("[cron/evaluate-alerts] failed:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "error desconocido" },
      { status: 500 },
    );
  }
}

// Cron route — expire foster proposals past their 7-day pending window.
//
// GET /api/cron/expire-foster-proposals
//
// Authentication: header `x-cron-secret` must match process.env.CRON_SECRET.
// Mirror of app/api/cron/close-rabies-observations/route.ts.
//
// Returns: { ok: true, ...stats, durationMs }

import { type NextRequest, NextResponse } from "next/server";

import { authorizeCronRequest } from "@/lib/domain/cron-auth";
import { withCronRun } from "@/lib/infra/case-cron";
import { expireFosterProposalsAction as expireFosterProposals } from "@/src/modules/foster/actions";

export const dynamic = "force-dynamic";

const CRON_NAME = "expire_foster_proposals";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authError = authorizeCronRequest(req);
  if (authError) {
    return NextResponse.json({ ok: false, error: authError.error }, { status: authError.status });
  }

  const start = Date.now();
  try {
    const stats = await withCronRun(
      CRON_NAME,
      () => expireFosterProposals({ budgetHeaders: req.headers }),
      (s) => ({
        itemsProcessed: s.expired,
        // Per-row expiry failures must NOT report success (review 23 fleet
        // extension): flip the run to failed so it alerts and Vercel retries.
        failed: s.errors > 0,
        details: { candidates: s.candidates, expired: s.expired, errors: s.errors },
      }),
    );
    const failed = stats.errors > 0;
    return NextResponse.json(
      {
        ok: !failed,
        ...stats,
        durationMs: Date.now() - start,
      },
      { status: failed ? 500 : 200 },
    );
  } catch (err) {
    console.error("[cron/expire-foster-proposals] failed:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 },
    );
  }
}

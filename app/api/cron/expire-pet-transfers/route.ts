// Cron route — expire pet_transfers past their 7-day pending window.
//
// GET /api/cron/expire-pet-transfers
//
// Authentication: header `x-cron-secret` must match process.env.CRON_SECRET.
// Mirrors the other expiry cron routes (see expire-foster-proposals).

import { type NextRequest, NextResponse } from "next/server";

import { authorizeCronRequest } from "@/lib/domain/cron-auth";
import { withCronRun } from "@/lib/infra/case-cron";
import { expirePetTransfersAction as expirePetTransfersOnce } from "@/src/modules/transfers/actions";

export const dynamic = "force-dynamic";

const CRON_NAME = "expire_pet_transfers";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authError = authorizeCronRequest(req);
  if (authError) {
    return NextResponse.json({ ok: false, error: authError.error }, { status: authError.status });
  }

  const start = Date.now();
  try {
    const stats = await withCronRun(
      CRON_NAME,
      () => expirePetTransfersOnce({ budgetHeaders: req.headers }),
      (s) => ({
        itemsProcessed: s.expired,
        // Per-row failures must NOT report success (review 23 fleet extension):
        // flip the run to failed so it alerts and Vercel retries.
        failed: s.errors > 0,
        details: { expired: s.expired, errors: s.errors },
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
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

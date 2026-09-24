// Cron route — escalate custody_dispute cases open >365 days.

import { type NextRequest, NextResponse } from "next/server";

import {
  type StaleDisputeCandidate,
  escalateStaleDispute,
  findStaleDisputes,
} from "@/lib/case-closers/escalate-stale-disputes";
import { checkCronSecret, runCaseCron } from "@/lib/infra/case-cron";

export const dynamic = "force-dynamic";

const CRON_NAME = "escalate_stale_disputes";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authError = checkCronSecret(req);
  if (authError) {
    return NextResponse.json({ ok: false, error: authError.error }, { status: authError.status });
  }

  const result = await runCaseCron<StaleDisputeCandidate>({
    name: CRON_NAME,
    scan: (cursor) => findStaleDisputes({ afterId: cursor?.afterId, limit: cursor?.limit }),
    processOne: (candidate) => escalateStaleDispute(candidate),
    batchSize: 200,
    // RN #9 (2026-08-22): bound the keyset loop by min(own 45 s ceiling, the
    // share the daily dispatcher handed down) instead of the constant alone.
    budgetHeaders: req.headers,
  });

  return NextResponse.json(
    {
      status: result.status,
      itemsProcessed: result.itemsProcessed,
      runId: result.runId,
    },
    { status: result.status === "ok" ? 200 : 500 },
  );
}

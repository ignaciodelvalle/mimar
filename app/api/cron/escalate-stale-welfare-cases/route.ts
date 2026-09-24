// Cron route — escalate welfare_denuncia cases inactive >90 days.

import { type NextRequest, NextResponse } from "next/server";

import {
  type StaleWelfareCandidate,
  escalateStaleWelfareCase,
  findStaleWelfareCases,
} from "@/lib/case-closers/escalate-stale-welfare-cases";
import { checkCronSecret, runCaseCron } from "@/lib/infra/case-cron";

export const dynamic = "force-dynamic";

const CRON_NAME = "escalate_stale_welfare_cases";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authError = checkCronSecret(req);
  if (authError) {
    return NextResponse.json({ ok: false, error: authError.error }, { status: authError.status });
  }

  const result = await runCaseCron<StaleWelfareCandidate>({
    name: CRON_NAME,
    // Keyset-batched: bounds a nationwide stale-case scan to BATCH_SIZE rows
    // per page and drains the backlog across runs (review 23 item 13).
    scan: (cursor) => findStaleWelfareCases({ afterId: cursor?.afterId, limit: cursor?.limit }),
    processOne: (candidate) => escalateStaleWelfareCase(candidate),
    batchSize: 200,
    // RN #9 (2026-08-22): bound the keyset loop by min(own 45 s ceiling, the
    // share the daily dispatcher handed down) instead of the constant alone.
    budgetHeaders: req.headers,
  });

  // HTTP 500 on failure so Vercel treats the run as failed (does not swallow a
  // failed legal-escalation as success) — review 23 item 5.
  return NextResponse.json(
    {
      status: result.status,
      itemsProcessed: result.itemsProcessed,
      runId: result.runId,
    },
    { status: result.status === "ok" ? 200 : 500 },
  );
}

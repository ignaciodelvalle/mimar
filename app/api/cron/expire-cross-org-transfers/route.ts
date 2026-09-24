// Cron route — close custody_transfer_handshake cases open >30 days
// without a receiver response (spec 2026-05-19-cross-org-transfer-ux §12.5).

import { type NextRequest, NextResponse } from "next/server";

import { checkCronSecret, runCaseCron } from "@/lib/infra/case-cron";
import { TransfersRepository } from "@/src/modules/transfers/infrastructure/transfers-repository";

export const dynamic = "force-dynamic";

const CRON_NAME = "expire_cross_org_transfers";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authError = checkCronSecret(req);
  if (authError) {
    return NextResponse.json({ ok: false, error: authError.error }, { status: authError.status });
  }

  const result = await runCaseCron({
    name: CRON_NAME,
    scan: (cursor) =>
      TransfersRepository.findExpirableCrossOrgCases({
        afterId: cursor?.afterId,
        limit: cursor?.limit,
      }),
    processOne: (candidate) => TransfersRepository.expireOneCrossOrgCase(candidate),
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

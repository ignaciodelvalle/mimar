// Cron route — escalate custody_episode handoffs open >7 days without
// receiver acceptance (decomiso spec §13.5 + DC8).
//
// Dispatched once daily via /api/cron/daily (vercel.json "0 4 * * *" = 04:00
// UTC / 01:00 ART) — sub-daily scheduling is impossible on the Vercel Hobby
// plan, not a 12-hour choice per spec.
// Emits decomiso_handoff_stale notifications only — does NOT close the case.
// Idempotency handled by the helper (checks for a recent stale notification).

import { type NextRequest, NextResponse } from "next/server";

import {
  type StaleDecomisoCandidateFull,
  escalateStaleDecomiso,
  findStaleDecomisoCandidates,
} from "@/lib/case-closers/escalate-stale-decomiso-handoffs";
import { checkCronSecret, runCaseCron } from "@/lib/infra/case-cron";

export const dynamic = "force-dynamic";

// Canonical name: snake_case of the route directory (cron-registry SSOT rule,
// projection-cron audit 2026-07-03 B2) — was mismatched with the registry, so
// cron-health reported this cron never_ran while telemetry accrued elsewhere.
const CRON_NAME = "expire_decomiso_handoffs";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authError = checkCronSecret(req);
  if (authError) {
    return NextResponse.json({ ok: false, error: authError.error }, { status: authError.status });
  }

  // NOTE: no keyset `batchSize` here. findStaleDecomisoCandidates post-filters
  // in JS (latest-proposal age), so candidate.id is not a safe keyset cursor
  // over the raw scan. The finder instead caps its raw scan with `.limit()` to
  // bound memory; decomiso volume is low and the cron runs once daily (see the
  // route header above), not every 12h.
  const result = await runCaseCron<StaleDecomisoCandidateFull>({
    name: CRON_NAME,
    // RN #9 half b: bound by min(own 45 s default, the dispatcher's share) so
    // a late start cannot push the shared function past its 60 s hard kill.
    // runCaseCron honours this in its unbatched mode too since C04-1 — before
    // that it was read only by the keyset loop, and this route has none.
    budgetHeaders: req.headers,
    scan: () => findStaleDecomisoCandidates(),
    processOne: (candidate) => escalateStaleDecomiso(candidate),
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

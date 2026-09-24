// Vercel cron endpoint for the daily operator digest (T2-N1).
//
// Schedule: run in order by the single daily dispatcher (/api/cron/daily,
// vercel.json "0 4 * * *" — 04:00 UTC / 01:00 ART). See
// lib/infra/cron-dispatcher.ts. Vercel attaches
// `Authorization: Bearer ${CRON_SECRET}` to the dispatcher request; this
// route's own auth (authorizeCronRequest) accepts that Bearer header or the
// legacy `x-cron-secret` header, same as every other job in the fleet.
//
// BOUNDED BY THE CLOCK, AND BY THE RUN'S BUDGET (security review 2026-09-18).
// The first version was listed in cron-budget-ceiling's CEILING_EXEMPT as
// "bounded by rows" — true of the row COUNT, false of the time: per-recipient
// count queries, a full auth.users paging and sequential Resend calls, inside
// the dispatcher's shared 55 s with no clock. It now declares
// DIGEST_MAX_DURATION_MS (CRON_JOB_CEILINGS) and narrows it to the share the
// dispatcher hands down via effectiveDeadlineMs; runDailyOperatorDigest checks
// that deadline between recipients and stops before claiming another one.
// runDailyOperatorDigest still short-circuits entirely when the mail channel
// is not configured, so a misconfigured environment costs one cheap env check.

import { authorizeCronRequest } from "@/lib/domain/cron-auth";
import { withCronRun } from "@/lib/infra/case-cron";
import { effectiveDeadlineMs } from "@/lib/infra/cron-dispatcher";
import { DIGEST_MAX_DURATION_MS, runDailyOperatorDigest } from "@/lib/infra/daily-operator-digest";
import { type NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const CRON_NAME = "daily_operator_digest";

export async function GET(request: NextRequest) {
  const authError = authorizeCronRequest(request);
  if (authError) {
    return NextResponse.json({ error: authError.error }, { status: authError.status });
  }

  // RN #9: min(own ceiling, the share the dispatcher handed down).
  const budgetMs = effectiveDeadlineMs(DIGEST_MAX_DURATION_MS, request.headers);

  try {
    const result = await withCronRun(
      CRON_NAME,
      () => runDailyOperatorDigest({ budgetMs }),
      (r) => ({
        itemsProcessed: r.sent,
        // Genuine per-recipient errors flip the run to 'failed' (alerts +
        // 500), same convention as every other cron in the fleet — a
        // misconfigured mail channel is NOT an error (it is reported via
        // mailChannel and itemsProcessed=0), it is a deployment state.
        failed: r.errors > 0,
        details: { ...r },
      }),
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "error desconocido";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

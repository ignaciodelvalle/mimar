// Vercel cron endpoint for the vaccine_due notification scan.
//
// Schedule: run in order by the single daily dispatcher (/api/cron/daily,
// vercel.json "0 4 * * *" — 04:00 UTC / 01:00 ART). See
// lib/infra/cron-dispatcher.ts. Vercel attaches
// `Authorization: Bearer ${CRON_SECRET}` to the dispatcher request; this
// route's own auth (authorizeCronRequest) accepts that Bearer header or the
// legacy `x-cron-secret` header so the URL is not a public endpoint.
//
// On success we return JSON describing the run. On failure we return 500
// with the message so the Vercel cron dashboard surfaces it.

import { authorizeCronRequest } from "@/lib/domain/cron-auth";
import { withCronRun } from "@/lib/infra/case-cron";
import { CRON_JOB_CEILINGS, effectiveDeadlineMs } from "@/lib/infra/cron-dispatcher";
import { runVaccineDueScan } from "@/lib/infra/notifications";
import { type NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const CRON_NAME = "vaccine_due";

export async function GET(request: NextRequest) {
  const authError = authorizeCronRequest(request);
  if (authError) {
    return NextResponse.json({ error: authError.error }, { status: authError.status });
  }

  try {
    // cronRuns telemetry — projection-cron audit 2026-07-03 B1
    const result = await withCronRun(
      CRON_NAME,
      // RN #9 (2026-08-22): the sweep bounds itself by min(own 45 s ceiling,
      // the share the daily dispatcher handed down) instead of the constant.
      () =>
        runVaccineDueScan(undefined, {
          maxDurationMs: effectiveDeadlineMs(
            CRON_JOB_CEILINGS.vaccine_due.ceilingMs,
            request.headers,
          ),
        }),
      (r) => ({
        itemsProcessed: r.insertedCount,
        details: { insertedCount: r.insertedCount },
      }),
    );
    return NextResponse.json({
      ok: true,
      scanned_at: result.scannedAt.toISOString(),
      inserted_count: result.insertedCount,
      inserted_notification_ids: result.insertedNotificationIds,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "error desconocido";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

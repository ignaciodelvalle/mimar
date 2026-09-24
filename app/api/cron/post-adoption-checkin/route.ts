// Vercel cron endpoint for the post_adoption_checkin notification scan.
//
// Schedule: once a day at 12:00 UTC (09:00 ART). Configured in vercel.json.
// Two phases per call: (1) proactive reminders to adopters whose check-in
// window is approaching; (2) missed-window fanout to refugio admins when
// the adopter ghosts past dueAt + grace.
//
// Vercel attaches `Authorization: Bearer ${CRON_SECRET}` to the request when
// CRON_SECRET is set in the project env; we reject anything else so the URL
// is not a public endpoint.

import { authorizeCronRequest } from "@/lib/domain/cron-auth";
import { withCronRun } from "@/lib/infra/case-cron";
import { CRON_JOB_CEILINGS, effectiveDeadlineMs } from "@/lib/infra/cron-dispatcher";
import { runPostAdoptionCheckinScan } from "@/lib/infra/notifications";
import { type NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const CRON_NAME = "post_adoption_checkin";

export async function GET(request: NextRequest) {
  const authError = authorizeCronRequest(request);
  if (authError) {
    return NextResponse.json({ error: authError.error }, { status: authError.status });
  }

  try {
    const result = await withCronRun(
      CRON_NAME,
      // RN #9 (2026-08-22): the sweep bounds itself by min(own 45 s ceiling,
      // the share the daily dispatcher handed down) instead of the constant.
      () =>
        runPostAdoptionCheckinScan(undefined, {
          maxDurationMs: effectiveDeadlineMs(
            CRON_JOB_CEILINGS.post_adoption_checkin.ceilingMs,
            request.headers,
          ),
        }),
      (r) => ({
        itemsProcessed: r.proactiveInsertedIds.length + r.missedInsertedIds.length,
        details: {
          proactiveInsertedCount: r.proactiveInsertedIds.length,
          missedInsertedCount: r.missedInsertedIds.length,
        },
      }),
    );
    return NextResponse.json({
      ok: true,
      scanned_at: result.scannedAt.toISOString(),
      proactive_inserted_count: result.proactiveInsertedIds.length,
      missed_inserted_count: result.missedInsertedIds.length,
      proactive_inserted_ids: result.proactiveInsertedIds,
      missed_inserted_ids: result.missedInsertedIds,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "error desconocido";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

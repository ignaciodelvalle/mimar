// Cron route — purge expired credential_scanned events (Wave 5 Item 28).
//
// GET /api/cron/purge-scan-events
//
// Authentication: header `Authorization: Bearer <CRON_SECRET>` (Vercel Cron
// contract) or legacy `x-cron-secret: <CRON_SECRET>` — see lib/cron-auth.ts.
//
// Deletes credential_scanned events authored by 'scanner' that are older than
// SCAN_RETENTION_DAYS (90 days).  Runs daily (Hobby plan: only daily schedules
// are supported — see vercel.json).
//
// PRIVACY CONTRACT (Item 28):
//   - Scanner events (author_role='scanner') have a 90-day TTL.
//   - The payload never stores IP or geolocation (audited in app/actions/scans.ts).
//
// Returns: { ok: true, scanEventsDeleted, durationMs, runId }

import { type NextRequest, NextResponse } from "next/server";

import { eq } from "drizzle-orm";

import { cronRuns, db } from "@/db";
import { authorizeCronRequest } from "@/lib/domain/cron-auth";
import { sendCronAlert } from "@/lib/infra/cron-alert";
import { CRON_JOB_CEILINGS, effectiveDeadlineMs } from "@/lib/infra/cron-dispatcher";
import { purgeExpiredScanEvents } from "@/lib/infra/scan-retention";

export const dynamic = "force-dynamic";

const CRON_NAME = "purge_scan_events";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authError = authorizeCronRequest(req);
  if (authError) {
    return NextResponse.json({ ok: false, error: authError.error }, { status: authError.status });
  }

  const start = Date.now();

  const [run] = await db
    .insert(cronRuns)
    .values({ cronName: CRON_NAME, status: "running" })
    .returning();

  let status: "ok" | "failed" = "ok";
  let scanEventsDeleted = 0;
  const errors: { section: string; reason: string }[] = [];

  try {
    // RN #9 (2026-08-22): this is job 22 of 23, immediately before the Ley
    // 25.326 retention purge. Its own 45 s ceiling inside a 55 s shared
    // budget is exactly the shape that used to take the function past its
    // 60 s hard kill and strand every job behind it.
    scanEventsDeleted = await purgeExpiredScanEvents({
      maxDurationMs: effectiveDeadlineMs(
        CRON_JOB_CEILINGS.purge_scan_events.ceilingMs,
        req.headers,
      ),
    });
  } catch (err) {
    status = "failed";
    errors.push({
      section: "purgeExpiredScanEvents",
      reason: err instanceof Error ? err.message : String(err),
    });
    console.error("[cron/purge-scan-events] Error:", err);
  }

  const durationMs = Date.now() - start;

  await db
    .update(cronRuns)
    .set({
      status,
      finishedAt: new Date(),
      itemsProcessed: scanEventsDeleted,
      details: errors.length > 0 ? { scanEventsDeleted, errors } : { scanEventsDeleted },
    })
    .where(eq(cronRuns.id, run.id));

  // A failed purge must return HTTP 500 so Vercel's cron dashboard flags it and
  // retries — previously the route returned 200 with ok:false, which reads as a
  // successful run to Vercel (review 23 fleet extension).
  if (status === "failed") {
    await sendCronAlert({
      job: CRON_NAME,
      severity: "critical",
      error: errors[0]?.reason ?? "scan-event purge failed",
      details: { scanEventsDeleted, errors },
    });
  }

  return NextResponse.json(
    {
      ok: status === "ok",
      scanEventsDeleted,
      durationMs,
      runId: run.id,
    },
    { status: status === "ok" ? 200 : 500 },
  );
}

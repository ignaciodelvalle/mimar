// Cron route — drain the notification_dead_letter table.
//
// The createNotification() service (lib/infra/notification-service.ts) writes a
// payload to `notification_dead_letter` whenever a notifications insert throws
// (pool exhaustion, deploy-time connection drop, brief outage) — turning
// "silently gone" into "delayed but recoverable" (migration 0124, consistency
// review 2026-07-04 C.1). That migration promised a follow-on retry cron to
// drain unresolved rows; it was never built until now. THIS is that drainer.
//
// GET /api/cron/drain-notification-dead-letter
// Auth: Vercel Cron `Authorization: Bearer <CRON_SECRET>` (or legacy
//   `x-cron-secret`), via authorizeCronRequest.
// Schedule: daily, dispatched via /api/cron/daily (lib/infra/cron-registry.ts's
//   `runsVia: "daily"` for drain_notification_dead_letter) — the real window is
//   24h, not the hourly this header used to claim.
//
// Behaviour (idempotent, bounded):
//   - Scan at most BATCH_SIZE unresolved rows (resolved_at IS NULL), oldest first.
//   - Replay each row's payload through createNotification(), which re-applies the
//     ON CONFLICT (dedupe_key) DO NOTHING idempotency guard. A payload whose
//     original insert failed transiently now lands (status "inserted") or is
//     already present (status "duplicate") — either way it is delivered, so we
//     stamp resolved_at.
//   - A payload that STILL fails re-dead-letters through the service (a fresh
//     row is written capturing the continued failure). We stamp resolved_at on
//     the ORIGINAL too so the successor row supersedes it — this keeps the
//     unresolved working set bounded at O(1) rows per persistently-failing key
//     instead of doubling every run. `stillFailing` in the response surfaces the
//     count so a genuinely undeliverable payload (e.g. a deleted recipient) is
//     visible in telemetry.
//   - A row whose recipient's profile carries `deleted_at` is NOT replayed
//     (A06-G2): the subject exercised Ley 25.326 art. 16, and `erase_subject_data`
//     redacts their dead letters in its own transaction since 0226. This check
//     is the belt-and-braces for a row that landed after the erasure ran.
//   - The check and the replay are serialized against a concurrent erasure
//     (LOW-1). Each row is replayed inside a transaction that first takes the
//     recipient's profile row FOR SHARE and then the dead-letter row FOR UPDATE
//     — the same order erase_subject_data touches them (its first statement
//     updates profiles, a later one the dead letters), so the two can never
//     deadlock. An erasure that got there first makes us wait and then read
//     `deleted_at`; one that comes second waits for our commit, and by then the
//     replayed notification is committed and its own scrub sees it. A row that
//     a concurrent run already resolved (or the erasure redacted) is skipped.
//     The push leg is NOT held under this lock (LOW-A, 2026-09): it has no
//     timeout, so a stalled push would otherwise block a waiting erasure past
//     PostgREST's statement_timeout. The replay commits the in-app row with
//     `suppressPush: true` and sends the push only after commit, when the
//     lock is already released — a push racing a same-tick erasure finds no
//     push_subscriptions row left, since the erasure's own scrub already ran.
//   - EVERY resolve redacts the payload to `{}` (A06-G1). The payload is the
//     full notification — title, body, a finder's phone — and once the row is
//     resolved it is a second copy with no purpose. error_message goes too
//     (HIGH-1, migration 0228): rows written before the write side was
//     sanitised hold drizzle's `Failed query … params: …`, i.e. the same
//     notification again, so 0226's "error_message stays" was wrong. dedupe_key
//     and the timestamps stay: they record that a delivery failed and when.
//
// Returns: { ok, scanned, resolved, stillFailing, invalid, skippedErased, skippedConcurrent, runId } and HTTP 500
//   when the run failed (so Vercel's cron dashboard flags it — a cron must not
//   report success on failure).

import { type NextRequest, NextResponse } from "next/server";

import { eq, isNull } from "drizzle-orm";

import { cronRuns, db, notificationDeadLetter } from "@/db";
import { authorizeCronRequest } from "@/lib/domain/cron-auth";
import { sendCronAlert } from "@/lib/infra/cron-alert";
import {
  replayLocked,
  resolveAndRedact,
  toInput,
} from "@/lib/infra/notification-dead-letter-replay";

export const dynamic = "force-dynamic";

// Bounded batch per invocation — keeps worst-case work predictable and well
// inside the function's maxDuration:60 budget (vercel.json).
const BATCH_SIZE = 200;
// Canonical name: snake_case of the route directory (cron-registry SSOT rule).
const CRON_NAME = "drain_notification_dead_letter";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authError = authorizeCronRequest(req);
  if (authError) {
    return NextResponse.json({ ok: false, error: authError.error }, { status: authError.status });
  }

  const [run] = await db
    .insert(cronRuns)
    .values({ cronName: CRON_NAME, status: "running" })
    .returning();

  let scanned = 0;
  let resolved = 0;
  let stillFailing = 0;
  let invalid = 0;
  let skippedErased = 0;
  let skippedConcurrent = 0;
  let cronStatus: "ok" | "failed" = "ok";
  const errors: { id: string; reason: string }[] = [];

  try {
    const rows = await db
      .select({
        id: notificationDeadLetter.id,
        payload: notificationDeadLetter.payload,
      })
      .from(notificationDeadLetter)
      .where(isNull(notificationDeadLetter.resolvedAt))
      .orderBy(notificationDeadLetter.createdAt)
      .limit(BATCH_SIZE);

    for (const row of rows) {
      scanned += 1;
      const now = new Date();

      const input = toInput(row.payload);
      if (!input) {
        // Unreplayable payload (malformed / missing required fields). Resolve it
        // so it stops blocking the scan; surface it as an error for triage.
        invalid += 1;
        errors.push({ id: row.id, reason: "unreplayable_payload" });
        await resolveAndRedact(db, row.id, now);
        continue;
      }

      const outcome = await replayLocked(row.id, input, now);

      if (outcome === "gone") {
        skippedConcurrent += 1;
      } else if (outcome === "erased") {
        skippedErased += 1;
      } else if (outcome === "inserted" || outcome === "duplicate") {
        resolved += 1;
      } else {
        // Re-dead-lettered: a fresh row now tracks the continued failure. The
        // original was resolved so the working set stays bounded (see header).
        stillFailing += 1;
        errors.push({ id: row.id, reason: "redelivery_failed" });
      }
    }
  } catch (err) {
    cronStatus = "failed";
    errors.push({ id: "global", reason: err instanceof Error ? err.message : "unknown" });
  }

  if (stillFailing > 0) {
    console.error(
      `[cron/drain-notification-dead-letter] ${stillFailing} payload(s) still failing redelivery`,
    );
  }

  // A run that left payloads still failing redelivery OR could not replay
  // (invalid) is NOT healthy: any accumulated error flips the run to failed so
  // it returns HTTP 500 (Vercel retries) and pages a human — a cron must not
  // report success on failure (review 23 fleet extension).
  if (cronStatus === "ok" && errors.length > 0) {
    cronStatus = "failed";
  }

  await db
    .update(cronRuns)
    .set({
      status: cronStatus,
      finishedAt: new Date(),
      itemsProcessed: resolved,
      details:
        errors.length > 0
          ? { scanned, resolved, stillFailing, invalid, skippedErased, skippedConcurrent, errors }
          : {
              scanned,
              resolved,
              stillFailing,
              invalid,
              skippedErased,
              skippedConcurrent,
            },
    })
    .where(eq(cronRuns.id, run.id));

  if (cronStatus === "failed") {
    await sendCronAlert({
      job: CRON_NAME,
      severity: "critical",
      error: `${stillFailing} still failing, ${invalid} invalid — see cron_runs.details`,
      details: { scanned, resolved, stillFailing, invalid, errors: errors.slice(0, 20) },
    });
  }

  return NextResponse.json(
    {
      ok: cronStatus === "ok",
      scanned,
      resolved,
      stillFailing,
      invalid,
      skippedErased,
      skippedConcurrent,
      runId: run.id,
    },
    { status: cronStatus === "ok" ? 200 : 500 },
  );
}

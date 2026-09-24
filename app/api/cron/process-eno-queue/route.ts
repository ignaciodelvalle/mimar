// Vercel cron endpoint for the ENO queue drain (handoff P4-6).
//
// Schedule: hourly. Configured in vercel.json. Vercel attaches
// `Authorization: Bearer ${CRON_SECRET}` to the request when
// CRON_SECRET is set in the project env; we reject anything else so
// the URL is not a public endpoint.
//
// On success returns JSON describing the run. On failure returns 500.
//
// Overlap safety: concurrent runs are safe because pickPendingBatch uses an
// atomic UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING *
// to claim rows, transitioning them to status='processing'. Two concurrent runs
// always claim disjoint sets. No session-level advisory lock is used — those
// are pooler-unsafe on pgBouncer transaction-mode connections (lock and unlock
// can land on different backend connections, silently voiding mutual exclusion).
// Idempotency at the notification layer (ON CONFLICT DO NOTHING on the partial
// unique index notifications_event_natural_key_unique, migration 0088) ensures
// that even if overlap did occur, no duplicate legal notifications would be sent.

import { authorizeCronRequest } from "@/lib/domain/cron-auth";
import { withCronRun } from "@/lib/infra/case-cron";
import { effectiveDeadlineMs } from "@/lib/infra/cron-dispatcher";
import { processEnoQueueBatch } from "@/lib/infra/eno-queue-processor";
import { type NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const CRON_NAME = "process_eno_queue";

// Wall-clock budget for the drain loop (ms). Vercel functions time out at 60s;
// 45s leaves margin to finalize the cron_runs row.
const MAX_DURATION_MS = 45_000;
// Hard cap on drain iterations (each ~BATCH_SIZE=50 rows) so a pathological
// re-pick of retryable-failed rows can't spin unboundedly within one run.
const MAX_ITERATIONS = 20;

export async function GET(request: NextRequest) {
  const authError = authorizeCronRequest(request);
  if (authError) {
    return NextResponse.json({ error: authError.error }, { status: authError.status });
  }

  const start = Date.now();
  // RN #9 (2026-08-22): min(our own ceiling, the share the dispatcher handed
  // down). The constant alone is blind to how much of the fleet's 55 s is
  // already spent; the header is not. Standalone it is the constant, unchanged.
  const budgetMs = effectiveDeadlineMs(MAX_DURATION_MS, request.headers);

  try {
    // Resume loop (review 23 item 8): the queue is a legal-notification backlog
    // and a single BATCH_SIZE=50 pass once/day let it grow. Now hourly, we also
    // drain repeatedly WITHIN the run until the queue is empty or the budget is
    // exhausted. pickPendingBatch claims disjoint sets (FOR UPDATE SKIP LOCKED),
    // so successive passes are safe.
    const result = await withCronRun(
      CRON_NAME,
      async () => {
        let processed = 0;
        let failed = 0;
        let skipped = 0;
        let scannedAt = new Date();
        let iterations = 0;

        for (;;) {
          if (iterations >= MAX_ITERATIONS || Date.now() - start >= budgetMs) break;
          const batch = await processEnoQueueBatch();
          scannedAt = batch.scannedAt;
          processed += batch.processed;
          failed += batch.failed;
          skipped += batch.skipped;
          iterations += 1;
          // Nothing left to do this pass → queue drained (or only recently-failed
          // rows remain, which the next scheduled run retries).
          if (batch.processed + batch.failed + batch.skipped === 0) break;
        }

        return { scannedAt, processed, failed, skipped };
      },
      (r) => ({
        itemsProcessed: r.processed,
        // ENO fanout rows marked failed in the queue must surface as a failed
        // run (review 23 item 3) — else Vercel treats the backlog as healthy.
        failed: r.failed > 0,
        details: { processed: r.processed, failed: r.failed, skipped: r.skipped },
      }),
    );
    const failed = result.failed > 0;
    return NextResponse.json(
      {
        ok: !failed,
        scanned_at: result.scannedAt.toISOString(),
        processed: result.processed,
        failed: result.failed,
        skipped: result.skipped,
      },
      { status: failed ? 500 : 200 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

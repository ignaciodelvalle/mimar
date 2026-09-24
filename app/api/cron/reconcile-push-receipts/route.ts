// Cron route — ask Expo what actually happened to the pushes it accepted.
//
// GET /api/cron/reconcile-push-receipts
//
// Authentication: header `Authorization: Bearer <CRON_SECRET>` (Vercel Cron
// contract) or legacy `x-cron-secret: <CRON_SECRET>` — see lib/domain/cron-auth.
//
// WHY A NIGHTLY JOB AND NOT PART OF THE SEND
// ---------------------------------------------------------------------------
// Expo answers a send twice. The TICKET is synchronous and says only whether
// Expo accepted the message; the RECEIPT, fetched afterwards by the id that
// ticket carried, says what FCM and APNs did with it — and that is where
// `DeviceNotRegistered` arrives in the ordinary case, because Expo has not
// spoken to either store when it writes the ticket.
//
// The send path cannot wait for it: it runs inside `createNotification`, on a
// request somebody is waiting on, and the receipt is not ready for minutes.
// Without a second pass the one signal that says a delivery address is dead was
// mostly never read, so `push_targets` accumulated rows for uninstalled apps
// forever and every notification for that person paid to address a phone that no
// longer exists.
//
// WHY IT LIVES IN THE DAILY FAN-IN. Nothing a person sees depends on when a dead
// token is noticed — only the cost of addressing it does — so this is the
// definition of work that belongs on the existing nightly schedule. It is also
// the only option: Vercel's plan allows two scheduled cron entries in total and
// both are spent (the dispatcher and refresh-cube), which is why every job in
// this directory is a child of /api/cron/daily rather than a schedule of its own.
//
// WHERE IT SITS IN THE ORDER. With the delivery drains, before the retention
// purges — it is the second half of a SEND, and what it produces (a revoked dead
// target) is what `data_lifecycle`'s purge collects thirty days later. Running
// it after the purge would still work; running it with its own kind is what a
// reader expects.
//
// NO CEILING DECLARED, and therefore none claimed. `CRON_JOB_CEILINGS` is a
// census of jobs that bound their own wall clock, and the parity fence
// (__tests__/cron-budget-ceiling.test.ts) refuses a claim the code does not
// back. This job does not loop over a keyset: it reads at most
// RECEIPT_BATCH_SIZE rows once, batches them into a handful of HTTP requests,
// and returns. A backlog beyond one batch is drained by the next night, which is
// the same posture every purge in `data-lifecycle.ts` takes.
//
// THE TELEMETRY GOES THROUGH `withCronRun`, not through a hand-rolled pair of
// writes. Canon B02: a route under app/ does not write to the database — writes
// travel through a use case — and the boundary fence says in as many words that
// adding a file to its baseline is not the fix. `withCronRun` is the shared
// wrapper ten crons in this directory already use; the two rows it writes are
// its business, not this route's.
//
// It also corrects the severity this route used to send by hand. A `warning` was
// argued here on the grounds that a bad night at Expo degrades nothing a person
// can see — but a bad night at Expo never reaches this catch:
// `reconcileExpoPushReceipts` swallows its own per-chunk failures and no-ops
// without `EXPO_ACCESS_TOKEN`. What reaches it is structural (the database is
// gone), and structural is `critical`, which is what the wrapper sends.
//
// Returns: { ok, checked, revoked, expired, durationMs, runId }

import { type NextRequest, NextResponse } from "next/server";

import { authorizeCronRequest } from "@/lib/domain/cron-auth";
import { withCronRun } from "@/lib/infra/case-cron";
import { reconcileExpoPushReceipts } from "@/lib/infra/expo-push";

export const dynamic = "force-dynamic";

const CRON_NAME = "reconcile_push_receipts";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authError = authorizeCronRequest(req);
  if (authError) {
    return NextResponse.json({ ok: false, error: authError.error }, { status: authError.status });
  }

  const start = Date.now();
  // Captured from inside the wrapper so the response can name the row a reader
  // would go look at. It stays empty only if the insert itself failed, in which
  // case there is no row to name.
  let runId = "";

  try {
    const outcome = await withCronRun(
      CRON_NAME,
      async (id) => {
        runId = id;
        return await reconcileExpoPushReceipts();
      },
      (result) => ({
        // The receipts actually answered for. Revocations are the outcome worth
        // reading, but the count of rows LOOKED AT is what says whether this job
        // is doing anything at all — a fleet with push enabled and a permanent
        // zero here means tickets are not recording their ids.
        itemsProcessed: result.checked,
        details: { ...result },
      }),
    );

    return NextResponse.json(
      {
        ok: true,
        checked: outcome.checked,
        revoked: outcome.revoked,
        expired: outcome.expired,
        durationMs: Date.now() - start,
        runId,
      },
      { status: 200 },
    );
  } catch (err) {
    // `withCronRun` has already finalized the row as failed and alerted; this
    // arm only shapes the response. A failed run answers 500 so Vercel's cron
    // dashboard flags it, the same rule every sibling in this directory follows:
    // a 200 with `ok: false` reads as a successful run to Vercel.
    console.error("[cron/reconcile-push-receipts] Error:", err);
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        runId,
      },
      { status: 500 },
    );
  }
}

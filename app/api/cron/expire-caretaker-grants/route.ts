// Cron route — the daily caretaker sweep (custodia-temporal).
//
// GET /api/cron/expire-caretaker-grants
//
// Three passes, in the order the use-case documents: expire unanswered
// invitations, end arrangements past `ends_at`, then send the T-3 nudge.
// Pass 2 BEFORE pass 3, or a grant closing today is asked to renew a window
// that shuts minutes later.
//
// Authentication: `Authorization: Bearer <CRON_SECRET>` or the legacy
// `x-cron-secret` header, via authorizeCronRequest — the same gate as every
// other job route. NOT a new vercel.json entry: all four sibling expiry jobs
// ride the daily dispatcher, and deviating would give this one different
// observability for no reason.

import { type NextRequest, NextResponse } from "next/server";

import { authorizeCronRequest } from "@/lib/domain/cron-auth";
import { withCronRun } from "@/lib/infra/case-cron";
import { expireCaretakerGrantsAction } from "@/src/modules/caretakers/actions";

export const dynamic = "force-dynamic";

const CRON_NAME = "expire_caretaker_grants";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authError = authorizeCronRequest(req);
  if (authError) {
    return NextResponse.json({ ok: false, error: authError.error }, { status: authError.status });
  }

  const start = Date.now();
  try {
    const stats = await withCronRun(
      CRON_NAME,
      () => expireCaretakerGrantsAction({ budgetHeaders: req.headers }),
      (s) => ({
        // "Items processed" is the union of what the three passes actually
        // changed. Counting only one pass would let a run that ended twenty
        // arrangements report zero because nobody's invitation expired.
        itemsProcessed: s.invitationsExpired + s.grantsEnded + s.remindersSent,
        // Per-row failures must not report success: flip the run to failed so
        // it alerts and Vercel retries (review 23 fleet extension).
        failed: s.errors > 0,
        details: {
          invitationsExpired: s.invitationsExpired,
          grantsEnded: s.grantsEnded,
          remindersSent: s.remindersSent,
          errors: s.errors,
        },
      }),
    );
    const failed = stats.errors > 0;
    return NextResponse.json(
      { ok: !failed, ...stats, durationMs: Date.now() - start },
      { status: failed ? 500 : 200 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

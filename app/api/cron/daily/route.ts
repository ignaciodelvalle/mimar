// Daily cron dispatcher — the SINGLE Vercel cron that runs the whole fleet.
//
// GET /api/cron/daily
// Schedule: 0 4 * * * (once a day, 01:00 ART). Configured in vercel.json.
// Auth: `Authorization: Bearer <CRON_SECRET>` (Vercel Cron contract) or the
//   legacy `x-cron-secret` header — same gate as every individual job route.
//
// WHY (Vercel Hobby cron limits, 2026-07-07): vercel.json declared 22 separate
// cron jobs. Vercel Hobby allows only 2 cron jobs and only DAILY schedules, so
// the deploy failed ("Hobby accounts are limited to daily cron jobs"). This
// dispatcher folds the whole fleet into one daily invocation: it authorizes the
// request once, then calls every job's EXISTING route handler in order with a
// forged, authorized request. No individual route changed — each still writes
// its own cron_runs telemetry and stays independently callable for manual ops.
//
// Failure isolation: each job runs in its own try/catch (via dispatchJobs), so
// one failing job never aborts the rest. Per-job outcomes are recorded on this
// dispatcher's own `cron_daily` cron_runs row for observability. cron_health
// still monitors every individual job by name (its own telemetry row), so a
// single job failing surfaces there with per-job granularity.
//
// Budget: the run is capped at BUDGET_MS so it stays inside the function's
// maxDuration (60s, vercel.json). Jobs skipped by the budget run on the next
// daily invocation — every job is idempotent and/or keyset-resumable.

import { NextRequest, NextResponse } from "next/server";

import { eq } from "drizzle-orm";

import { cronRuns, db } from "@/db";
import { authorizeCronRequest } from "@/lib/domain/cron-auth";
import { withCronRun } from "@/lib/infra/case-cron";
import { sendCronAlert } from "@/lib/infra/cron-alert";
import {
  CRON_BUDGET_HEADER,
  DAILY_JOB_ORDER,
  type DispatchContext,
  type DispatchJob,
  dispatchJobs,
  fairShareMs,
  reservedCeilingMs,
} from "@/lib/infra/cron-dispatcher";

// Individual job route handlers. Importing a route's GET is a plain ESM import —
// each file remains its own route; we just reuse its exported handler so the
// dispatcher calls it directly (no HTTP round-trip).
import { GET as autoExpireApprovals } from "../auto-expire-approvals/route";
import { GET as businessRulesReeval } from "../business-rules-reeval/route";
import { GET as closeFollowupExpiredAdoptions } from "../close-followup-expired-adoptions/route";
import { GET as closeRabiesObservations } from "../close-rabies-observations/route";
import { GET as closeStaleLostEpisodes } from "../close-stale-lost-episodes/route";
import { GET as cronHealth } from "../cron-health/route";
import { GET as dailyOperatorDigest } from "../daily-operator-digest/route";
import { GET as dataLifecycle } from "../data-lifecycle/route";
import { GET as drainNotificationDeadLetter } from "../drain-notification-dead-letter/route";
import { GET as drainOutbox } from "../drain-outbox/route";
import { GET as escalateStaleDisputes } from "../escalate-stale-disputes/route";
import { GET as escalateStaleWelfareCases } from "../escalate-stale-welfare-cases/route";
import { GET as evaluateAlerts } from "../evaluate-alerts/route";
import { GET as expireCaretakerGrants } from "../expire-caretaker-grants/route";
import { GET as expireCrossOrgTransfers } from "../expire-cross-org-transfers/route";
import { GET as expireDecomisoHandoffs } from "../expire-decomiso-handoffs/route";
import { GET as expireFosterProposals } from "../expire-foster-proposals/route";
import { GET as expirePetTransfers } from "../expire-pet-transfers/route";
import { GET as materializeSlots } from "../materialize-slots/route";
import { GET as postAdoptionCheckin } from "../post-adoption-checkin/route";
import { GET as processEnoQueue } from "../process-eno-queue/route";
import { GET as purgeScanEvents } from "../purge-scan-events/route";
import { GET as reconcilePetStatus } from "../reconcile-pet-status/route";
import { GET as reconcilePushReceipts } from "../reconcile-push-receipts/route";
import { GET as vaccineDue } from "../vaccine-due/route";

export const dynamic = "force-dynamic";

const CRON_NAME = "cron_daily";

// Wall-clock budget for the whole fan-out. Vercel functions time out at 60s
// (vercel.json maxDuration); 55s leaves margin to finalize the cron_daily row.
const BUDGET_MS = 55_000;

// name → route handler. Every DAILY_JOB_ORDER name MUST resolve here; the guard
// below throws at module load if the map drifts from the order list.
//
// THIS MAP IS NOT THE EXECUTION ORDER. Jobs run in DAILY_JOB_ORDER
// (lib/infra/cron-dispatcher.ts), where the delivery drains sit BEFORE the
// retention purges — a test pins it. Reading the order off this object is how
// the 2026-08 review concluded the drains ran after data_lifecycle.
const HANDLERS: Record<string, (req: NextRequest) => Promise<Response>> = {
  materialize_slots: materializeSlots,
  business_rules_reeval: businessRulesReeval,
  reconcile_pet_status: reconcilePetStatus,
  reconcile_push_receipts: reconcilePushReceipts,
  vaccine_due: vaccineDue,
  post_adoption_checkin: postAdoptionCheckin,
  evaluate_alerts: evaluateAlerts,
  daily_operator_digest: dailyOperatorDigest,
  auto_expire_approvals: autoExpireApprovals,
  expire_caretaker_grants: expireCaretakerGrants,
  expire_foster_proposals: expireFosterProposals,
  expire_pet_transfers: expirePetTransfers,
  expire_cross_org_transfers: expireCrossOrgTransfers,
  expire_decomiso_handoffs: expireDecomisoHandoffs,
  close_rabies_observations: closeRabiesObservations,
  close_stale_lost_episodes: closeStaleLostEpisodes,
  close_followup_expired_adoptions: closeFollowupExpiredAdoptions,
  escalate_stale_welfare_cases: escalateStaleWelfareCases,
  escalate_stale_disputes: escalateStaleDisputes,
  process_eno_queue: processEnoQueue,
  purge_scan_events: purgeScanEvents,
  data_lifecycle: dataLifecycle,
  drain_outbox: drainOutbox,
  drain_notification_dead_letter: drainNotificationDeadLetter,
  cron_health: cronHealth,
};

// Fail fast on drift: every ordered job name must have a handler.
for (const name of DAILY_JOB_ORDER) {
  if (!HANDLERS[name]) {
    throw new Error(`[cron/daily] no handler wired for job "${name}" — update HANDLERS`);
  }
}

/**
 * Build a forged, authorized request for the child handlers by forwarding the
 * dispatcher's own auth headers (Vercel signed them with CRON_SECRET, and each
 * child re-validates via authorizeCronRequest). In non-production with no
 * CRON_SECRET, no headers are forwarded and the children's dev-fallback allows
 * the request — same as a direct Vercel invocation.
 *
 * `budgetMs` is the job's FAIR SHARE of what is left of BUDGET_MS —
 * `fairShareMs(budget left, jobs left, BUDGET_MS)`, i.e. the remainder split
 * evenly across the jobs still to run, so the LAST job (data_lifecycle) gets
 * everything that remains and nothing more. A child that reads the header
 * derives its deadline from the run instead of from its own constant; one
 * that does not keeps its ceiling (RN-3 F17).
 */
function makeChildRequest(req: NextRequest, budgetMs: number): NextRequest {
  const headers = new Headers();
  const auth = req.headers.get("authorization");
  if (auth) headers.set("authorization", auth);
  const legacy = req.headers.get("x-cron-secret");
  if (legacy) headers.set("x-cron-secret", legacy);
  if (Number.isFinite(budgetMs)) headers.set(CRON_BUDGET_HEADER, String(budgetMs));
  return new NextRequest(req.url, { headers });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authError = authorizeCronRequest(request);
  if (authError) {
    return NextResponse.json({ ok: false, error: authError.error }, { status: authError.status });
  }

  const jobs: DispatchJob[] = DAILY_JOB_ORDER.map((name) => ({
    name,
    // RN #9: what this job burns even if it ignores the header we are about to
    // hand it. 0 for every job whose route derives its deadline from the
    // budget — the parity fence proves the claim, so this is not a promise the
    // dispatcher makes on the routes' behalf.
    ceilingMs: reservedCeilingMs(name),
    run: (ctx: DispatchContext) =>
      HANDLERS[name](
        makeChildRequest(request, fairShareMs(ctx.budgetLeftMs, ctx.jobsLeft, BUDGET_MS)),
      ),
  }));

  const start = Date.now();
  const result = await withCronRun(
    CRON_NAME,
    // C-b: persist partial progress after EACH job — a hard kill at
    // maxDuration used to lose every outcome computed so far (the row stayed
    // at 'running' with empty details). status stays 'running' on purpose:
    // a killed run must keep signaling it never finished.
    (runId) =>
      dispatchJobs(jobs, {
        budgetMs: BUDGET_MS,
        onOutcome: async (_outcome, soFar) => {
          await db
            .update(cronRuns)
            .set({ details: { partial: true, outcomes: [...soFar] } })
            .where(eq(cronRuns.id, runId));
        },
      }),
    (r) => ({
      itemsProcessed: r.ran,
      // A failing job flips cron_daily to failed so it alerts + returns 500.
      // Budget skips are NOT failures (the job simply runs next invocation).
      failed: r.failed > 0,
      details: {
        ran: r.ran,
        failed: r.failed,
        skipped: r.skipped,
        outcomes: r.outcomes,
      },
    }),
  );

  if (result.skipped > 0) {
    const skippedNames = result.outcomes
      .filter((o) => o.status === "skipped_budget")
      .map((o) => o.name)
      .join(", ");
    console.warn(
      `[cron/daily] ${result.skipped} job(s) skipped by the ${BUDGET_MS}ms budget — they run on the next daily invocation: ${skippedNames}`,
    );
    // S8: a console.warn alone is invisible outside the function logs — page a
    // human too (same posture as cron-health's unhealthy-fleet alert). Best-
    // effort/no-op when CRON_ALERT_WEBHOOK is unset (sendCronAlert never throws).
    await sendCronAlert({
      job: CRON_NAME,
      severity: "warning",
      error: `${result.skipped} job(s) skipped by the ${BUDGET_MS}ms budget`,
      details: { skippedNames: skippedNames.split(", ").filter(Boolean) },
    });
  }

  const ok = result.failed === 0;
  return NextResponse.json(
    {
      ok,
      ran: result.ran,
      failed: result.failed,
      skipped: result.skipped,
      durationMs: Date.now() - start,
      outcomes: result.outcomes,
    },
    { status: ok ? 200 : 500 },
  );
}

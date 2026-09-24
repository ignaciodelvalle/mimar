// Writer use-cases — evaluation → persistence with dedup.
//
// @no-auth-required: these run only from the CRON_SECRET-gated
// /api/cron/evaluate-alerts route. Not user-facing actions.

import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";

import { ALERT_FIRING_OPEN_STATUSES, alertFirings, alertSubscriptions, db, profiles } from "@/db";
import { type CronBudgetHeaders, effectiveDeadlineMs } from "@/lib/infra/cron-dispatcher";
import { evaluateAlertSubscriptions } from "@/lib/metrics/alert-evaluation";
import { shouldOpenFiring } from "@/lib/metrics/alert-firing";

import type { RecordFiringsResult } from "./types";

/**
 * Evaluate one admin user's active subscriptions and open firings for any new
 * breaches. Pure-decision (shouldOpenFiring) gates each insert; the dedup query
 * resolves existing OPEN firings per subscription so a second firing is never
 * opened while one is already in the inbox.
 *
 * Exported (not just used by the cron) so the writer is independently testable.
 */
export async function recordFiringsForUser(userId: string): Promise<RecordFiringsResult> {
  const evals = await evaluateAlertSubscriptions(userId, { role: "admin" });
  const breaching = evals.filter((e) => e.breaching);

  let opened = 0;

  for (const ev of breaching) {
    // Resolve existing OPEN firings for this exact (subscription, jurisdiction).
    const existing = await db
      .select({ status: alertFirings.status })
      .from(alertFirings)
      .where(
        and(
          eq(alertFirings.subscriptionId, ev.id),
          inArray(alertFirings.status, [...ALERT_FIRING_OPEN_STATUSES]),
        ),
      );

    if (!shouldOpenFiring(existing, { breaching: ev.breaching })) continue;

    await db.insert(alertFirings).values({
      subscriptionId: ev.id,
      metricKey: ev.metricKey,
      direction: ev.direction,
      threshold: String(ev.threshold),
      observedValue: String(ev.currentValue ?? 0),
      jurisdictionProvince: ev.jurisdictionProvince ?? null,
      jurisdictionLocality: ev.jurisdictionLocality ?? null,
      status: "disparada",
    });
    opened += 1;
  }

  return { evaluated: evals.length, breaching: breaching.length, opened };
}

// Wall-clock budget for the per-owner sweep (ms). Vercel Hobby cron functions
// time out at 60 s; 45 s leaves margin to finalize the cron_runs row.
const ALL_ADMINS_MAX_DURATION_MS = 45_000;

/**
 * Evaluate EVERY active subscription across all LIVE admin owners and open
 * firings.
 * Used by the daily cron so evaluation does not depend on an admin opening
 * /admin/programa. Subscriptions are owned per-actor, so we evaluate per owner.
 *
 * Bounded (review 23 fleet extension): previously this evaluated every owner
 * sequentially with no time budget, risking a run that blows the function
 * timeout mid-sweep on a large admin population. It now stops after
 * `maxDurationMs` and reports a keyset resume point (`nextOwnerCursor`) so the
 * caller can persist it and resume AFTER that owner next run — sweeping the
 * whole population fairly across runs instead of always starving the tail.
 * Evaluation is idempotent (dedup via shouldOpenFiring), so partial/overlapping
 * coverage across runs never double-opens a firing.
 */
export async function evaluateAndRecordFiringsForAllAdmins(opts?: {
  afterUserId?: string | null;
  maxDurationMs?: number;
  /**
   * The daily dispatcher's fair share (RN #9 half b): the deadline becomes
   * min(own ceiling, share handed down), so a late start cannot push the
   * shared function past its 60 s hard kill. Absent (a manual curl, Vercel
   * hitting the route directly) the constant is all there is, unchanged.
   */
  budgetHeaders?: CronBudgetHeaders;
}): Promise<RecordFiringsResult> {
  const ownCeilingMs = opts?.maxDurationMs ?? ALL_ADMINS_MAX_DURATION_MS;
  const maxDurationMs = opts?.budgetHeaders
    ? effectiveDeadlineMs(ownCeilingMs, opts.budgetHeaders)
    : ownCeilingMs;
  const afterUserId = opts?.afterUserId ?? null;
  const start = Date.now();

  // Distinct owners of at least one ACTIVE subscription = the set to evaluate,
  // ordered by id so the keyset resume cursor is stable across runs. Resume
  // strictly AFTER the previous run's last owner.
  //
  // LIVE ADMIN OWNERS ONLY (A10-G3). Each owner is evaluated under a universal
  // { role: "admin" } scope, so the sweep must admit exactly who
  // requireAdminOrRedirect admits: role admin, institutional, not deactivated,
  // not erased. Neither erasure (a soft delete of profiles) nor deactivation
  // touches alert_subscriptions, so without this join a gone admin's standing
  // rules kept firing into the triage inbox. The rows themselves remain — see
  // the alert_subscriptions KNOWN_GAP entry in check-subject-rights-coverage.ts.
  const liveAdminOwner = and(
    eq(profiles.role, "admin"),
    eq(profiles.accountType, "institutional"),
    isNull(profiles.deactivatedAt),
    isNull(profiles.deletedAt),
  );
  const owners = await db
    .selectDistinct({ actorUserId: alertSubscriptions.actorUserId })
    .from(alertSubscriptions)
    .innerJoin(profiles, eq(profiles.id, alertSubscriptions.actorUserId))
    .where(
      and(
        eq(alertSubscriptions.isActive, true),
        liveAdminOwner,
        afterUserId ? gt(alertSubscriptions.actorUserId, afterUserId) : undefined,
      ),
    )
    .orderBy(asc(alertSubscriptions.actorUserId));

  const totals: RecordFiringsResult = {
    evaluated: 0,
    breaching: 0,
    opened: 0,
    ownersTotal: owners.length,
    ownersEvaluated: 0,
    budgetExhausted: false,
    nextOwnerCursor: null,
  };

  for (const { actorUserId } of owners) {
    if (Date.now() - start >= maxDurationMs) {
      totals.budgetExhausted = true;
      break;
    }
    const res = await recordFiringsForUser(actorUserId);
    totals.evaluated += res.evaluated;
    totals.breaching += res.breaching;
    totals.opened += res.opened;
    totals.ownersEvaluated = (totals.ownersEvaluated ?? 0) + 1;
    totals.nextOwnerCursor = actorUserId;
  }

  // Fully drained the remaining owners → wrap: next run starts a fresh sweep
  // from the top. Only keep a resume cursor when the budget cut the run short.
  if (!totals.budgetExhausted) totals.nextOwnerCursor = null;

  return totals;
}

// Cron route — data-lifecycle purges (ARCH-G).
//
// GET /api/cron/data-lifecycle
//
// Authentication: header `x-cron-secret` must match process.env.CRON_SECRET.
//
// CRON_SECRET behaviour (identical to all other cron routes in this project):
//   - If CRON_SECRET is set: request header must match, otherwise 401.
//   - If CRON_SECRET is NOT set AND NODE_ENV !== 'production': warn and proceed.
//   - If CRON_SECRET is NOT set AND NODE_ENV === 'production': 401.
//
// Seven conservative purges per run (all batched — see lib/infra/data-lifecycle.ts),
// in this order:
//   1. rate_limit_buckets WHERE expires_at < now()  (via cleanupExpiredBuckets)
//   2. notifications WHERE expires_at < now()
//   3. push_subscriptions WHERE revoked_at < now() - PUSH_SUBSCRIPTION_REVOKED_TTL_DAYS
//   4. push_targets WHERE revoked_at < now() - the SAME TTL — the native sibling
//      of 3, a separate target so one channel's failure cannot abandon the other
//   5. org_contact_messages.submitter_ip nulled past ORG_CONTACT_IP_TTL_DAYS
//   6. cron_runs WHERE started_at < now() - 90d AND status IN ('ok','failed')
//   7. uploads-staging OBJECTS older than ABANDONED_STAGED_UPLOAD_MIN_AGE_MS that
//      no row references — the repo's first and only storage GC, and the answer
//      to the open hole migration 0206 documented. It is the only target that
//      deletes an object rather than a row, and the only one whose batches are
//      HTTP calls to the Storage API, which is why it runs last.
//
// Each drains in bounded batches under its fair share of the run's deadline,
// and each reports whether it FINISHED. `backlogged.*` is the field that makes
// the run readable: a count says how much came off the table, never whether
// anything is left, and an unfinished purge that reports only a count is
// indistinguishable from a completed one on a table that keeps growing.
//
// ONE TARGET FAILING DOES NOT ERASE THE OTHER SIX (2026-09-10). The composite
// isolates each target, so a throw comes back as `failures: [{ target, reason }]`
// alongside the TRUE counts of everything that ran. This route turns a non-empty
// list into a failed run — 500, a critical alert, an `errors` entry per target —
// so the isolation buys honesty, never silence. Before it, one throw made the
// row read seven zeros over rows that had really been deleted, and the alert named
// nothing.
//
// THAT 500 PROPAGATES, and it is worth meeting on paper rather than at 3am: when
// this job runs under the daily fan-out, `app/api/cron/daily/route.ts` sets
// `failed: r.failed > 0`, so ONE failed target here also flips cron_daily to
// failed, returns 500 from the dispatcher and fires its own critical alert. Two
// pages, not one. Correct — a target that cannot run must be visible — but the
// storage collector in particular used to answer a Storage refusal with a
// `console.error` and nothing else, so this is a real change in blast radius.
//
// THE DEADLINE COMES FROM THE DISPATCHER (RN-3 F17). /api/cron/daily forwards
// this job's fair share of what is left of its 55 s as `x-cron-budget-ms`
// (lib/infra/cron-dispatcher.ts); this route passes it through. Called
// standalone (no header) the purge runs on its own 45 s ceiling, as before.
//
// retention_until tables (profiles, pets, pet_identifications, custody_disputes):
//   All four are Ley 25.326 PII tables with no declared retention policy in any
//   design doc. Writers and purge logic for those columns are intentionally
//   omitted pending a product/legal decision.
//
// Returns: { ok: true, ...counts, durationMs, runId }

import { type NextRequest, NextResponse } from "next/server";

import { eq } from "drizzle-orm";

import { cronRuns, db } from "@/db";
import { authorizeCronRequest } from "@/lib/domain/cron-auth";
import { sendCronAlert } from "@/lib/infra/cron-alert";
import { cronBudgetFromHeaders } from "@/lib/infra/cron-dispatcher";
import {
  type DataLifecycleResult,
  type DataLifecycleTarget,
  runDataLifecyclePurge,
} from "@/lib/infra/data-lifecycle";

export const dynamic = "force-dynamic";

const CRON_NAME = "data_lifecycle";

/**
 * Target → the table (or bucket) it drains. Every log line built from this names
 * the SQL table, not the camelCase field, because the person reading a function
 * log is about to go look at that table.
 *
 * A `Record`, not a list of pairs, because `Record<DataLifecycleTarget, string>`
 * is EXHAUSTIVENESS-CHECKED: a seventh target added to the union is a compile
 * error here until it is given a label. As an array it was not, and the seventh
 * target would have logged `(unknown)` on a failure and dropped silently out of
 * the backlog warning below — the same class of quiet omission this whole change
 * is about. Insertion order is the run order, and `Object.entries` preserves it,
 * so the warning still reads in the order the targets ran.
 */
const TARGET_TABLE: Record<DataLifecycleTarget, string> = {
  rateLimitBuckets: "rate_limit_buckets",
  notifications: "notifications",
  pushSubscriptions: "push_subscriptions",
  pushTargets: "push_targets",
  orgContactIps: "org_contact_messages.submitter_ip",
  cronRuns: "cron_runs",
  // Not a table. The person reading this log line goes and looks at a BUCKET,
  // so the label names the bucket the same way the others name the table.
  stagedUploads: "uploads-staging (storage bucket)",
};

const BACKLOG_TABLES = Object.entries(TARGET_TABLE) as [DataLifecycleTarget, string][];

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
  // The initial value is what a FAILED run reports, so it must be the honest
  // "nothing ran" shape rather than a tidy zero: `backlogged` false everywhere
  // would claim seven drained tables on a run that never touched them.
  let counts: DataLifecycleResult = {
    notificationsDeleted: 0,
    rateLimitBucketsDeleted: 0,
    cronRunsDeleted: 0,
    pushSubscriptionsDeleted: 0,
    pushTargetsDeleted: 0,
    orgContactIpsPurged: 0,
    stagedUploadsDeleted: 0,
    backlogged: {
      notifications: true,
      rateLimitBuckets: true,
      cronRuns: true,
      pushSubscriptions: true,
      pushTargets: true,
      orgContactIps: true,
      stagedUploads: true,
    },
    failures: [],
  };
  const errors: { section: string; reason: string }[] = [];
  /**
   * Did the purge come back at all? A composite that threw leaves `counts` at
   * the literal above, which MEASURES NOTHING; a composite that returned with
   * failures measured six targets honestly and one not at all. The two are
   * different facts and only the second may be read as a backlog report.
   */
  let measured = false;

  // The dispatcher's fair share, or nothing (standalone → the lib's own ceiling).
  const budgetMs = cronBudgetFromHeaders(req.headers);

  try {
    counts = await runDataLifecyclePurge(budgetMs === null ? {} : { maxDurationMs: budgetMs });
    measured = true;

    // A TARGET THAT FAILED IS STILL A FAILED RUN. The composite no longer
    // throws for one — it isolates it so the other six report the rows they
    // really deleted — but isolation must not become silence: the run goes to
    // "failed", answers 500, and pages, exactly as it did when the throw
    // escaped. What changes is that the report is now TRUE about the rest and
    // NAMES the one that broke, instead of seven zeros and "an error occurred".
    for (const failure of counts.failures) {
      status = "failed";
      errors.push({ section: failure.target, reason: failure.reason });
      console.error(
        `[cron/${CRON_NAME}] target failed: ${failure.target} (${TARGET_TABLE[failure.target]}) — ${failure.reason}. The other targets ran; their counts in this row are real.`,
      );
    }
  } catch (err) {
    status = "failed";
    errors.push({
      section: "runDataLifecyclePurge",
      reason: err instanceof Error ? err.message : String(err),
    });
    console.error("[cron/data-lifecycle] Error:", err);
  }

  // A drain that stopped short must SAY SO in the logs. `backlogged` was
  // already in the response body and in cron_runs.details, but nothing READ
  // either on a run that returns `ok: true` with a 200 — so the flag that
  // exists precisely to distinguish "finished" from "ran out of budget on a
  // table that keeps growing" was only visible to someone already suspicious.
  //
  // Only on a run that MEASURED something. A composite that threw leaves the
  // initial all-true shape, which means "nothing ran", not "six tables are
  // behind" — reporting that would be a fabricated measurement, and the failure
  // already pages a human below. A run whose composite RETURNED did measure,
  // failures and all: the five targets that worked reported real flags, and the
  // one that threw is genuinely backlogged (its rows are still there), so the
  // warning is honest and belongs even though `status` is "failed".
  //
  // NO sendCronAlert here, deliberately. Siblings DO use it for non-failure
  // conditions — app/api/cron/reconcile-pet-status/route.ts fires severity
  // "warning" on drift and still returns 200 — so the precedent exists. But
  // drift is an anomaly, while a backlog on a deliberately batch-capped drain
  // is normal operation at volume (see RATE_LIMIT_CLEANUP_MAX_BATCHES and the
  // shared wall-clock deadline in lib/infra/data-lifecycle.ts): paging every
  // tick would train the recipient to ignore the channel. Escalating needs a
  // threshold — N consecutive runs backlogged — and that is its own change.
  if (measured) {
    const backlogged = BACKLOG_TABLES.filter(([flag]) => counts.backlogged[flag]).map(
      ([, table]) => table,
    );
    if (backlogged.length > 0) {
      console.warn(
        `[cron/${CRON_NAME}] backlog remains: ${backlogged.join(", ")} — the purge hit its batch cap or the wall-clock deadline before draining; rows are still expired and waiting for the next run.`,
      );
    }
  }

  const durationMs = Date.now() - start;

  await db
    .update(cronRuns)
    .set({
      status,
      finishedAt: new Date(),
      itemsProcessed:
        counts.notificationsDeleted +
        counts.rateLimitBucketsDeleted +
        counts.cronRunsDeleted +
        counts.pushSubscriptionsDeleted +
        // Counted as an item processed even though it is an UPDATE: what the
        // number means is "rows this run acted on", not "rows deleted".
        counts.orgContactIpsPurged +
        // Counted for the same reason and with the same caveat: these are
        // storage OBJECTS, not rows. `details` carries them under their own
        // name, so the breakdown is never lost in the sum.
        counts.stagedUploadsDeleted,
      details: errors.length > 0 ? { ...counts, errors } : counts,
    })
    .where(eq(cronRuns.id, run.id));

  // A failed purge must return HTTP 500 so Vercel's cron dashboard flags it and
  // retries — previously the route always returned 200 (review 23 fleet
  // extension).
  if (status === "failed") {
    await sendCronAlert({
      job: CRON_NAME,
      severity: "critical",
      // The SECTION is part of the alert's headline, not buried in `details`:
      // "stagedUploads: permission denied for schema storage" is actionable at
      // a glance; the bare reason leaves the reader guessing which of six
      // targets it came from.
      error: errors[0]
        ? `${errors[0].section}: ${errors[0].reason}`
        : "data-lifecycle purge failed",
      details: { ...counts, errors },
    });
  }

  return NextResponse.json(
    {
      ok: status === "ok",
      ...counts,
      durationMs,
      runId: run.id,
    },
    { status: status === "ok" ? 200 : 500 },
  );
}

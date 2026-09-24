// Data-lifecycle purge helpers — called by /api/cron/data-lifecycle.
//
// Seven conservative purges, all batched to avoid long table locks, in THIS
// order (the order is a priority — see runDataLifecyclePurge):
//   1. purgeExpiredRateLimitBuckets — delegates to cleanupExpiredBuckets() already
//      declared in lib/rate-limit.ts; re-exported here for symmetry.
//   2. purgeExpiredNotifications    — DELETE notifications WHERE expires_at < now()
//   3. purgeRevokedPushSubscriptions — DELETE push_subscriptions revoked longer ago
//      than PUSH_SUBSCRIPTION_REVOKED_TTL_DAYS.
//   4. purgeRevokedPushTargets      — the native sibling of 3: DELETE push_targets
//      revoked longer ago than the SAME TTL constant. A separate target and not a
//      widening of 3, so a failure on one channel cannot abandon the other's
//      batch mid-drain.
//   5. purgeOldOrgContactIps        — UPDATE org_contact_messages SET submitter_ip
//      = NULL past ORG_CONTACT_IP_TTL_DAYS. The only target that does not delete
//      a row: the message is the organization's record, the raw IP is a personal
//      datum with no reader that had indefinite retention.
//   6. purgeOldCronRuns             — DELETE cron_runs older than CRON_RUNS_TTL_DAYS.
//   7. purgeAbandonedStagedUploads  — the ONLY target that deletes an OBJECT
//      rather than a row: `uploads-staging` keys that were ticketed, PUT, and
//      never confirmed. It is last because every batch is an HTTP round trip to
//      the Storage API rather than a statement the pooler plans, and a slow
//      object store must not starve the six targets that hold locks.
//      lib/infra/storage-gc.ts owns the age, the caps, and — the part worth
//      reading — the reason the other eight buckets are out of scope.
//
// retention_until tables (profiles, pets, pet_identifications, custody_disputes):
//   All four carry Ley 25.326 PII. No retention policy has been defined in any
//   design doc. These columns are intentionally left inert pending a
//   product/legal decision. DO NOT add purge logic here without explicit sign-off.
//
// Batch size is intentionally small (PURGE_BATCH_SIZE = 500) so each DELETE
// acquires fewer locks and no single statement can hold them past the cron's
// function budget — 60 s per cron route in vercel.json, of which this job gets
// a share of the daily dispatcher's 55 s fan-out.
//
// ONE BATCH IS NOT ONE RUN, and the difference is the whole design. This file
// used to say "rows accumulate slowly enough that a single daily pass is
// sufficient for all three targets"; that was never measured and is false for
// rate_limit_buckets, which every limiter on every anonymous surface writes to
// twice per (key, window). So each target DRAINS — batch after bounded batch —
// under a deadline, under a hard batch cap, and every one of them REPORTS
// whether it finished. A purge that stops early and returns only a count
// cannot be told apart from one that finished, which is how a table grows for
// months under a green cron.
//
// THE BUDGET IS HANDED DOWN, NOT ASSUMED (RN-3 F17 / RN re-run HIGH, 2026-08-22).
// This job used to drain under its own 45 s constant inside a dispatcher whose
// whole budget is 55 s, with no idea how much of the run was already spent. The
// dispatcher now forwards the job's fair share of what is left
// (`x-cron-budget-ms`, lib/infra/cron-dispatcher.ts) and the route passes it in
// as `maxDurationMs`; the 45 s constant is only the ceiling for a standalone
// invocation. Inside the job the SAME arithmetic splits the share across the
// seven targets, so a backlog on one table can no longer starve the others.

import { sql } from "drizzle-orm";

import { db } from "@/db";
import { fairShareMs } from "@/lib/infra/cron-dispatcher";
import { RATE_LIMIT_CLEANUP_BATCH_SIZE, cleanupExpiredBuckets } from "@/lib/infra/rate-limit";
import {
  STORAGE_GC_BATCH_SIZE,
  STORAGE_GC_MAX_BATCHES,
  purgeAbandonedStagedUploads,
} from "@/lib/infra/storage-gc";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Delete cron_runs rows older than this many days. 90 days is generous for
 *  /admin/sistema to still show a meaningful history while bounding table growth. */
export const CRON_RUNS_TTL_DAYS = 90;

/**
 * Delete push_subscriptions rows REVOKED longer ago than this many days.
 *
 * Revocation is soft (`revoked_at`): the user toggled push off, or the push
 * service answered 404/410 (lib/infra/web-push.ts). The row stays as an
 * auditable trail, and until this purge nothing ever deleted it — hard deletion
 * existed only through the profiles cascade and erase_subject_data(). Thirty
 * days keeps the trail long enough for a device list or a support question to
 * still explain a revocation, and short enough that the table does not carry
 * every browser anyone ever unsubscribed.
 *
 * A LIVE row is deliberately NOT pruned on `last_used_at`. That column means
 * "we last delivered an urgent push here", not "the browser last used this":
 * a quiet pet's owner can go months without an urgent notification while the
 * registration is perfectly valid, and deleting it would silently drop their
 * next urgent push with the toggle still reading "on". The push service's
 * 404/410 is the honest staleness signal, it already flips `revoked_at`, and so
 * an abandoned browser reaches this purge through the revoked path anyway.
 */
export const PUSH_SUBSCRIPTION_REVOKED_TTL_DAYS = 30;

/**
 * NULL `org_contact_messages.submitter_ip` on rows older than this many days.
 *
 * A raw caller IP is personal data, and this one had INDEFINITE retention with
 * NO READER ANYWHERE: rate limiting lives entirely in `rate_limit_buckets`
 * (`callerIp()` feeds the limiter directly), and an enumeration of every
 * reference to the column finds a writer, a seed, two tests and a schema
 * comment — no SELECT. Write-only archival data kept forever is a finalidad
 * problem under Ley 25.326 art. 4 regardless of how it was collected.
 *
 * THIRTY DAYS, following PUSH_SUBSCRIPTION_REVOKED_TTL_DAYS above and for the
 * same shape of reason: long enough that the value could still explain an abuse
 * pattern somebody is actively investigating, short enough that the table does
 * not carry the address of everyone who ever wrote to a refugio. The MESSAGE is
 * NOT purged — an organization's inbox is the organization's record, and the
 * subject's own copy is redacted by `erase_subject_data` when they ask.
 *
 * This is a purge, not an erasure: it runs for everyone, erased or not, which
 * is why nulling the column in the RPC (migration 0205) does not make it
 * redundant. The RPC answers one person's art. 16 request; this bounds the
 * retention for everybody who never makes one.
 */
export const ORG_CONTACT_IP_TTL_DAYS = 30;

/** Maximum rows deleted per purge DELETE call. */
const PURGE_BATCH_SIZE = 500;

/**
 * Wall-clock CEILING for the composite drain (ms), used when no budget is
 * handed down — a standalone invocation of /api/cron/data-lifecycle. Keeps
 * the run inside Vercel's 60 s function budget while still draining a large
 * backlog. Under the daily dispatcher the effective budget is the smaller of
 * this and the job's fair share.
 */
export const MAX_DURATION_MS = 45_000;

/**
 * Hard batch cap for the rate-limit bucket drain — 40 × 500 = 20,000 rows.
 *
 * WHY A CAP WHEN A DEADLINE ALREADY EXISTS. The deadline is the safety net; the
 * cap is the STATED worst case. `rate_limit_buckets` is the fastest-filling
 * table in the schema — every limiter on every anonymous surface writes two rows
 * per (key, window), and the public credential API alone can write 120 rows a
 * minute per IP — so it is the one target that can plausibly hold more expired
 * rows than a single run should try to take. A drain with no stated ceiling has
 * a worst case of "whatever the budget buys against the pooler that night",
 * which is not a number anyone can reason about before an incident.
 *
 * WHY 40. The real budget is much smaller than it looks: `vercel.json` gives
 * every cron route handler under `app/api/cron/` a **60 s** maxDuration (NOT
 * Vercel's 300 s default; only refresh-cube is raised to 300), and
 * `app/api/cron/daily/route.ts` fans out to ~23 jobs inside a 55 s wall-clock
 * budget, skipping whatever does not fit. data_lifecycle is ONE of those jobs
 * and drains SEVEN targets, so a fair share here is single-digit seconds, not
 * 45. 40 batches is ~10× what the old one-batch-per-day pass could clear and
 * still small enough that the deadline — not this cap — is what stops a
 * genuinely slow night. Raising it is cheap; raising it without also raising
 * the dispatcher's share just moves the stall to a later job.
 */
export const RATE_LIMIT_CLEANUP_MAX_BATCHES = 40;

/**
 * Same cap for notifications — 20,000 rows a run. It used to drain UNCAPPED,
 * and it ran FIRST, so an expired-notification backlog could consume the whole
 * deadline before the bucket table (the one that actually fills) got a turn.
 * Expiry here is product-driven (a notification's own `expires_at`), not
 * attacker-influenced, so 20,000 a night is far above the steady state; the
 * `backlogged` flag says so if that ever stops being true.
 */
export const NOTIFICATIONS_CLEANUP_MAX_BATCHES = 40;

/** Push registrations are one row per browser; 5,000 revoked rows a run is plenty. */
export const PUSH_SUBSCRIPTIONS_CLEANUP_MAX_BATCHES = 10;

/**
 * Native push targets are one row per app INSTALL, a population smaller than the
 * browser one by construction: a person has several browsers and usually one
 * phone. The cap matches its sibling rather than being tuned down, because the
 * two share the TTL and there is no measurement yet that would justify a
 * different number — a cap invented from a guess reads as evidence and is not.
 *
 * It is a separate constant and not a reuse of the line above: that name says
 * `PUSH_SUBSCRIPTIONS`, and pointing a second table at it would make the name
 * lie the first time somebody tunes one population without the other.
 */
export const PUSH_TARGETS_CLEANUP_MAX_BATCHES = 10;

/** cron_runs grows by ~23 rows a day; the cap is for symmetry, not for volume. */
export const CRON_RUNS_CLEANUP_MAX_BATCHES = 40;

/** Contact messages arrive at human speed; 5,000 IPs nulled a run is plenty. */
export const ORG_CONTACT_IP_CLEANUP_MAX_BATCHES = 10;

/** What one target's drain accomplished, and whether it FINISHED. */
export type DrainOutcome = {
  deleted: number;
  /**
   * How many DELETE batches were issued. 0 means the target was not touched
   * at all — the distinction `deleted: 0` alone cannot make between "nothing
   * was eligible" and "there was no time to look".
   */
  batches: number;
  /**
   * True when the loop stopped with a FULL batch behind it — the cap or the
   * deadline cut it short and rows remain — or never started because the
   * deadline had already passed. The count alone cannot say this: "20,000
   * deleted" reads like a completed purge whether the table is now empty or
   * still holds a million rows, and a cron that cannot tell the difference is
   * how a table grows for months under a green dashboard.
   */
  backlogged: boolean;
  /**
   * The message of the throw that ENDED this drain, when one did. Absent on
   * every drain that stopped for an ordinary reason (short batch, cap,
   * deadline), so `error !== undefined` is the single test for "this target
   * failed" and no caller has to distinguish a failure from a quiet zero.
   *
   * The batches that ran BEFORE the throw are still counted in `deleted` —
   * they really did delete those rows, and a report that swallowed them would
   * be describing a run that did not happen.
   */
  error?: string;
};

/**
 * Repeatedly runs a single-batch purge `step` until it deletes fewer than
 * `batchSize` rows (backlog drained), the wall-clock deadline passes, or
 * `maxBatches` batches have run. Each step is its own bounded DELETE, so lock
 * duration stays small even while a large backlog drains across many iterations
 * within one run (review 23 fleet extension — previously each target ran ONE
 * 500-row batch per day).
 *
 * Exported for its tests: the properties that matter here are arithmetic (how
 * many times it calls, what it sums, when it reports a backlog), and proving
 * them by seeding 20,000 rows would cost more than the cap it is proving.
 * `now` is injectable for the same reason.
 *
 * NO TIME MEANS NO DELETE (2026-08-22). A deadline that has already passed
 * when the drain is entered — the composite's share of 0 ms, or a run that is
 * simply late — returns `{ deleted: 0, batches: 0, backlogged: true }` without
 * issuing a single batch. This file used to run the first batch regardless
 * ("a night with no budget left is not a night where nothing moves"), which
 * is a DELETE issued under a budget the dispatcher had already spent: the one
 * thing the handed-down budget exists to prevent, and a lock the next job in
 * the fan-out then waits behind. A POSITIVE share, however small, still runs
 * one batch — the check is `>=` at entry, not a threshold — so forward
 * progress is decided by the share the caller computed, not by how fast the
 * clock ticks between the caller's reading and this one (on a real clock a
 * 1 ms share can elapse in between; that is "no time", honestly reported).
 *
 * A STEP THAT THROWS ENDS THIS DRAIN AND NOTHING ELSE (2026-09-10). The throw
 * is caught here, the batches already taken are kept, and the outcome comes
 * back `backlogged: true` with `error` set — because rows ARE still on the
 * table and the caller must be able to say which target broke and why. This is
 * the ONLY place the isolation lives: `runDataLifecyclePurge` had no per-target
 * catch, so one target's throw escaped the whole composite, the route caught it,
 * and the run recorded ZERO for all seven targets — including the ones that had
 * already deleted their rows. The counts were a lie and the alert named nothing.
 *
 * It does NOT retry. A step that threw once inside a bounded nightly budget is
 * far likelier to be a dead pool, a missing grant or an outage than a blip, and
 * a retry loop here would spend the share the targets after it are owed.
 */
export async function drainPurge(
  step: () => Promise<number>,
  batchSize: number,
  deadlineMs: number,
  maxBatches = Number.POSITIVE_INFINITY,
  now: () => number = Date.now,
): Promise<DrainOutcome> {
  if (now() >= deadlineMs) return { deleted: 0, batches: 0, backlogged: true };
  let deleted = 0;
  let batches = 0;
  for (;;) {
    let batch: number;
    try {
      batch = await step();
    } catch (err) {
      // NOT counted as a batch: it never completed. `deleted` keeps whatever
      // the completed batches took off, which is the true number.
      return {
        deleted,
        batches,
        backlogged: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    deleted += batch;
    batches += 1;
    // A SHORT batch is the only proof the backlog is gone: the DELETE takes up
    // to `batchSize` and returns what it got, so anything less means it ran out
    // of eligible rows rather than out of room.
    if (batch < batchSize) return { deleted, batches, backlogged: false };
    if (batches >= maxBatches || now() >= deadlineMs) {
      return { deleted, batches, backlogged: true };
    }
  }
}

// ---------------------------------------------------------------------------
// Purge helpers
// ---------------------------------------------------------------------------

/**
 * Deletes notifications whose expires_at is in the past.
 * Returns the count of deleted rows.
 */
export async function purgeExpiredNotifications(): Promise<number> {
  const cutoff = new Date().toISOString();
  // Batched via subquery LIMIT (same pattern as purgeOldCronRuns) so a large
  // backlog of expired rows cannot hold locks past the cron's function budget.
  const result = (await db.execute(
    sql`
      DELETE FROM notifications
      WHERE id IN (
        SELECT id FROM notifications
        WHERE expires_at IS NOT NULL
          AND expires_at < ${cutoff}::timestamptz
        LIMIT ${PURGE_BATCH_SIZE}
      )
      RETURNING id
    `,
  )) as Array<{ id: string }>;
  return result.length;
}

/**
 * Deletes stale rate-limit buckets whose expiry window has passed.
 * Delegates to the existing cleanupExpiredBuckets() in lib/rate-limit.ts.
 * Returns the count of deleted rows.
 */
export async function purgeExpiredRateLimitBuckets(): Promise<number> {
  return cleanupExpiredBuckets();
}

/**
 * Deletes push_subscriptions rows revoked more than
 * PUSH_SUBSCRIPTION_REVOKED_TTL_DAYS ago. Live rows (`revoked_at IS NULL`) are
 * never touched — see the constant for why `last_used_at` is not a criterion.
 * Capped at PURGE_BATCH_SIZE per call; the composite drains.
 *
 * Returns the count of deleted rows.
 */
export async function purgeRevokedPushSubscriptions(): Promise<number> {
  const cutoffMs = Date.now() - PUSH_SUBSCRIPTION_REVOKED_TTL_DAYS * 24 * 60 * 60 * 1000;
  const cutoff = new Date(cutoffMs).toISOString();
  const result = (await db.execute(
    sql`
      DELETE FROM push_subscriptions
      WHERE id IN (
        SELECT id FROM push_subscriptions
        WHERE revoked_at IS NOT NULL
          AND revoked_at < ${cutoff}::timestamptz
        LIMIT ${PURGE_BATCH_SIZE}
      )
      RETURNING id
    `,
  )) as Array<{ id: string }>;
  return result.length;
}

/**
 * Deletes push_targets rows revoked more than PUSH_SUBSCRIPTION_REVOKED_TTL_DAYS
 * ago — the native sibling of the purge directly above.
 *
 * A SIBLING AND NOT AN EXTENSION OF THAT FUNCTION, deliberately. Widening it to
 * two tables would put the working web channel's cleanup and a new channel's on
 * one failure path: a statement that errors on push_targets would abandon the
 * push_subscriptions batch mid-drain, and the composite would report one number
 * for two populations. The purges are already enumerated one per target for that
 * reason.
 *
 * THE TTL CONSTANT IS SHARED ON PURPOSE. Both tables hold a soft-revoked
 * delivery address and neither has a reason to outlive the other; two constants
 * would be two numbers to keep in agreement with nothing forcing them to.
 *
 * Live rows (`revoked_at IS NULL`) are never touched, and `last_used_at` is not
 * a criterion here either: a device that has simply not received anything in a
 * month is not a device that should stop receiving.
 *
 * Returns the count of deleted rows.
 */
export async function purgeRevokedPushTargets(): Promise<number> {
  const cutoffMs = Date.now() - PUSH_SUBSCRIPTION_REVOKED_TTL_DAYS * 24 * 60 * 60 * 1000;
  const cutoff = new Date(cutoffMs).toISOString();
  const result = (await db.execute(
    sql`
      DELETE FROM push_targets
      WHERE id IN (
        SELECT id FROM push_targets
        WHERE revoked_at IS NOT NULL
          AND revoked_at < ${cutoff}::timestamptz
        LIMIT ${PURGE_BATCH_SIZE}
      )
      RETURNING id
    `,
  )) as Array<{ id: string }>;
  return result.length;
}

/**
 * NULLs `org_contact_messages.submitter_ip` on rows older than
 * ORG_CONTACT_IP_TTL_DAYS. See the constant for why the column has a TTL at all.
 *
 * The ONLY target here that UPDATEs rather than DELETEs, and the difference is
 * deliberate: the message, the organization it went to and the timestamps are
 * that organization's inbox — a record of a real conversation. Only the IP has
 * no reader and no reason to persist, so only the IP goes.
 *
 * `submitter_ip IS NOT NULL` is what makes the drain CONVERGE: without it every
 * batch would re-select the same 500 already-nulled rows and `drainPurge` would
 * never see a short batch, so it would run to its cap every single night and
 * report a backlog that does not exist.
 *
 * Returns the count of rows changed.
 */
export async function purgeOldOrgContactIps(): Promise<number> {
  const cutoffMs = Date.now() - ORG_CONTACT_IP_TTL_DAYS * 24 * 60 * 60 * 1000;
  const cutoff = new Date(cutoffMs).toISOString();
  const result = (await db.execute(
    sql`
      UPDATE org_contact_messages
         SET submitter_ip = NULL
       WHERE id IN (
         SELECT id FROM org_contact_messages
         WHERE submitter_ip IS NOT NULL
           AND created_at < ${cutoff}::timestamptz
         LIMIT ${PURGE_BATCH_SIZE}
       )
      RETURNING id
    `,
  )) as Array<{ id: string }>;
  return result.length;
}

/**
 * Deletes cron_runs rows that finished more than CRON_RUNS_TTL_DAYS ago.
 * Only terminal rows (status = 'ok' | 'failed') are eligible; we never
 * delete 'running' rows — those are either in-flight or stuck (visible
 * for debugging). Capped at PURGE_BATCH_SIZE to limit lock duration.
 *
 * Returns the count of deleted rows.
 */
export async function purgeOldCronRuns(): Promise<number> {
  const cutoffMs = Date.now() - CRON_RUNS_TTL_DAYS * 24 * 60 * 60 * 1000;
  // Pass as ISO string — the postgres driver used by Drizzle requires string
  // literals for timestamptz parameters in db.execute() raw SQL calls.
  const cutoff = new Date(cutoffMs).toISOString();

  // Postgres-native batched DELETE with a subquery so we can apply LIMIT.
  // drizzle-orm does not expose DELETE … LIMIT natively; this raw fragment
  // is the standard workaround pattern used elsewhere in this codebase.
  const result = (await db.execute(
    sql`
      DELETE FROM cron_runs
      WHERE id IN (
        SELECT id FROM cron_runs
        WHERE status IN ('ok', 'failed')
          AND started_at < ${cutoff}::timestamptz
        LIMIT ${PURGE_BATCH_SIZE}
      )
      RETURNING id
    `,
  )) as Array<{ id: string }>;

  return result.length;
}

// ---------------------------------------------------------------------------
// Composite runner (called by the cron route)
// ---------------------------------------------------------------------------

/**
 * The seven targets, by the key they carry through every layer of this job — the
 * `backlogged` map, the failure list, and the route's table-name lookup.
 */
export type DataLifecycleTarget =
  | "rateLimitBuckets"
  | "notifications"
  | "pushSubscriptions"
  | "pushTargets"
  | "orgContactIps"
  | "cronRuns"
  | "stagedUploads";

/** One target that THREW, and what it said. */
export type DataLifecycleFailure = {
  target: DataLifecycleTarget;
  reason: string;
};

export interface DataLifecycleResult {
  notificationsDeleted: number;
  rateLimitBucketsDeleted: number;
  cronRunsDeleted: number;
  pushSubscriptionsDeleted: number;
  /** Native push targets deleted — the sibling count of the line above. */
  pushTargetsDeleted: number;
  /** Rows whose `submitter_ip` was nulled — an UPDATE, not a DELETE. */
  orgContactIpsPurged: number;
  /**
   * Abandoned `uploads-staging` OBJECTS deleted — not rows.
   *
   * The only target here that acts on the object store rather than on a table,
   * and the name says so because the drain contract everything else in this file
   * satisfies counts rows. See lib/infra/storage-gc.ts for which buckets are in
   * scope and, more importantly, why the other eight are not.
   */
  stagedUploadsDeleted: number;
  /**
   * Per target: did this run stop with rows still on the table?
   *
   * It rides in `cron_runs.details` and in the route's JSON so /admin/sistema
   * can show "still backlogged" instead of a count that looks like success.
   * The counts alone are ambiguous by construction — see `DrainOutcome`.
   */
  backlogged: {
    notifications: boolean;
    rateLimitBuckets: boolean;
    cronRuns: boolean;
    pushSubscriptions: boolean;
    pushTargets: boolean;
    orgContactIps: boolean;
    stagedUploads: boolean;
  };
  /**
   * The targets that THREW, in run order. Empty on a clean run, which is the
   * only thing a caller has to test.
   *
   * WHY THIS IS A FIELD AND NOT AN EXCEPTION. The seven targets are independent —
   * seven tables, seven statements, no shared transaction — so one of them being
   * unable to run says nothing about the other six, and until 2026-09-10 it
   * silenced all of them: the throw escaped the composite, the route caught it,
   * and `counts` stayed at the initial all-zeros literal even though the targets
   * ahead of the failure had already deleted their rows. The run then recorded
   * zero, marked itself failed and paged a human — nightly, with the counts
   * wrong about work that really happened.
   *
   * So the composite no longer throws for a target: it runs all seven, reports the
   * TRUE counts of the ones that worked, marks the one that failed as backlogged
   * (its rows are still there), and names it here. The route turns a non-empty
   * list into `status: "failed"`, HTTP 500 and a critical alert — the run is
   * still visibly failed, which is the half that must not be lost.
   *
   * Additive on purpose: every existing consumer of the counts and of
   * `backlogged` reads exactly what it read before.
   */
  failures: DataLifecycleFailure[];
}

/** One single-batch purge per target. Injectable so the composite's arithmetic
 *  (order, caps, the fair share) is provable without a database. */
export type Purgers = {
  rateLimitBuckets: () => Promise<number>;
  notifications: () => Promise<number>;
  pushSubscriptions: () => Promise<number>;
  pushTargets: () => Promise<number>;
  orgContactIps: () => Promise<number>;
  cronRuns: () => Promise<number>;
  stagedUploads: () => Promise<number>;
};

const DEFAULT_PURGERS: Purgers = {
  rateLimitBuckets: purgeExpiredRateLimitBuckets,
  notifications: purgeExpiredNotifications,
  pushSubscriptions: purgeRevokedPushSubscriptions,
  pushTargets: purgeRevokedPushTargets,
  orgContactIps: purgeOldOrgContactIps,
  cronRuns: purgeOldCronRuns,
  stagedUploads: purgeAbandonedStagedUploads,
};

export type DataLifecycleOptions = {
  /**
   * The budget this run may spend, in ms — the dispatcher's fair share when
   * invoked through /api/cron/daily, omitted on a standalone call. Always
   * capped by MAX_DURATION_MS, so a generous parent cannot push the run past
   * the function's own 60 s.
   */
  maxDurationMs?: number;
  /** Injectable clock for tests. Default: Date.now. */
  now?: () => number;
  /** Injectable purgers for tests. Default: the real SQL. */
  purgers?: Partial<Purgers>;
};

/**
 * Runs all seven purges in sequence. Each is independent — a failure in one does
 * not abort the others, and the ones that ran report their TRUE counts next to
 * the name of the one that broke (`failures`). Returns per-section counts for
 * the cron_runs.details payload.
 *
 * THIS DOCBLOCK USED TO CLAIM THAT INDEPENDENCE AND THE CODE DID NOT HAVE IT
 * ("the route handles per-section error logging" — it did not; there was no per
 * -section anything). A throw escaped the whole composite and the route recorded
 * seven zeros over work that had really been done. `drainPurge` now owns the
 * isolation, `failures` carries the verdict, and the route turns it into a
 * failed run that names the target. See the `failures` field for the full story.
 *
 * THE ORDER IS A PRIORITY AND THE DEADLINE IS SPLIT FAIRLY. Each target's
 * deadline is `now + fairShareMs(budget left, targets still to run)` — the
 * same arithmetic the dispatcher applies per job — so the first target cannot
 * eat the whole budget, and a target that finishes early hands its leftover to
 * the ones after it. Within that, the order says who gets the FIRST share of a
 * tight night:
 *
 *   1. rate_limit_buckets — the fastest-filling table, and the only one whose
 *      growth an anonymous caller influences (120 rows/min per IP through the
 *      credential API alone). It also sits on the hot path: every anonymous
 *      request's limiter upserts into it, so bloat here slows the credential
 *      page itself.
 *   2. notifications — user-visible: nothing in the inbox query filters
 *      `expires_at`, so an expired notification lingers until this purge takes
 *      it. Product-driven volume, so second rather than first.
 *   3. push_subscriptions — revoked rows, an audit trail that has served its
 *      purpose. Tiny table.
 *   4. push_targets — the native sibling of 3, same TTL, same shape of trail.
 *      Immediately after it because the two tables answer the same question for
 *      two channels and there is no reason to drain one a night ahead of the
 *      other.
 *   5. org_contact_messages.submitter_ip — personal data past its retention.
 *      Ahead of cron_runs because a compliance bound outranks a debugging
 *      convenience on a night with no budget left; behind the three above
 *      because the table grows at human speed and a night's delay is a night,
 *      not a backlog.
 *   6. cron_runs — 90 days of rows is a debugging convenience, not a
 *      correctness property.
 *   7. uploads-staging objects — LAST, and for a reason none of the six above
 *      have: its batches are HTTP calls to the Storage API, whose latency this
 *      process neither controls nor can predict. A slow object store on a tight
 *      night must cost this target its share and nobody else's. It is also the
 *      least urgent: 0206 already BOUNDS the leak (private bucket, 5 MiB an
 *      object, ~60 abandonable uploads per account per day) — this only stops
 *      it accumulating forever.
 *
 * Every target is capped as well (the STATED worst case per target); the
 * deadline is the safety net for a slow night.
 *
 * A share of 0 ms — the budget already spent when a target's turn comes — is
 * handed to drainPurge as a deadline equal to the target's own start, and
 * drainPurge issues nothing (see its header). The zero leftover then flows to
 * the next target unchanged (0 / targets left is still 0), so a spent budget
 * reads as seven `backlogged: true` flags and zero DELETEs, never as one free
 * batch per table under a budget the dispatcher no longer has.
 */
export async function runDataLifecyclePurge(
  options: DataLifecycleOptions = {},
): Promise<DataLifecycleResult> {
  const now = options.now ?? Date.now;
  const purgers: Purgers = { ...DEFAULT_PURGERS, ...options.purgers };
  const budgetMs = Math.min(MAX_DURATION_MS, options.maxDurationMs ?? MAX_DURATION_MS);
  const runDeadlineMs = now() + budgetMs;

  const targets = [
    {
      key: "rateLimitBuckets",
      step: purgers.rateLimitBuckets,
      batchSize: RATE_LIMIT_CLEANUP_BATCH_SIZE,
      maxBatches: RATE_LIMIT_CLEANUP_MAX_BATCHES,
    },
    {
      key: "notifications",
      step: purgers.notifications,
      batchSize: PURGE_BATCH_SIZE,
      maxBatches: NOTIFICATIONS_CLEANUP_MAX_BATCHES,
    },
    {
      key: "pushSubscriptions",
      step: purgers.pushSubscriptions,
      batchSize: PURGE_BATCH_SIZE,
      maxBatches: PUSH_SUBSCRIPTIONS_CLEANUP_MAX_BATCHES,
    },
    {
      key: "pushTargets",
      step: purgers.pushTargets,
      batchSize: PURGE_BATCH_SIZE,
      maxBatches: PUSH_TARGETS_CLEANUP_MAX_BATCHES,
    },
    {
      key: "orgContactIps",
      step: purgers.orgContactIps,
      batchSize: PURGE_BATCH_SIZE,
      maxBatches: ORG_CONTACT_IP_CLEANUP_MAX_BATCHES,
    },
    {
      key: "cronRuns",
      step: purgers.cronRuns,
      batchSize: PURGE_BATCH_SIZE,
      maxBatches: CRON_RUNS_CLEANUP_MAX_BATCHES,
    },
    {
      key: "stagedUploads",
      step: purgers.stagedUploads,
      batchSize: STORAGE_GC_BATCH_SIZE,
      maxBatches: STORAGE_GC_MAX_BATCHES,
    },
  ] as const;

  const outcomes = {} as Record<(typeof targets)[number]["key"], DrainOutcome>;
  const failures: DataLifecycleFailure[] = [];
  for (const [index, target] of targets.entries()) {
    // ONE reading per target: what is left is measured from the same instant
    // the target's own deadline is anchored on.
    const startedAt = now();
    const share = fairShareMs(
      runDeadlineMs - startedAt,
      targets.length - index,
      Number.POSITIVE_INFINITY,
    );
    const outcome = await drainPurge(
      target.step,
      target.batchSize,
      startedAt + share,
      target.maxBatches,
      now,
    );
    outcomes[target.key] = outcome;
    // The loop does NOT break: the targets after this one are independent of
    // it, they still have their own share of the budget, and the whole reason
    // this list exists is that a failure used to take them down with it.
    if (outcome.error !== undefined) {
      failures.push({ target: target.key, reason: outcome.error });
    }
  }

  return {
    notificationsDeleted: outcomes.notifications.deleted,
    rateLimitBucketsDeleted: outcomes.rateLimitBuckets.deleted,
    cronRunsDeleted: outcomes.cronRuns.deleted,
    pushSubscriptionsDeleted: outcomes.pushSubscriptions.deleted,
    pushTargetsDeleted: outcomes.pushTargets.deleted,
    orgContactIpsPurged: outcomes.orgContactIps.deleted,
    stagedUploadsDeleted: outcomes.stagedUploads.deleted,
    backlogged: {
      notifications: outcomes.notifications.backlogged,
      rateLimitBuckets: outcomes.rateLimitBuckets.backlogged,
      cronRuns: outcomes.cronRuns.backlogged,
      pushSubscriptions: outcomes.pushSubscriptions.backlogged,
      pushTargets: outcomes.pushTargets.backlogged,
      orgContactIps: outcomes.orgContactIps.backlogged,
      stagedUploads: outcomes.stagedUploads.backlogged,
    },
    failures,
  };
}

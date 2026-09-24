// Integration tests for the data-lifecycle purge logic (ARCH-G).
//
// Tests call the lib functions directly (not the HTTP route) so they exercise
// the real purge SQL against the local Supabase DB. The HTTP-layer auth guard
// is already proven by the existing cron-auto-expire-approvals test pattern.
//
// Coverage:
//   1. purgeExpiredNotifications — expired rows deleted, fresh rows untouched.
//   2. purgeExpiredRateLimitBuckets — expired buckets deleted, live ones kept.
//   3. purgeOldCronRuns — old terminal rows deleted, recent and running rows kept.
//   4. runDataLifecyclePurge — composite; returns summed counts.
//   5. purgeAbandonedStagedUploads — the uploads-staging collector: the age
//      boundary in both directions, the reference guard, the batch cap and the
//      drain. It runs against the real Storage service and cleans up after
//      itself, because it is the only target in this file that deletes an object
//      somebody uploaded.

import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { eq, like, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  attachments,
  cronRuns,
  db,
  notifications,
  orgContactMessages,
  organizations,
  profiles,
  pushSubscriptions,
  rateLimitBuckets,
} from "@/db";
import {
  CRON_RUNS_CLEANUP_MAX_BATCHES,
  CRON_RUNS_TTL_DAYS,
  MAX_DURATION_MS,
  NOTIFICATIONS_CLEANUP_MAX_BATCHES,
  ORG_CONTACT_IP_CLEANUP_MAX_BATCHES,
  ORG_CONTACT_IP_TTL_DAYS,
  PUSH_SUBSCRIPTIONS_CLEANUP_MAX_BATCHES,
  PUSH_SUBSCRIPTION_REVOKED_TTL_DAYS,
  RATE_LIMIT_CLEANUP_MAX_BATCHES,
  drainPurge,
  purgeExpiredNotifications,
  purgeExpiredRateLimitBuckets,
  purgeOldCronRuns,
  purgeOldOrgContactIps,
  purgeRevokedPushSubscriptions,
  runDataLifecyclePurge,
} from "@/lib/infra/data-lifecycle";
import { STAGING_BUCKET } from "@/lib/infra/pet-photo-upload";
import {
  ABANDONED_STAGED_UPLOAD_MIN_AGE_MS,
  STORAGE_GC_BATCH_SIZE,
  STORAGE_GC_MAX_BATCHES,
  listAbandonedStagedObjects,
  purgeAbandonedStagedUploads,
} from "@/lib/infra/storage-gc";
import { createAdminClient } from "@/lib/supabase/admin";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

// ---------------------------------------------------------------------------
// Test auth bootstrap — we need a real user profile because notifications
// has a NOT NULL FK to profiles.id.
// ---------------------------------------------------------------------------

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabase = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

const TEST_EMAIL = "data-lifecycle-test@dim-test.local";
const TEST_PASS = "DataLifecycle_2026!";

let testUserId: string;

async function purgeTestUser() {
  const { data } = await supabase.auth.admin.listUsers();
  const found = data?.users.find((u) => u.email === TEST_EMAIL);
  if (!found) return;
  await db
    .delete(notifications)
    .where(eq(notifications.userId, found.id))
    .catch(() => {});
  await db
    .delete(profiles)
    .where(eq(profiles.id, found.id))
    .catch(() => {});
  await supabase.auth.admin.deleteUser(found.id);
}

beforeAll(async () => {
  await purgeTestUser();
  const { data, error } = await createFreshTestUser(supabase, {
    email: TEST_EMAIL,
    password: TEST_PASS,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  testUserId = data.user.id;
});

afterAll(async () => {
  // Clean up anything the tests may have left behind.
  await db
    .delete(notifications)
    .where(eq(notifications.userId, testUserId))
    .catch(() => {});
  await db
    .delete(rateLimitBuckets)
    .where(like(rateLimitBuckets.bucketKey, "dlc_test_%"))
    .catch(() => {});
  await db
    .delete(cronRuns)
    .where(like(cronRuns.cronName, "dlc_test_%"))
    .catch(() => {});
  await db
    .delete(pushSubscriptions)
    .where(like(pushSubscriptions.endpoint, "https://push.dlc-test.local/%"))
    .catch(() => {});
  await purgeTestUser();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert a notification for the test user with a given expiresAt. */
async function insertNotification(expiresAt: Date | null): Promise<string> {
  const [row] = await db
    .insert(notifications)
    .values({
      userId: testUserId,
      notificationType: "dlc_test",
      title: "DLC test notification",
      severity: "info",
      expiresAt: expiresAt ?? undefined,
    })
    .returning({ id: notifications.id });
  return row.id;
}

/** Insert a rate-limit bucket with a given expiresAt. */
async function insertBucket(key: string, expiresAt: Date): Promise<void> {
  await db
    .insert(rateLimitBuckets)
    .values({ bucketKey: key, count: 1, expiresAt })
    .onConflictDoNothing();
}

/** Insert a cron_run with a given startedAt and status. */
async function insertCronRun(
  startedAt: Date,
  status: "ok" | "failed" | "running",
): Promise<string> {
  const [row] = await db
    .insert(cronRuns)
    .values({
      cronName: "dlc_test_cron",
      startedAt,
      finishedAt: status !== "running" ? new Date(startedAt.getTime() + 1000) : undefined,
      status,
    })
    .returning({ id: cronRuns.id });
  return row.id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("purgeExpiredNotifications", () => {
  it("deletes expired notifications and leaves fresh ones untouched", async () => {
    const past = new Date(Date.now() - 1000); // 1 second ago
    const future = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now

    const expiredId = await insertNotification(past);
    const freshId = await insertNotification(future);
    const noExpiryId = await insertNotification(null); // no expiry — must never be touched

    const deleted = await purgeExpiredNotifications();

    expect(deleted).toBeGreaterThanOrEqual(1);

    // Expired row must be gone.
    const expiredRows = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.id, expiredId));
    expect(expiredRows).toHaveLength(0);

    // Fresh row must remain.
    const freshRows = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.id, freshId));
    expect(freshRows).toHaveLength(1);

    // No-expiry row must remain.
    const noExpiryRows = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.id, noExpiryId));
    expect(noExpiryRows).toHaveLength(1);

    // Cleanup
    await db
      .delete(notifications)
      .where(eq(notifications.id, freshId))
      .catch(() => {});
    await db
      .delete(notifications)
      .where(eq(notifications.id, noExpiryId))
      .catch(() => {});
  });

  it("is idempotent — running twice on already-expired rows is a no-op on the second run", async () => {
    const past = new Date(Date.now() - 1000);
    const id = await insertNotification(past);

    const first = await purgeExpiredNotifications();
    expect(first).toBeGreaterThanOrEqual(1);

    // Row should be gone already.
    const rows = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.id, id));
    expect(rows).toHaveLength(0);

    // Second run finds nothing to delete for this row.
    const second = await purgeExpiredNotifications();
    // May be 0 or higher depending on other concurrent test data; the
    // important thing is no error and the row stays gone.
    expect(second).toBeGreaterThanOrEqual(0);
  });
});

describe("purgeExpiredRateLimitBuckets", () => {
  it("deletes expired buckets and keeps live ones", async () => {
    const expiredKey = `dlc_test_rl_expired_${Date.now()}`;
    const liveKey = `dlc_test_rl_live_${Date.now()}`;

    await insertBucket(expiredKey, new Date(Date.now() - 1000)); // past
    await insertBucket(liveKey, new Date(Date.now() + 3_600_000)); // future

    // The purge deletes in bounded batches and the caller is expected to
    // drain (see cleanupExpiredBuckets). Under the full parallel suite,
    // sibling tests create their own expired buckets that can fill a batch
    // ahead of ours — drain until empty so the assertion is order-immune.
    let deleted = 0;
    for (let batch = await purgeExpiredRateLimitBuckets(); batch > 0; ) {
      deleted += batch;
      batch = await purgeExpiredRateLimitBuckets();
    }
    expect(deleted).toBeGreaterThanOrEqual(1);

    // Expired bucket gone.
    const expiredRows = await db
      .select({ key: rateLimitBuckets.bucketKey })
      .from(rateLimitBuckets)
      .where(eq(rateLimitBuckets.bucketKey, expiredKey));
    expect(expiredRows).toHaveLength(0);

    // Live bucket present.
    const liveRows = await db
      .select({ key: rateLimitBuckets.bucketKey })
      .from(rateLimitBuckets)
      .where(eq(rateLimitBuckets.bucketKey, liveKey));
    expect(liveRows).toHaveLength(1);

    // Cleanup
    await db
      .delete(rateLimitBuckets)
      .where(eq(rateLimitBuckets.bucketKey, liveKey))
      .catch(() => {});
  });
});

describe("purgeOldCronRuns", () => {
  it("deletes old terminal rows and keeps recent and running rows", async () => {
    const oldDate = new Date(Date.now() - (CRON_RUNS_TTL_DAYS + 1) * 24 * 60 * 60 * 1000);
    const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000); // 1 day ago

    const oldOkId = await insertCronRun(oldDate, "ok");
    const oldFailedId = await insertCronRun(oldDate, "failed");
    const recentOkId = await insertCronRun(recentDate, "ok");
    // Running rows must never be deleted regardless of age.
    const oldRunningId = await insertCronRun(oldDate, "running");

    const deleted = await purgeOldCronRuns();
    expect(deleted).toBeGreaterThanOrEqual(2);

    // Old terminal rows must be gone.
    for (const id of [oldOkId, oldFailedId]) {
      const rows = await db.select({ id: cronRuns.id }).from(cronRuns).where(eq(cronRuns.id, id));
      expect(rows).toHaveLength(0);
    }

    // Recent ok row must remain.
    const recentRows = await db
      .select({ id: cronRuns.id })
      .from(cronRuns)
      .where(eq(cronRuns.id, recentOkId));
    expect(recentRows).toHaveLength(1);

    // Old running row must remain (we never delete 'running').
    const runningRows = await db
      .select({ id: cronRuns.id })
      .from(cronRuns)
      .where(eq(cronRuns.id, oldRunningId));
    expect(runningRows).toHaveLength(1);

    // Cleanup leftover rows.
    await db
      .delete(cronRuns)
      .where(eq(cronRuns.id, recentOkId))
      .catch(() => {});
    await db
      .delete(cronRuns)
      .where(eq(cronRuns.id, oldRunningId))
      .catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// The drain loop itself — bounded, and honest about what it did not finish
// ---------------------------------------------------------------------------
//
// `cleanupExpiredBuckets` deletes ONE 500-row batch and its own comment says
// "the caller drains". This is that caller, and the properties that matter are
// arithmetic rather than SQL: it must keep going while batches come back full,
// stop the moment one comes back short, and — the part that was missing — SAY
// SO when it stopped with work still on the table. A purge that quietly ran out
// of budget and reported a tidy number is indistinguishable from one that
// finished, which is how a table grows for months under a green cron.
//
// Driven by a FAKE step, deliberately: seeding 20,000 expired buckets to prove
// the cap would take longer than the cap it is proving.

describe("drainPurge", () => {
  /** A step that returns the given batch sizes in order, then 0. */
  function fakeStep(sizes: number[]) {
    let i = 0;
    const calls: number[] = [];
    return {
      calls,
      step: async () => {
        const n = sizes[i] ?? 0;
        i += 1;
        calls.push(n);
        return n;
      },
    };
  }

  const NO_DEADLINE = Number.POSITIVE_INFINITY;

  it("drains until a batch comes back SHORT, and sums every batch", async () => {
    const fake = fakeStep([500, 500, 120]);

    const result = await drainPurge(fake.step, 500, NO_DEADLINE);

    expect(fake.calls).toEqual([500, 500, 120]);
    expect(result.deleted).toBe(1120);
    expect(result.batches).toBe(3);
    // 120 < 500 means the backlog is gone — nothing left to come back for.
    expect(result.backlogged).toBe(false);
  });

  it("stops at the batch cap and FLAGS that a backlog remains", async () => {
    // Every batch full: the table has more than the cap can take in one run.
    const fake = fakeStep(Array(50).fill(500));

    const result = await drainPurge(fake.step, 500, NO_DEADLINE, 3);

    expect(fake.calls).toHaveLength(3);
    expect(result.deleted).toBe(1500);
    // THE POINT. Without this the cron row reads "1500 deleted" and looks like
    // a completed purge on a table that is still growing.
    expect(result.backlogged).toBe(true);
  });

  /** A clock that returns the given readings in order, then the last one forever. */
  function readings(values: number[]) {
    let i = 0;
    return () => {
      const v = values[Math.min(i, values.length - 1)];
      i += 1;
      return v;
    };
  }

  it("stops at the wall-clock deadline and FLAGS the backlog too", async () => {
    const fake = fakeStep(Array(50).fill(500));

    // Entry reading 0 (before the deadline of 1), then 2 after the first batch:
    // one batch runs, and the loop sees it is out of time.
    const result = await drainPurge(fake.step, 500, 1, Number.POSITIVE_INFINITY, readings([0, 2]));

    expect(fake.calls).toHaveLength(1);
    expect(result.batches).toBe(1);
    expect(result.backlogged).toBe(true);
  });

  it("issues NO batch when the deadline has already passed at entry — a zero share is no time, not one free batch", async () => {
    // The composite hands each target `now + share`; a share of 0 ms makes the
    // deadline equal to the entry reading. Until 2026-08-22 the first batch ran
    // anyway ("a night with no budget left is not a night where nothing
    // moves"), which meant a DELETE issued under a budget the dispatcher had
    // already spent — the one thing the handed-down budget exists to prevent.
    // Now: no time means no DELETE, and the flags say the table was not
    // touched. Both the equal case (share 0) and the already-past case.
    for (const deadline of [1000, 999]) {
      const fake = fakeStep(Array(50).fill(500));
      const result = await drainPurge(
        fake.step,
        500,
        deadline,
        Number.POSITIVE_INFINITY,
        () => 1000,
      );
      expect(fake.calls, `deadline ${deadline} at now=1000`).toEqual([]);
      expect(result).toEqual({ deleted: 0, batches: 0, backlogged: true });
    }
  });

  it("a POSITIVE share, however small, still runs one batch — forward progress is the share's, not the clock's", async () => {
    const fake = fakeStep(Array(50).fill(500));

    // Deadline 1 ms after the entry reading: the batch runs, then the loop
    // reads the clock past the deadline and is out of time. The distinction
    // is `>=` at entry, not a threshold.
    const result = await drainPurge(
      fake.step,
      500,
      1001,
      Number.POSITIVE_INFINITY,
      readings([1000, 1001]),
    );

    expect(fake.calls).toHaveLength(1);
    expect(result.batches).toBe(1);
    expect(result.backlogged).toBe(true);
  });

  it("keeps the rows it already took when a later batch THROWS, and names the reason", async () => {
    // THE PARTIAL COUNT IS THE WHOLE POINT. Two batches completed and really
    // deleted 1,000 rows; the third never returned. A drain that reported 0
    // here — which is what a `catch { return 0 }` inside the step produces —
    // would be describing a run that did not happen.
    let call = 0;
    const step = async () => {
      call += 1;
      if (call === 3) throw new Error("pooler down");
      return 500;
    };

    const result = await drainPurge(step, 500, NO_DEADLINE);

    expect(result.deleted).toBe(1000);
    // The throwing batch is NOT counted: it never completed.
    expect(result.batches).toBe(2);
    // Rows are still on the table, so this is a backlog by any reading.
    expect(result.backlogged).toBe(true);
    expect(result.error).toBe("pooler down");
  });

  it("leaves `error` unset when the drain stopped for an ORDINARY reason", async () => {
    // NON-VACUITY for the field above: if `error` were always set, "this target
    // failed" would be true of every target and the composite's failure list
    // would name all six every night.
    const short = await drainPurge(fakeStep([120]).step, 500, NO_DEADLINE);
    expect(short.error).toBeUndefined();

    const capped = await drainPurge(fakeStep(Array(50).fill(500)).step, 500, NO_DEADLINE, 3);
    expect(capped.error).toBeUndefined();
  });

  it("reports NO backlog when the very first batch is short", async () => {
    const fake = fakeStep([0]);

    const result = await drainPurge(fake.step, 500, NO_DEADLINE);

    expect(fake.calls).toEqual([0]);
    expect(result.deleted).toBe(0);
    expect(result.backlogged).toBe(false);
  });

  it("caps the rate-limit drain at a number that fits the cron's real budget", () => {
    // vercel.json gives every app/api/cron/*/route.ts 60 s — NOT Vercel's 300 s
    // default — and app/api/cron/daily/route.ts fans out to ~10 jobs inside a
    // 55 s budget, of which this is one. So the cap is the STATED worst case for
    // one target of one job, and the shared wall-clock deadline is what actually
    // stops a slow run. A cap large enough to eat the whole dispatcher budget
    // would make every job after data_lifecycle "skipped_budget" every night.
    expect(RATE_LIMIT_CLEANUP_MAX_BATCHES).toBeGreaterThanOrEqual(10);
    expect(RATE_LIMIT_CLEANUP_MAX_BATCHES).toBeLessThanOrEqual(60);
  });
});

// ---------------------------------------------------------------------------
// push_subscriptions — the fourth target (RN re-run HIGH, 2026-08-22)
// ---------------------------------------------------------------------------
//
// Revocation is SOFT (revoked_at): the user toggled push off, or the push
// service answered 404/410. The row stays as an auditable trail, and nothing
// ever deleted it — hard deletion existed only through the profiles cascade
// and erase_subject_data(). A revoked row older than the TTL has served its
// purpose. A LIVE row is never pruned on `last_used_at` alone: that column
// means "we last delivered an urgent push here", and a quiet pet's owner can
// go months without one while the browser registration is perfectly valid.
// The push service's 404/410 is the honest staleness signal, and it already
// flips revoked_at — so the revoked path catches abandoned browsers too.

describe("purgeRevokedPushSubscriptions", () => {
  async function insertPush(suffix: string, revokedAt: Date | null): Promise<string> {
    const [row] = await db
      .insert(pushSubscriptions)
      .values({
        userId: testUserId,
        endpoint: `https://push.dlc-test.local/${suffix}-${Date.now()}`,
        p256dh: "p256dh-test",
        auth: "auth-test",
        revokedAt: revokedAt ?? undefined,
      })
      .returning({ id: pushSubscriptions.id });
    return row.id;
  }

  const DAY_MS = 24 * 60 * 60 * 1000;

  it("deletes revoked rows older than the TTL and keeps live and recently-revoked rows", async () => {
    const staleId = await insertPush(
      "stale",
      new Date(Date.now() - (PUSH_SUBSCRIPTION_REVOKED_TTL_DAYS + 1) * DAY_MS),
    );
    const recentId = await insertPush("recent", new Date(Date.now() - 1 * DAY_MS));
    const liveId = await insertPush("live", null);

    const deleted = await purgeRevokedPushSubscriptions();
    expect(deleted).toBeGreaterThanOrEqual(1);

    const remaining = await db
      .select({ id: pushSubscriptions.id })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, testUserId));
    const ids = remaining.map((r) => r.id);
    expect(ids).not.toContain(staleId);
    expect(ids).toContain(recentId);
    // THE POINT: a live registration with no delivery on record is not stale.
    expect(ids).toContain(liveId);
  });

  it("keeps the TTL long enough for the device list to still explain a revocation", () => {
    expect(PUSH_SUBSCRIPTION_REVOKED_TTL_DAYS).toBeGreaterThanOrEqual(14);
    expect(PUSH_SUBSCRIPTION_REVOKED_TTL_DAYS).toBeLessThanOrEqual(90);
  });
});

// ---------------------------------------------------------------------------
// The composite: order, caps and the fair share — driven by FAKE purgers
// ---------------------------------------------------------------------------
//
// Same reasoning as the drainPurge suite: the properties here are arithmetic
// (which target ran first, how many batches each was allowed, how the deadline
// was split), and seeding tens of thousands of rows to prove them would cost
// more than the caps they prove. The real SQL is exercised by the integration
// cases below.

describe("runDataLifecyclePurge — order, caps and fair share (fake purgers)", () => {
  /** A purger that always returns a FULL batch (an endless backlog), counting calls. */
  function endless(batchSize: number, calls: string[], name: string) {
    return async () => {
      calls.push(name);
      return batchSize;
    };
  }

  /** A clock that advances `stepMs` per reading, so each batch "costs" time. */
  function ticking(stepMs: number) {
    let t = 1_000_000;
    return () => {
      const v = t;
      t += stepMs;
      return v;
    };
  }

  it("drains rate_limit_buckets FIRST — the fastest-filling, attacker-influenced table", async () => {
    const calls: string[] = [];
    await runDataLifecyclePurge({
      maxDurationMs: Number.POSITIVE_INFINITY,
      now: ticking(0),
      purgers: {
        rateLimitBuckets: async () => {
          calls.push("rate_limit_buckets");
          return 0;
        },
        notifications: async () => {
          calls.push("notifications");
          return 0;
        },
        pushSubscriptions: async () => {
          calls.push("push_subscriptions");
          return 0;
        },
        pushTargets: async () => {
          calls.push("push_targets");
          return 0;
        },
        cronRuns: async () => {
          calls.push("cron_runs");
          return 0;
        },
        // Stubbed even though this test does not assert on it: the real
        // collector talks to the Storage API, and an ordering test must not
        // delete anybody's object as a side effect.
        stagedUploads: async () => {
          calls.push("staged_uploads");
          return 0;
        },
      },
    });
    expect(calls).toEqual([
      "rate_limit_buckets",
      "notifications",
      "push_subscriptions",
      "push_targets",
      "cron_runs",
      "staged_uploads",
    ]);
  });

  it("caps EVERY target, notifications included, and flags each one that hit its cap", async () => {
    const calls: string[] = [];
    const result = await runDataLifecyclePurge({
      maxDurationMs: Number.POSITIVE_INFINITY,
      now: ticking(0),
      purgers: {
        rateLimitBuckets: endless(500, calls, "b"),
        notifications: endless(500, calls, "n"),
        pushSubscriptions: endless(500, calls, "p"),
        pushTargets: endless(500, calls, "t"),
        orgContactIps: endless(500, calls, "o"),
        cronRuns: endless(500, calls, "c"),
        stagedUploads: endless(STORAGE_GC_BATCH_SIZE, calls, "s"),
      },
    });

    const count = (name: string) => calls.filter((c) => c === name).length;
    expect(count("b")).toBe(RATE_LIMIT_CLEANUP_MAX_BATCHES);
    // THE FIX: notifications used to drain UNCAPPED under the shared deadline,
    // so an expired-notification backlog could eat the whole run before the
    // bucket table — the one that actually fills — got a turn.
    expect(count("n")).toBe(NOTIFICATIONS_CLEANUP_MAX_BATCHES);
    expect(count("p")).toBe(PUSH_SUBSCRIPTIONS_CLEANUP_MAX_BATCHES);
    expect(count("o")).toBe(ORG_CONTACT_IP_CLEANUP_MAX_BATCHES);
    expect(count("c")).toBe(CRON_RUNS_CLEANUP_MAX_BATCHES);
    // THE CAP THIS BRIEF ASKED FOR, proven the same way the five above are:
    // more orphans than the cap allows means the CAP is what comes off, not the
    // backlog. `endless` never returns a short batch, so the only thing that
    // can stop the loop at exactly STORAGE_GC_MAX_BATCHES is the cap.
    expect(count("s")).toBe(STORAGE_GC_MAX_BATCHES);
    expect(result.backlogged).toEqual({
      rateLimitBuckets: true,
      notifications: true,
      pushSubscriptions: true,
      pushTargets: true,
      orgContactIps: true,
      cronRuns: true,
      stagedUploads: true,
    });
    expect(result.notificationsDeleted).toBe(NOTIFICATIONS_CLEANUP_MAX_BATCHES * 500);
    expect(result.stagedUploadsDeleted).toBe(STORAGE_GC_MAX_BATCHES * STORAGE_GC_BATCH_SIZE);
  });

  it("splits the deadline FAIRLY: a backlogged first target cannot starve the ones after it", async () => {
    // 50 s budget, every batch costs 1 s, every target has an endless backlog,
    // caps far above what the budget allows. Under the OLD shared deadline the
    // first target would have run ~50 batches and the other four would have
    // got one batch each (the loop always runs one before checking the
    // clock). Under the fair share each target gets (what is left) / (targets
    // still to run): 10 s, then 10 s, then 10 s, then 10 s, then the rest.
    //
    // THE BUDGET ARGUMENT IS NOT WHAT DECIDES THIS, and the previous version of
    // this comment said it was. It claimed the number "scales with the target
    // count on purpose" — 40 s at four targets, 50 s at five — implying that
    // raising it buys every target more batches. It does not:
    // `runDataLifecyclePurge` takes `Math.min(MAX_DURATION_MS, maxDurationMs)`,
    // so anything at or above 45 s is the SAME run. Measured across 60/72/84/
    // 96/108/120 s: identical counts, every time. The argument is passed as
    // MAX_DURATION_MS now so the test states the budget it actually gets.
    //
    // What the counts therefore show is the real arithmetic of a 45 s ceiling
    // split six ways under a clock that costs 1 s per reading: the first target
    // gets 7 batches and the last gets 3, because each target's share is
    // computed from what is LEFT and the readings themselves spend it. Three is
    // the number the lower bound has to admit — the property is "the last target
    // is not starved down to the one batch the loop always runs", not "every
    // target gets an equal count", and 3 vs 1 is exactly that distinction.
    const calls: string[] = [];
    const result = await runDataLifecyclePurge({
      maxDurationMs: MAX_DURATION_MS,
      now: ticking(1_000),
      purgers: {
        rateLimitBuckets: endless(500, calls, "b"),
        notifications: endless(500, calls, "n"),
        pushSubscriptions: endless(500, calls, "p"),
        pushTargets: endless(500, calls, "t"),
        orgContactIps: endless(500, calls, "o"),
        cronRuns: endless(500, calls, "c"),
        stagedUploads: endless(STORAGE_GC_BATCH_SIZE, calls, "s"),
      },
    });

    const count = (name: string) => calls.filter((c) => c === name).length;
    // THE FLOOR IS PER TARGET, NOT SHARED, and an earlier draft of this loop got
    // that wrong: it dropped every target to `>= 3` because the new sixth one
    // scores 3. That would have let a regression starve rate_limit_buckets —
    // the highest-priority, attacker-influenced table — from 7 batches down to
    // 3 with this test still green, and starvation is the only thing this test
    // exists to catch.
    //
    // A SEVENTH TARGET (push_targets, 2026-09-11) MOVED TWO OF THESE NUMBERS,
    // and the lesson above is why they did not all move together. The same fixed
    // budget now splits seven ways instead of six, so the targets that run LATER
    // clear fewer batches: measured on this fixture, b=6 n=5 p=5 t=5 o=4 c=4 s=2.
    // The four that run first keep the >= 5 they have always had to clear —
    // lowering THEIR floor to accommodate a target added behind them is exactly
    // the regression the paragraph above describes. org_contact_ips and cron_runs
    // get their own honest floor, stated as a smaller number rather than hidden
    // inside a loosened shared one.
    for (const name of ["b", "n", "p", "t"]) {
      expect(count(name)).toBeGreaterThanOrEqual(5);
      expect(count(name)).toBeLessThanOrEqual(15);
    }
    for (const name of ["o", "c"]) {
      expect(count(name)).toBeGreaterThanOrEqual(4);
      expect(count(name)).toBeLessThanOrEqual(15);
    }
    // The storage target runs LAST and its share is what is left after six
    // others have spent theirs, so 2 is the honest floor for it alone — still
    // twice the one batch `drainPurge` always runs, which is the distinction
    // that matters. It was 3 under six targets; the seventh took one from it.
    expect(count("s")).toBeGreaterThanOrEqual(2);
    expect(count("s")).toBeLessThanOrEqual(15);
    expect(result.backlogged.cronRuns).toBe(true);
  });

  it("issues NOTHING when the budget is already spent — every target reports a backlog, no DELETE runs", async () => {
    // A 0 ms budget: every target's fair share is 0, every deadline is its own
    // entry instant, and drainPurge refuses at entry. Until 2026-08-22 this ran
    // one batch per target ("b", "n", "p", "t", "o", "c") — a write per table under a
    // budget the dispatcher had already spent. The zero leftover is handed
    // forward unchanged (0 / targets left is still 0), so the later targets do
    // not inherit a phantom share either.
    const calls: string[] = [];
    const result = await runDataLifecyclePurge({
      maxDurationMs: 0,
      now: ticking(1),
      purgers: {
        rateLimitBuckets: endless(500, calls, "b"),
        notifications: endless(500, calls, "n"),
        pushSubscriptions: endless(500, calls, "p"),
        pushTargets: endless(500, calls, "t"),
        orgContactIps: endless(500, calls, "o"),
        cronRuns: endless(500, calls, "c"),
        stagedUploads: endless(STORAGE_GC_BATCH_SIZE, calls, "s"),
      },
    });
    expect(calls).toEqual([]);
    expect(result.backlogged).toEqual({
      rateLimitBuckets: true,
      notifications: true,
      pushSubscriptions: true,
      pushTargets: true,
      orgContactIps: true,
      cronRuns: true,
      stagedUploads: true,
    });
    expect(result.rateLimitBucketsDeleted + result.notificationsDeleted).toBe(0);
  });

  // -------------------------------------------------------------------------
  // ONE TARGET FAILING MUST NOT ERASE THE OTHER FIVE (2026-09-10)
  //
  // The defect this closes was not a crash — it was a LIE. `runDataLifecyclePurge`
  // ran six targets with no per-target catch, so a throw escaped the composite,
  // the route caught it, and `counts` stayed at its initial all-zeros literal.
  // The targets ahead of the failure had already deleted their rows; the run
  // recorded zero for all six, marked itself failed and paged a human. Nightly,
  // with the cron_runs history quietly wrong about work that really happened.
  //
  // The counts below are ordinary nightly volumes chosen for the SCENARIO, not
  // derived from any constant in the module under test: they only have to be
  // distinct, non-zero and short of a batch, so a target reporting somebody
  // else's number — or its own zero — cannot pass.
  // -------------------------------------------------------------------------

  /** A purger that drains in one short batch, counting its call. */
  function drains(calls: string[], name: string, rows: number) {
    return async () => {
      calls.push(name);
      return rows;
    };
  }

  /** A purger that cannot run at all — the pooler is down, the grant is missing. */
  function throws(calls: string[], name: string, message: string) {
    return async () => {
      calls.push(name);
      throw new Error(message);
    };
  }

  it("isolates a target that THROWS: the ones after it still run, every count stays TRUE, and the failure is NAMED", async () => {
    const calls: string[] = [];
    const result = await runDataLifecyclePurge({
      maxDurationMs: Number.POSITIVE_INFINITY,
      now: ticking(0),
      purgers: {
        rateLimitBuckets: drains(calls, "b", 7),
        notifications: drains(calls, "n", 3),
        // Third of seven: two targets have already deleted rows, four have not
        // run yet. Both halves are what the old behaviour destroyed.
        pushSubscriptions: throws(calls, "p", "pooler down"),
        // Drains normally on purpose. This test asserts that ONE failure is
        // isolated; a second throwing target would prove a different thing.
        pushTargets: drains(calls, "t", 2),
        orgContactIps: drains(calls, "o", 4),
        cronRuns: drains(calls, "c", 1),
        stagedUploads: drains(calls, "s", 6),
      },
    });

    // (1) THE OTHERS RAN. All six were attempted, in order, and the throw at
    // "p" did not take "o", "c" and "s" down with it.
    expect(calls).toEqual(["b", "n", "p", "t", "o", "c", "s"]);

    // (2) THE COUNTS ARE TRUE. Every target that worked reports what it really
    // took off — the two before the failure included, which is precisely what
    // the all-zeros literal used to overwrite.
    expect(result.rateLimitBucketsDeleted).toBe(7);
    expect(result.notificationsDeleted).toBe(3);
    expect(result.orgContactIpsPurged).toBe(4);
    expect(result.cronRunsDeleted).toBe(1);
    expect(result.stagedUploadsDeleted).toBe(6);
    // The one that threw took nothing off, and says so honestly.
    expect(result.pushSubscriptionsDeleted).toBe(0);

    // (3) THE FAILURE IS NAMED, with the target AND the reason. "An error
    // occurred somewhere in a seven-target job" is what this replaces.
    expect(result.failures).toEqual([{ target: "pushSubscriptions", reason: "pooler down" }]);

    // (4) The failed target is BACKLOGGED — its rows are still on the table —
    // and the six that drained are not. A blanket true here would be the same
    // fabricated measurement in the other direction.
    expect(result.backlogged).toEqual({
      rateLimitBuckets: false,
      notifications: false,
      pushSubscriptions: true,
      pushTargets: false,
      orgContactIps: false,
      cronRuns: false,
      stagedUploads: false,
    });
  });

  it("names EVERY target that failed, in run order — a second failure is not swallowed by the first", async () => {
    const calls: string[] = [];
    const result = await runDataLifecyclePurge({
      maxDurationMs: Number.POSITIVE_INFINITY,
      now: ticking(0),
      purgers: {
        rateLimitBuckets: throws(calls, "b", "permission denied for table rate_limit_buckets"),
        notifications: drains(calls, "n", 3),
        pushSubscriptions: drains(calls, "p", 2),
        pushTargets: drains(calls, "t", 2),
        orgContactIps: drains(calls, "o", 4),
        cronRuns: drains(calls, "c", 1),
        stagedUploads: throws(calls, "s", "storage api 503"),
      },
    });

    expect(calls).toEqual(["b", "n", "p", "t", "o", "c", "s"]);
    expect(result.failures).toEqual([
      { target: "rateLimitBuckets", reason: "permission denied for table rate_limit_buckets" },
      { target: "stagedUploads", reason: "storage api 503" },
    ]);
    // The four in between are untouched by either failure.
    expect(result.notificationsDeleted).toBe(3);
    expect(result.pushSubscriptionsDeleted).toBe(2);
    expect(result.orgContactIpsPurged).toBe(4);
    expect(result.cronRunsDeleted).toBe(1);
  });

  it("reports NO failure when all six succeed — the happy path is exactly what it was", async () => {
    // The regression guard for the isolation itself: `failures` must be EMPTY
    // on a clean run, or the route would mark every night failed and page.
    const calls: string[] = [];
    const result = await runDataLifecyclePurge({
      maxDurationMs: Number.POSITIVE_INFINITY,
      now: ticking(0),
      purgers: {
        rateLimitBuckets: drains(calls, "b", 7),
        notifications: drains(calls, "n", 3),
        pushSubscriptions: drains(calls, "p", 2),
        pushTargets: drains(calls, "t", 2),
        orgContactIps: drains(calls, "o", 4),
        cronRuns: drains(calls, "c", 1),
        stagedUploads: drains(calls, "s", 6),
      },
    });

    expect(calls).toEqual(["b", "n", "p", "t", "o", "c", "s"]);
    expect(result.failures).toEqual([]);
    expect(result.backlogged).toEqual({
      rateLimitBuckets: false,
      notifications: false,
      pushSubscriptions: false,
      pushTargets: false,
      orgContactIps: false,
      cronRuns: false,
      stagedUploads: false,
    });
    expect(result.rateLimitBucketsDeleted).toBe(7);
    expect(result.notificationsDeleted).toBe(3);
    expect(result.pushSubscriptionsDeleted).toBe(2);
    expect(result.orgContactIpsPurged).toBe(4);
    expect(result.cronRunsDeleted).toBe(1);
    expect(result.stagedUploadsDeleted).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// org_contact_messages.submitter_ip — the fifth target
// ---------------------------------------------------------------------------
//
// The only target that UPDATEs instead of deleting, and the only one whose
// reason is purely a retention bound rather than table growth: the IP had NO
// READER ANYWHERE (rate limiting lives in rate_limit_buckets) and indefinite
// retention. The MESSAGE must survive — it is the organization's inbox, a
// record of a real conversation — so a purge that took the row would be wrong
// in the other direction.
describe("purgeOldOrgContactIps", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  let orgId: string;

  beforeAll(async () => {
    const [org] = await db
      .insert(organizations)
      .values({
        publicToken: `ORG-DLC-${Date.now().toString(36).toUpperCase()}`,
        legalName: "Refugio Data Lifecycle Test",
        displayName: "Refugio DLC",
        orgType: "shelter",
        email: "refugio-dlc@dim-test.local",
      })
      .returning({ id: organizations.id });
    orgId = org.id;
  });

  afterAll(async () => {
    await db.delete(orgContactMessages).where(eq(orgContactMessages.organizationId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  async function insertMessage(createdAt: Date, ip: string | null): Promise<string> {
    const [row] = await db
      .insert(orgContactMessages)
      .values({
        organizationId: orgId,
        inquirerEmail: "vecino@dim-test.local",
        message: "Hola, quiero saber si puedo colaborar.",
        submitterIp: ip,
        createdAt,
      })
      .returning({ id: orgContactMessages.id });
    return row.id;
  }

  it("nulls the IP past the TTL, keeps a recent one, and never touches the message", async () => {
    const oldId = await insertMessage(
      new Date(Date.now() - (ORG_CONTACT_IP_TTL_DAYS + 1) * DAY_MS),
      "203.0.113.7",
    );
    const freshId = await insertMessage(new Date(Date.now() - DAY_MS), "203.0.113.8");

    const purged = await purgeOldOrgContactIps();
    expect(purged).toBeGreaterThanOrEqual(1);

    const rows = await db
      .select({
        id: orgContactMessages.id,
        submitterIp: orgContactMessages.submitterIp,
        message: orgContactMessages.message,
      })
      .from(orgContactMessages)
      .where(eq(orgContactMessages.organizationId, orgId));

    const old = rows.find((r) => r.id === oldId);
    const fresh = rows.find((r) => r.id === freshId);
    expect(old?.submitterIp).toBeNull();
    expect(fresh?.submitterIp).toBe("203.0.113.8");
    // THE HALF THAT MUST SURVIVE. Nulling the message here would delete an
    // organization's record of a conversation somebody had with them; the
    // subject's own copy is redacted by erase_subject_data when they ask.
    expect(old?.message).toBe("Hola, quiero saber si puedo colaborar.");
  });

  it("CONVERGES: a second pass finds nothing, because already-null rows are excluded", async () => {
    await insertMessage(
      new Date(Date.now() - (ORG_CONTACT_IP_TTL_DAYS + 2) * DAY_MS),
      "203.0.113.9",
    );
    await purgeOldOrgContactIps();
    // Without `submitter_ip IS NOT NULL` in the predicate every batch would
    // re-select the same nulled rows, drainPurge would never see a short batch,
    // and the composite would report a permanent phantom backlog.
    expect(await purgeOldOrgContactIps()).toBe(0);
  });
});

describe("runDataLifecyclePurge", () => {
  it("returns counts for all five sections", async () => {
    // Seed one expired row in each category.
    await insertNotification(new Date(Date.now() - 1000));
    await insertBucket(`dlc_test_composite_${Date.now()}`, new Date(Date.now() - 1000));
    await insertCronRun(
      new Date(Date.now() - (CRON_RUNS_TTL_DAYS + 1) * 24 * 60 * 60 * 1000),
      "ok",
    );
    await db.insert(pushSubscriptions).values({
      userId: testUserId,
      endpoint: `https://push.dlc-test.local/composite-${Date.now()}`,
      p256dh: "p256dh-test",
      auth: "auth-test",
      revokedAt: new Date(
        Date.now() - (PUSH_SUBSCRIPTION_REVOKED_TTL_DAYS + 1) * 24 * 60 * 60 * 1000,
      ),
    });

    const result = await runDataLifecyclePurge();

    expect(result).toHaveProperty("notificationsDeleted");
    expect(result).toHaveProperty("rateLimitBucketsDeleted");
    expect(result).toHaveProperty("cronRunsDeleted");
    expect(result).toHaveProperty("pushSubscriptionsDeleted");
    expect(result).toHaveProperty("orgContactIpsPurged");
    expect(result.notificationsDeleted).toBeGreaterThanOrEqual(1);
    expect(result.rateLimitBucketsDeleted).toBeGreaterThanOrEqual(1);
    expect(result.cronRunsDeleted).toBeGreaterThanOrEqual(1);
    expect(result.pushSubscriptionsDeleted).toBeGreaterThanOrEqual(1);
  });

  it("reports per-target backlog so a run that ran out of budget says so", async () => {
    await insertBucket(`dlc_test_backlog_${Date.now()}`, new Date(Date.now() - 1000));

    const result = await runDataLifecyclePurge();

    // The shape, not the value: on a dev DB the six targets drain in one
    // batch each, so all six read false. What must exist is the CHANNEL — a
    // cron row that can only say "N deleted" cannot distinguish a finished
    // purge from one that stopped at the cap on a table still filling up.
    expect(result.backlogged).toEqual({
      notifications: expect.any(Boolean),
      rateLimitBuckets: expect.any(Boolean),
      cronRuns: expect.any(Boolean),
      pushSubscriptions: expect.any(Boolean),
      pushTargets: expect.any(Boolean),
      orgContactIps: expect.any(Boolean),
      stagedUploads: expect.any(Boolean),
    });
  });
});

// ---------------------------------------------------------------------------
// uploads-staging — the sixth target, and the first thing in this repo that
// deletes an OBJECT rather than a row
// ---------------------------------------------------------------------------
//
// These run against the real local Storage service and the real
// `storage.objects` table, because the only interesting properties here are the
// ones a mock would decide for us: what the age predicate does AT ITS BOUNDARY,
// and whether a row somebody planted can save an object from deletion.
//
// EVERY OBJECT THESE TESTS CREATE LIVES UNDER ONE PREFIX and is removed in
// afterAll whether the assertions passed or not. Nothing here may touch an
// object it did not upload — this is the one suite in the file whose subject is
// the deletion of user data.
//
// KNOW THE BLAST RADIUS BEFORE RUNNING THIS AGAINST ANYTHING BUT LOCAL. The
// four DB-backed tests call `purgeAbandonedStagedUploads()` UNMODIFIED, which is
// the point — the subject under test is the real collector — but it means each
// call deletes EVERY qualifying object in whatever database `DATABASE_URL`
// happens to name, not only the ones this suite staged. The cleanup above is
// about not leaving litter; it is not a containment boundary, and there is no
// way to have one while still testing the real function. This repo's own notes
// record that staging env files are routinely half-loaded, so check what
// `DATABASE_URL` points at before running this suite anywhere but locally.
describe("purgeAbandonedStagedUploads — the uploads-staging collector", () => {
  // A pet-id-shaped prefix, matching `stagedKeyFor`'s `{petId}/{uuid}.{ext}`.
  // It is deliberately NOT a real pet id: the collector never resolves the
  // prefix, and borrowing a real one would put test objects under a real
  // animal's key space.
  const PREFIX = "00000000-0000-4000-8000-00000000f00d";
  const admin = createAdminClient();

  /** SOI + DQT — enough bytes for the bucket's declared image/jpeg allow-list. */
  const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);

  const staged: string[] = [];

  /** Uploads one object into uploads-staging and remembers it for cleanup. */
  async function stage(): Promise<string> {
    const name = `${PREFIX}/${randomUUID()}.jpg`;
    const { error } = await admin.storage
      .from(STAGING_BUCKET)
      .upload(name, TINY_JPEG, { contentType: "image/jpeg" });
    if (error) throw new Error(`stage(${name}): ${error.message}`);
    staged.push(name);
    return name;
  }

  /**
   * Moves objects' `created_at` back by a SQL interval.
   *
   * THE INTERVAL IS EVALUATED BY POSTGRES, and every age assertion below is
   * therefore expressed entirely in database time. A test that read `new Date()`
   * in Node and compared it against a column the database wrote is the exact
   * shape of failure this repo has already paid for once, when a Docker VM's
   * clock drifted behind the host and a correct tree went red.
   *
   * The name list is an explicit `IN` of one placeholder per name rather than
   * `= ANY(${names})`: drizzle expands a JS array inside a `sql` template into a
   * PARENTHESISED TUPLE, not a Postgres array, so `ANY` rejects it with
   * "requires array on right side". A tuple is exactly what `IN` wants.
   */
  async function backdate(names: string[], interval: string): Promise<void> {
    const list = sql.join(
      names.map((n) => sql`${n}`),
      sql`, `,
    );
    await db.execute(sql`
      UPDATE storage.objects
         SET created_at = now() - ${interval}::interval
       WHERE bucket_id = ${STAGING_BUCKET}
         AND name IN (${list})
    `);
  }

  /** Does the object store still hold this key? */
  async function exists(name: string): Promise<boolean> {
    const rows = (await db.execute(sql`
      SELECT 1 AS hit FROM storage.objects
       WHERE bucket_id = ${STAGING_BUCKET} AND name = ${name}
    `)) as Array<{ hit: number }>;
    return rows.length > 0;
  }

  // THE FIXTURE AGES ARE INDEPENDENT OF THE CONSTANT UNDER TEST, and an earlier
  // draft made them `MIN_AGE ± 1 hour` — which is the "never assert a value
  // against the function that produced it" rule broken in its subtlest form.
  // Mutation testing proved it: setting the minimum age to ZERO left all 26
  // tests green, because a fixture defined as `MIN_AGE - 1 hour` became a
  // NEGATIVE interval, placing the object an hour in the FUTURE, where no
  // predicate would collect it. The guard was mutated away and its own test
  // followed it down.
  //
  // Both ages are now literals derived from the DOMAIN, not from the code:
  /**
   * The scenario that sets the collector's floor: somebody picks a tattoo photo
   * in `RecordEventScreen` (which uploads at PICK time), is interrupted, and
   * comes back the next day to finish the asiento. Twenty-six hours is past any
   * round number a collector might have been given and still a live flow.
   */
  const INTERRUPTED_ASIENTO = "26 hours";
  /** Long past any flow at all — the unambiguous abandoned case. */
  const LONG_ABANDONED = "30 days";

  // The independent requirement the constant has to meet, asserted as a
  // requirement rather than restated as a value. This is NOT circular: it
  // compares the configured window against a scenario derived from
  // `RecordEventScreen`, so lowering the constant below the interrupted-asiento
  // case fails HERE, loudly, instead of silently narrowing the test below.
  it("grants a window wider than the interrupted-asiento flow", () => {
    expect(ABANDONED_STAGED_UPLOAD_MIN_AGE_MS).toBeGreaterThan(26 * 60 * 60 * 1000);
  });

  afterAll(async () => {
    // Cleaning up after a suite that deletes user data is not optional, and it
    // runs over the objects THIS suite uploaded — never over the bucket.
    if (staged.length > 0) {
      await admin.storage
        .from(STAGING_BUCKET)
        .remove(staged)
        .catch(() => {});
    }
    await db
      .delete(attachments)
      .where(like(attachments.storagePath, `${PREFIX}/%`))
      .catch(() => {});
  });

  it("collects an orphan older than the minimum age", async () => {
    const name = await stage();
    await backdate([name], LONG_ABANDONED);

    // The PRESENCE assertion this test rests on: the collector's own candidate
    // query names this object. Asserting only that it was gone afterwards would
    // pass just as well if something unrelated had taken it.
    expect(await listAbandonedStagedObjects(STORAGE_GC_BATCH_SIZE)).toContain(name);

    const deleted = await purgeAbandonedStagedUploads();
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(await exists(name)).toBe(false);
  });

  it("does NOT collect an orphan younger than the minimum age — the live-upload guard", async () => {
    // THE TEST THAT PROTECTS SOMEBODY MID-UPLOAD. A staged object is
    // unreferenced BY DESIGN for the whole window between the ticket being
    // minted and the confirm landing, so "no row points at it" is not on its own
    // a reason to delete anything here — the age is. This object sits one hour
    // INSIDE the window, which makes it the BOUNDARY case rather than a
    // brand-new upload that any predicate at all would spare.
    const name = await stage();
    await backdate([name], INTERRUPTED_ASIENTO);

    expect(await listAbandonedStagedObjects(STORAGE_GC_BATCH_SIZE)).not.toContain(name);

    await purgeAbandonedStagedUploads();

    // The object is STILL THERE — the property under test, stated as presence.
    expect(await exists(name)).toBe(true);
  });

  it("does NOT collect a referenced object, however old it is", async () => {
    const name = await stage();
    await backdate([name], LONG_ABANDONED);

    // A PARENTLESS `attachments` ROW IS NOT A CONTRIVANCE — it is the transient
    // state `db/schema.ts` declares legal on purpose: "uploadRevocationEvidence
    // stages the row before claimAttachmentsForAudit claims it inside the
    // revocation transaction". A row with no pet, no event and no audit entry is
    // therefore exactly what a live evidence upload looks like mid-flight, and
    // it is the row a collector that only checked PARENTS would step over on its
    // way to deleting the object.
    await db.insert(attachments).values({
      storagePath: name,
      mimeType: "image/jpeg",
      fileSize: TINY_JPEG.byteLength,
    });

    expect(await listAbandonedStagedObjects(STORAGE_GC_BATCH_SIZE)).not.toContain(name);

    await purgeAbandonedStagedUploads();

    expect(await exists(name)).toBe(true);
  });

  it("takes AT MOST one batch per call, and repeated calls finish the backlog", async () => {
    // More orphans than the cap admits, so the CAP — not the backlog — is what
    // decides the first call. Uploaded concurrently because this is a hundred
    // and five HTTP round trips to the local Storage service.
    const overCap = STORAGE_GC_BATCH_SIZE + 5;
    const names = await Promise.all(Array.from({ length: overCap }, () => stage()));
    await backdate(names, LONG_ABANDONED);

    // THE CAP. Exactly a batch, never the whole backlog. This one CAN be an
    // exact equality: the cap is a ceiling the code itself applies, and there
    // are demonstrably more than STORAGE_GC_BATCH_SIZE candidates behind it.
    const first = await purgeAbandonedStagedUploads();
    expect(first).toBe(STORAGE_GC_BATCH_SIZE);

    // THE DRAIN, asserted as CONVERGENCE rather than as an exact residual.
    //
    // This used to say `second === overCap - STORAGE_GC_BATCH_SIZE`, and that is
    // NOT a property of the code — it is a property of the bucket holding no
    // other old orphan. Mutation testing is what exposed it: breaking the
    // reference guard made a sibling test abort mid-way, leaving one old object
    // behind, and this line then read 6 where it demanded 5. It was reporting a
    // neighbour's leftovers as this function's bug.
    //
    // What the code actually promises is what is asserted now: every call takes
    // at most a batch, repeated calls finish the backlog, and the sequence ENDS
    // at zero. A short batch is the only proof the backlog is gone — the same
    // signal `drainPurge` reads.
    let total = first;
    let last = first;
    let calls = 1;
    while (last > 0) {
      last = await purgeAbandonedStagedUploads();
      expect(last).toBeLessThanOrEqual(STORAGE_GC_BATCH_SIZE);
      total += last;
      calls += 1;
      // The loop must terminate because the backlog SHRINKS, not because a
      // guard rescued it. A runaway here is a convergence bug worth failing on.
      expect(calls).toBeLessThan(20);
    }

    // Everything this test staged came off, and the last call found nothing.
    expect(total).toBeGreaterThanOrEqual(overCap);
    expect(last).toBe(0);
    expect(calls).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it("drains under drainPurge and REPORTS that it finished", async () => {
    const names = await Promise.all([stage(), stage(), stage()]);
    await backdate(names, LONG_ABANDONED);

    // The same drain the composite runs, with a deadline far enough out that the
    // BACKLOG is what ends the loop rather than the clock. `backlogged: false`
    // is the assertion that matters: a count alone cannot tell a finished purge
    // from one that stopped at its cap on a bucket still filling up.
    const outcome = await drainPurge(
      purgeAbandonedStagedUploads,
      STORAGE_GC_BATCH_SIZE,
      Date.now() + 30_000,
      STORAGE_GC_MAX_BATCHES,
    );

    expect(outcome.deleted).toBeGreaterThanOrEqual(names.length);
    expect(outcome.batches).toBeGreaterThanOrEqual(1);
    expect(outcome.backlogged).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The collector's FAILURE branches — the half the suite above cannot see
// ---------------------------------------------------------------------------
//
// Everything in the describe above is happy path, age guard and cap: it proves
// what the collector does when it WORKS. Nothing exercised either way it can
// break, and that gap had a measurable shape — restoring the old
// `catch { return 0 }` swallow killed ZERO tests.
//
// That is the exact false-green this repo has been bitten by. `drainPurge`
// reads a 0 as a SHORT BATCH (data-lifecycle.ts: `if (batch < batchSize)
// return { ..., backlogged: false }`), i.e. "the bucket is drained, nothing
// left". So a collector that swallows its errors and answers 0 closes the run
// GREEN, every night, while the bucket fills forever — and somebody six months
// from now, reading "an error is zero, not a throw" in the git history and
// wanting to quiet a noisy page, can restore that swallow with the whole suite
// still passing. These two tests are what stops them.
//
// DB-less and Storage-less on purpose: both branches are about what the
// function does with an answer it was GIVEN, so the answer is injected. The
// module is re-imported over mocked dependencies inside each test and unmocked
// afterwards, which leaves the statically-imported bindings the rest of this
// file uses untouched.
describe("purgeAbandonedStagedUploads — an error must THROW, never read as a drained bucket", () => {
  afterEach(() => {
    vi.doUnmock("@/lib/supabase/admin");
    vi.doUnmock("@/db");
    vi.resetModules();
  });

  type RemoveAnswer = { data: { name: string }[] | null; error: { message: string } | null };

  /**
   * A fresh `purgeAbandonedStagedUploads` over an injected listing and an
   * injected `remove()`.
   *
   * `db.execute` IS the listing: `listAbandonedStagedObjects` is a raw
   * `db.execute` against the `storage` schema and returns its rows directly.
   */
  async function loadCollector(opts: {
    list: () => Promise<{ name: string }[]>;
    remove?: () => Promise<RemoveAnswer>;
  }) {
    vi.resetModules();
    vi.doMock("@/db", () => ({ db: { execute: opts.list } }));
    vi.doMock("@/lib/supabase/admin", () => ({
      createAdminClient: () => ({
        storage: {
          from: () => ({
            remove: opts.remove ?? (async (): Promise<RemoveAnswer> => ({ data: [], error: null })),
          }),
        },
      }),
    }));
    return (await import("@/lib/infra/storage-gc")).purgeAbandonedStagedUploads;
  }

  it("THROWS when the Storage API refuses the batch — a refused removal is not an empty bucket", async () => {
    // `remove()` does not throw; it answers `{ data, error }`. That branch used
    // to log and return 0, which `drainPurge` reads as "drained".
    const collect = await loadCollector({
      list: async () => [{ name: "pet/abandoned.jpg" }],
      remove: async () => ({ data: null, error: { message: "storage api 503" } }),
    });

    await expect(collect()).rejects.toThrow("storage api 503");
  });

  it("THROWS when the cross-schema listing fails — a collector that cannot LOOK has not looked", async () => {
    // `listAbandonedStagedObjects` is the one runtime read in this repo against
    // the `storage` schema. A production role without SELECT on
    // `storage.objects` breaks here on the very first night, and reporting that
    // as "no orphans" is how the bucket grows forever under a green cron.
    const collect = await loadCollector({
      list: async () => {
        throw new Error("permission denied for schema storage");
      },
    });

    await expect(collect()).rejects.toThrow("permission denied for schema storage");
  });

  it("returns the count Storage confirmed when nothing failed — the harness can answer normally", async () => {
    // NON-VACUITY for the two above: if this rig made every call reject, the
    // `rejects.toThrow` assertions would pass against a broken harness rather
    // than against the branches they name.
    const collect = await loadCollector({
      list: async () => [{ name: "pet/a.jpg" }, { name: "pet/b.jpg" }],
      remove: async () => ({ data: [{ name: "pet/a.jpg" }, { name: "pet/b.jpg" }], error: null }),
    });

    await expect(collect()).resolves.toBe(2);
  });
});

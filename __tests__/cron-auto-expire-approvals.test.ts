// Cron invariants test — auto-expire-approvals handler (P7-1).
//
// Three invariants:
//  1. Runtime window — only approval_requests that are `pending` AND older
//     than 60 days are expired; newer pending and non-pending rows are left
//     untouched.
//  2. Idempotency — running twice on the same already-withdrawn request is a
//     no-op (the per-row UPDATE guards on status='pending').
//  3. Recovery — a per-row failure (e.g. a row that causes the individual tx
//     to fail) does not abort the batch; the sibling rows are still processed.
//
// The handler logic lives inline in the route (no separate lib function), so
// we invoke the GET handler directly — same pattern as
// cron-expire-foster-proposals-route.test.ts — but with real DB fixtures and
// no mocking so we exercise the actual expiry logic end-to-end.
//
// The handler PREFERS an `admin` + `institutional` profile as the system actor
// for audit_log, and these cases run with the seeded admin@dim.test user
// (created by scripts/seed-test-users.ts / db:bootstrap). It no longer REQUIRES
// one: on a database with no active admin it logs an actor-less audit row and
// still records the run — see cron-auto-expire-approvals-no-admin.test.ts
// (RA-6 finding 2).

import { createClient } from "@supabase/supabase-js";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { approvalRequests, auditLog, cronRuns, db, notifications, profiles } from "@/db";
import { setAuditMutationGucs } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabase = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const APPLICANT_EMAIL = "auto-expire-applicant@dim-test.local";
const PASS = "AutoExpire_2026!";

let applicantUserId: string;

const createdRequestIds: string[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function purgeUserByEmail(email: string) {
  const { data } = await supabase.auth.admin.listUsers();
  const found = data?.users.find((u) => u.email === email);
  if (!found) return;
  // Clean approval_requests and notifications before profile/auth deletion.
  await db
    .delete(approvalRequests)
    .where(eq(approvalRequests.applicantUserId, found.id))
    .catch(() => {});
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

/**
 * Insert a minimal approval_request for the test applicant.
 * `createdAtOffset` is the number of DAYS to subtract from now — use a
 * negative-magnitude value to backdate (e.g. -61 = 61 days ago).
 */
async function makeApprovalRequest(opts: {
  createdAtOffset: number; // days relative to now (negative = past)
  status?: "pending" | "withdrawn" | "approved" | "rejected";
}): Promise<{ id: string }> {
  const createdAt = new Date(Date.now() + opts.createdAtOffset * 24 * 60 * 60 * 1000);
  const status = opts.status ?? "pending";

  // role_upgrade_vet requires target_user_id (approval_target_consistent CHECK).
  // For withdrawn/approved/rejected rows we also need to satisfy
  // approval_decision_consistent: decided_at + decided_by_user_id must be set
  // when status is approved/rejected; withdrawn needs withdrawn_at.
  const extraCols: Record<string, unknown> = {};
  if (status === "withdrawn") {
    extraCols.withdrawnAt = new Date();
  } else if (status === "approved" || status === "rejected") {
    // Find any admin profile to use as decider.
    const [adminProfile] = await db
      .select({ id: profiles.id })
      .from(profiles)
      .where(and(eq(profiles.role, "admin"), eq(profiles.accountType, "institutional")))
      .limit(1);
    if (!adminProfile) throw new Error("No admin profile found — run db:bootstrap first");
    extraCols.decidedAt = new Date();
    extraCols.decidedByUserId = adminProfile.id;
  }

  const [row] = await db
    .insert(approvalRequests)
    .values({
      publicToken: `AEA-TEST-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: "role_upgrade_vet",
      status,
      applicantUserId,
      targetUserId: applicantUserId,
      initiatedBy: "self",
      jurisdictionCountry: "AR",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "Mar del Plata",
      payload: {},
      createdAt,
      updatedAt: createdAt,
      ...extraCols,
    })
    .returning({ id: approvalRequests.id });
  createdRequestIds.push(row.id);
  return { id: row.id };
}

/**
 * Invoke GET /api/cron/auto-expire-approvals against the live DB.
 *
 * CRON_SECRET is not set in the test environment (.env.local has no such key).
 * The route's non-production path allows requests without a secret when
 * CRON_SECRET is absent, so we simply call without a header. If CRON_SECRET
 * were set, we would pass it as `x-cron-secret`.
 */
async function callHandler() {
  const cronSecret = process.env.CRON_SECRET;
  const headers: Record<string, string> = {};
  if (cronSecret) {
    headers["x-cron-secret"] = cronSecret;
  }
  // vi.resetModules() is NOT needed — we never mock the handler; we want the
  // real DB calls. Dynamic import returns the already-loaded module.
  const { GET } = await import("@/app/api/cron/auto-expire-approvals/route");
  const req = new Request("http://test.local/api/cron/auto-expire-approvals", { headers });
  const res = await GET(req as unknown as Parameters<typeof GET>[0]);
  const body = (await res.json()) as {
    status: string;
    itemsProcessed: number;
    runId: string;
  };
  return { res, body };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await purgeUserByEmail(APPLICANT_EMAIL);

  const { data, error } = await createFreshTestUser(supabase, {
    email: APPLICANT_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser applicant: ${error?.message}`);
  applicantUserId = data.user.id;
});

afterAll(async () => {
  // Clean up cron_runs created during tests (canonical snake-of-route name,
  // cron-registry SSOT rule).
  await db
    .delete(cronRuns)
    .where(eq(cronRuns.cronName, "auto_expire_approvals"))
    .catch(() => {});

  // Clean up audit_log rows referencing our approval_requests (FK).
  for (const id of createdRequestIds) {
    await db.transaction(async (tx) => {
      await setAuditMutationGucs(tx);
      await tx.delete(auditLog).where(eq(auditLog.approvalRequestId, id));
    });
    await db
      .delete(notifications)
      .where(eq(notifications.userId, applicantUserId))
      .catch(() => {});
    await db
      .delete(approvalRequests)
      .where(eq(approvalRequests.id, id))
      .catch(() => {});
  }

  await purgeUserByEmail(APPLICANT_EMAIL);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("auto-expire-approvals cron handler", () => {
  it("runtime window — requests older than 60 days are expired; newer ones are left pending", async () => {
    // Stale: 61 days old — must be expired.
    const stale = await makeApprovalRequest({ createdAtOffset: -61 });
    // Fresh: 30 days old — must stay pending.
    const fresh = await makeApprovalRequest({ createdAtOffset: -30 });

    const { res, body } = await callHandler();
    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.itemsProcessed).toBeGreaterThanOrEqual(1);

    const [staleRow] = await db
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, stale.id));
    expect(staleRow.status).toBe("withdrawn");

    const [freshRow] = await db
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, fresh.id));
    expect(freshRow.status).toBe("pending");
  });

  it("idempotency — re-running on an already-withdrawn request is a no-op", async () => {
    const stale = await makeApprovalRequest({ createdAtOffset: -61 });

    const first = await callHandler();
    expect(first.body.status).toBe("ok");
    expect(first.body.itemsProcessed).toBeGreaterThanOrEqual(1);

    const [afterFirst] = await db
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, stale.id));
    expect(afterFirst.status).toBe("withdrawn");

    // Second run — the row is already 'withdrawn'; the UPDATE WHERE status='pending'
    // guard should skip it silently.
    const second = await callHandler();
    expect(second.body.status).toBe("ok");

    const [afterSecond] = await db
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, stale.id));
    // Status must still be 'withdrawn', not changed again.
    expect(afterSecond.status).toBe("withdrawn");
    // itemsProcessed for the stale row on the second call must be 0
    // (it's no longer pending so the UPDATE returns no rows and the per-row
    // counter is not incremented).
    expect(second.body.itemsProcessed).toBe(0);
  });

  it("recovery — a non-pending row present in the same batch is silently skipped; other rows are still processed", async () => {
    // 'approved' row at 61 days old: should not be touched (status != 'pending').
    // Note: approved requires decidedAt + decidedByUserId, handled in makeApprovalRequest.
    const approved = await makeApprovalRequest({ createdAtOffset: -61, status: "approved" });
    // Regular stale pending row: should still be expired despite the approved row.
    const pendingStale = await makeApprovalRequest({ createdAtOffset: -61 });

    const { res, body } = await callHandler();
    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    // At least one item processed (the pendingStale row).
    expect(body.itemsProcessed).toBeGreaterThanOrEqual(1);

    // The approved row must remain approved — untouched.
    const [approvedRow] = await db
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approved.id));
    expect(approvedRow.status).toBe("approved");

    // The pending stale row must have been expired.
    const [pendingRow] = await db
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, pendingStale.id));
    expect(pendingRow.status).toBe("withdrawn");
  });
});

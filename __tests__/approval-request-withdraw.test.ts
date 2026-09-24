// Integration tests for Slice 3b: withdrawApprovalRequestAction — applicant
// self-service withdrawal of a pending approval request.
//
// Pattern mirrors profile.test.ts:
//   - beforeAll seeds an ephemeral actor user (the applicant) and a second user
//     (used to verify the capability-rejection path)
//   - afterAll deletes both with app.allow_audit_mutation GUC
//   - Tests call the inner withdrawApprovalRequestForUser writer directly

import { createClient } from "@supabase/supabase-js";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { approvalRequests, auditLog, db, profiles } from "@/db";
import { withdrawApprovalRequestForUser } from "@/src/modules/organizations/application/approval-requests/withdraw-approval-request";
import { setAuditMutationGucs } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const adminSdk = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const ACTOR_EMAIL = "withdraw-actor@dim-test.local";
const OTHER_EMAIL = "withdraw-other@dim-test.local";
let actorUserId: string;
let otherUserId: string;
let pendingRequestId: string;
let approvedRequestId: string;

async function deleteTestUser(email: string) {
  const { data: list } = await adminSdk.auth.admin.listUsers({ perPage: 200 });
  const found = list?.users.find((u) => u.email === email);
  if (!found) return;

  await db.transaction(async (tx) => {
    await setAuditMutationGucs(tx);
    await tx.delete(auditLog).where(eq(auditLog.actorUserId, found.id));
    await tx.delete(auditLog).where(eq(auditLog.targetUserId, found.id));
  });
  await db.delete(approvalRequests).where(eq(approvalRequests.applicantUserId, found.id));
  await db.delete(profiles).where(eq(profiles.id, found.id));
  await adminSdk.auth.admin.deleteUser(found.id);
}

async function createUserOrThrow(email: string): Promise<string> {
  const r = await createFreshTestUser(adminSdk, {
    email,
    password: "WithdrawSlice3b_2026!",
    email_confirm: true,
  });
  if (r.error || !r.data.user) throw new Error(`createUser(${email}): ${r.error?.message}`);
  return r.data.user.id;
}

beforeAll(async () => {
  await deleteTestUser(ACTOR_EMAIL);
  await deleteTestUser(OTHER_EMAIL);

  actorUserId = await createUserOrThrow(ACTOR_EMAIL);
  otherUserId = await createUserOrThrow(OTHER_EMAIL);

  // role_upgrade_vet requires target_user_id per approval_target_consistent check constraint
  const sharedBase = {
    type: "role_upgrade_vet" as const,
    applicantUserId: actorUserId,
    targetUserId: actorUserId,
    initiatedBy: "self" as const,
    jurisdictionCountry: "AR",
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "CABA",
    payload: {},
  };

  // Seed a pending request owned by the actor
  const [pendingRow] = await db
    .insert(approvalRequests)
    .values({
      publicToken: `TEST-PEND-${Date.now()}`,
      status: "pending",
      ...sharedBase,
    })
    .returning({ id: approvalRequests.id });
  pendingRequestId = pendingRow.id;

  // Seed an already-approved request owned by the actor.
  // approval_decision_consistent: approved requires decided_at + decided_by_user_id.
  const [approvedRow] = await db
    .insert(approvalRequests)
    .values({
      publicToken: `TEST-APPR-${Date.now()}`,
      status: "approved",
      decidedAt: new Date(),
      decidedByUserId: actorUserId,
      ...sharedBase,
    })
    .returning({ id: approvalRequests.id });
  approvedRequestId = approvedRow.id;
});

afterAll(async () => {
  await deleteTestUser(ACTOR_EMAIL);
  await deleteTestUser(OTHER_EMAIL);
});

// ============================================================================
// Happy path
// ============================================================================

describe("withdrawApprovalRequestForUser — happy path", () => {
  it("transitions pending → withdrawn and emits audit_log entry", async () => {
    const result = await withdrawApprovalRequestForUser(actorUserId, pendingRequestId);

    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(result.ok).toBe(true);

    // Status flipped to 'withdrawn' and withdrawnAt is stamped
    const [row] = await db
      .select({ status: approvalRequests.status, withdrawnAt: approvalRequests.withdrawnAt })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, pendingRequestId))
      .limit(1);

    expect(row.status).toBe("withdrawn");
    expect(row.withdrawnAt).not.toBeNull();

    // Audit log written
    const [logRow] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actorUserId, actorUserId),
          eq(auditLog.action, "approval_request_withdrawn_by_applicant"),
        ),
      )
      .orderBy(desc(auditLog.performedAt))
      .limit(1);

    expect(logRow).toBeDefined();
    expect(logRow.approvalRequestId).toBe(pendingRequestId);
  });
});

// ============================================================================
// Capability rejection — other user cannot withdraw
// ============================================================================

describe("withdrawApprovalRequestForUser — capability rejection", () => {
  it("rejects when caller is not the applicant", async () => {
    // Seed a fresh pending request for the actor so otherUserId cannot touch it.
    // role_upgrade_vet requires target_user_id per approval_target_consistent constraint.
    const [freshRow] = await db
      .insert(approvalRequests)
      .values({
        publicToken: `TEST-OWNR-${Date.now()}`,
        type: "role_upgrade_vet",
        status: "pending",
        applicantUserId: actorUserId,
        targetUserId: actorUserId,
        initiatedBy: "self",
        jurisdictionCountry: "AR",
        jurisdictionProvince: "Buenos Aires",
        jurisdictionLocality: "CABA",
        payload: {},
      })
      .returning({ id: approvalRequests.id });

    const result = await withdrawApprovalRequestForUser(otherUserId, freshRow.id);

    expect(result).toHaveProperty("error");
    if (!("error" in result)) return;
    expect(result.error).toMatch(/FORBIDDEN/);

    // Status must be untouched
    const [row] = await db
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, freshRow.id))
      .limit(1);
    expect(row.status).toBe("pending");
  });
});

// ============================================================================
// Validation rejection — already-decided request cannot be withdrawn
// ============================================================================

describe("withdrawApprovalRequestForUser — validation rejection", () => {
  it("rejects when request is already approved (not pending)", async () => {
    const result = await withdrawApprovalRequestForUser(actorUserId, approvedRequestId);

    expect(result).toHaveProperty("error");
    if (!("error" in result)) return;
    expect(result.error).toMatch(/NOT_PENDING/);
  });

  it("rejects when requestId does not exist", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000099";
    const result = await withdrawApprovalRequestForUser(actorUserId, fakeId);

    expect(result).toHaveProperty("error");
    if (!("error" in result)) return;
    expect(result.error).toMatch(/NOT_FOUND/);
  });
});

// AC1 integration tests — deactivated authorities cannot drive admin-proposals.
//
// The shared /gob guard (requireAdminOrGovtOrRedirect) now rejects deactivated
// govt/admin accounts, and loadActorAuthority mirrors that at the data layer so
// the inner writer is safe even when reached directly. These tests exercise the
// inner writer proposeVetUpgradeForUser with a deactivated govt, a deactivated
// admin, and an active admin control.
//
// Pattern mirrors __tests__/admin-institutional.test.ts:
//   - beforeAll seeds ephemeral users via the supabase admin SDK
//   - afterAll deletes them with app.allow_audit_mutation GUC
//   - each test calls the inner *ForUser writer directly (no Next.js runtime)

import { createClient } from "@supabase/supabase-js";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { approvalRequests, auditLog, db, notifications, profiles } from "@/db";
import { proposeVetUpgradeForUser } from "@/src/modules/organizations/application/admin-proposals/propose-vet-upgrade";
import { setAuditMutationGucs } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const adminSdk = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const ACTIVE_ADMIN_EMAIL = "ac1-active-admin@dim-test.local";
const DEACTIVATED_ADMIN_EMAIL = "ac1-deactivated-admin@dim-test.local";
const DEACTIVATED_GOVT_EMAIL = "ac1-deactivated-govt@dim-test.local";
const TARGET_OWNER_EMAIL = "ac1-target-owner@dim-test.local";

let activeAdminId: string;
let deactivatedAdminId: string;
let deactivatedGovtId: string;
let targetOwnerId: string;

const seededEmails = [
  ACTIVE_ADMIN_EMAIL,
  DEACTIVATED_ADMIN_EMAIL,
  DEACTIVATED_GOVT_EMAIL,
  TARGET_OWNER_EMAIL,
];

async function deleteTestUser(email: string) {
  const { data: list } = await adminSdk.auth.admin.listUsers({ perPage: 200 });
  const found = list?.users.find((u) => u.email === email);

  const displayName = email.split("@")[0];
  const orphansByName = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.displayName, displayName));
  const orphansByAuthId = found
    ? await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.id, found.id))
    : [];

  const allIds = new Set([...orphansByName.map((p) => p.id), ...orphansByAuthId.map((p) => p.id)]);

  for (const uid of allIds) {
    await db.transaction(async (tx) => {
      await setAuditMutationGucs(tx);
      await tx.delete(auditLog).where(eq(auditLog.actorUserId, uid));
      await tx.delete(auditLog).where(eq(auditLog.targetUserId, uid));
    });
    await db.delete(approvalRequests).where(eq(approvalRequests.applicantUserId, uid));
    await db.delete(approvalRequests).where(eq(approvalRequests.initiatedByUserId, uid));
    await db.delete(notifications).where(eq(notifications.userId, uid));
    await db.delete(profiles).where(eq(profiles.id, uid));
  }

  if (found) await adminSdk.auth.admin.deleteUser(found.id);
}

async function createUserOrThrow(email: string): Promise<string> {
  const r = await createFreshTestUser(adminSdk, {
    email,
    password: "Ac1Hardening_2026!",
    email_confirm: true,
  });
  if (r.error || !r.data.user) throw new Error(`createUser(${email}): ${r.error?.message}`);
  return r.data.user.id;
}

beforeAll(async () => {
  for (const email of seededEmails) await deleteTestUser(email);

  activeAdminId = await createUserOrThrow(ACTIVE_ADMIN_EMAIL);
  await db
    .update(profiles)
    .set({ role: "admin", accountType: "institutional", deactivatedAt: null })
    .where(eq(profiles.id, activeAdminId));

  deactivatedAdminId = await createUserOrThrow(DEACTIVATED_ADMIN_EMAIL);
  await db
    .update(profiles)
    .set({ role: "admin", accountType: "institutional", deactivatedAt: new Date() })
    .where(eq(profiles.id, deactivatedAdminId));

  deactivatedGovtId = await createUserOrThrow(DEACTIVATED_GOVT_EMAIL);
  await db
    .update(profiles)
    .set({ role: "govt", accountType: "institutional", deactivatedAt: new Date() })
    .where(eq(profiles.id, deactivatedGovtId));

  // Plain owner target for a vet-upgrade proposal.
  targetOwnerId = await createUserOrThrow(TARGET_OWNER_EMAIL);
}, 30_000);

afterAll(async () => {
  for (const email of seededEmails) await deleteTestUser(email);
});

const vetInput = {
  matriculaNumber: "MP-12345",
  matriculaJurisdiccion: "Buenos Aires",
  operationalProvince: "Buenos Aires",
  operationalLocality: "La Plata",
  especialidad: null,
  anosExperiencia: null,
};

describe("AC1 — admin-proposals rejects deactivated authorities", () => {
  it("rejects a deactivated govt actor (no approval request created)", async () => {
    const result = await proposeVetUpgradeForUser(deactivatedGovtId, {
      targetUserId: targetOwnerId,
      ...vetInput,
    });
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("desactivada");

    // No approval request must have been created by the deactivated actor.
    const rows = await db
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(eq(approvalRequests.initiatedByUserId, deactivatedGovtId));
    expect(rows).toHaveLength(0);
  });

  it("rejects a deactivated admin actor (no approval request created)", async () => {
    const result = await proposeVetUpgradeForUser(deactivatedAdminId, {
      targetUserId: targetOwnerId,
      ...vetInput,
    });
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("desactivada");

    const rows = await db
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(eq(approvalRequests.initiatedByUserId, deactivatedAdminId));
    expect(rows).toHaveLength(0);
  });

  it("control: an active admin actor succeeds and creates the approval request", async () => {
    const result = await proposeVetUpgradeForUser(activeAdminId, {
      targetUserId: targetOwnerId,
      ...vetInput,
    });
    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(result.ok).toBe(true);

    const [row] = await db
      .select({ id: approvalRequests.id, initiatedBy: approvalRequests.initiatedByUserId })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.initiatedByUserId, activeAdminId),
          eq(approvalRequests.type, "role_upgrade_vet"),
        ),
      )
      .limit(1);
    expect(row).toBeDefined();
  });
});

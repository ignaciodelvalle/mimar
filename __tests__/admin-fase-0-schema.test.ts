// Schema-layer tests for the admin governance foundation (Fase 0).
//
// Covers the two safety triggers:
//   - enforce_admin_no_pets: a user with profiles.role='admin' cannot have
//     ownerships rows inserted/updated to them.
//   - enforce_audit_log_append_only: UPDATE and DELETE on audit_log are
//     blocked, with an explicit GUC bypass (app.allow_audit_mutation) so
//     test cleanup remains possible.
//
// Also smoke-tests the approval_requests CHECK constraints so a future
// schema regression that breaks polymorphic-target consistency surfaces
// here, not silently in production.

import { createClient } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { approvalRequests, auditLog, db, ownerships, pets, profiles } from "@/db";
import { generateApprovalRequestToken } from "@/lib/infra/publicToken";
import { setAuditMutationGucs, withMutationOverride } from "./_helpers/db-overrides";
import { expectDbError } from "./_helpers/expect-db-error";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const admin = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const ADMIN_EMAIL = "admin-fase0-admin@dim-test.local";
const OWNER_EMAIL = "admin-fase0-owner@dim-test.local";
const PASS = "AdminFase0_2026!";

let adminUserId: string;
let ownerUserId: string;

async function purgeUserByEmail(email: string) {
  const { data } = await admin.auth.admin.listUsers();
  const found = data?.users.find((u) => u.email === email);
  const displayName = email.split("@")[0];
  const orphans = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.displayName, displayName));
  const ids = [
    ...(found ? [found.id] : []),
    ...orphans.map((o) => o.id).filter((id) => id !== found?.id),
  ];
  for (const uid of ids) {
    await db.transaction(async (tx) => {
      await setAuditMutationGucs(tx);
      await tx.delete(auditLog).where(eq(auditLog.actorUserId, uid));
    });
    const owned = await db
      .select({ petId: ownerships.petId })
      .from(ownerships)
      .where(eq(ownerships.ownerUserId, uid));
    if (owned.length > 0) {
      await withMutationOverride(async (tx) => {
        for (const o of owned) await tx.delete(pets).where(eq(pets.id, o.petId));
      });
    }
    await db.delete(profiles).where(eq(profiles.id, uid));
  }
  if (found) await admin.auth.admin.deleteUser(found.id);
}

beforeAll(async () => {
  await purgeUserByEmail(ADMIN_EMAIL);
  await purgeUserByEmail(OWNER_EMAIL);

  const a = await createFreshTestUser(admin, {
    email: ADMIN_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (a.error || !a.data.user) throw new Error(`createUser admin: ${a.error?.message}`);
  adminUserId = a.data.user.id;
  await db
    .update(profiles)
    .set({ role: "admin", accountType: "institutional" })
    .where(eq(profiles.id, adminUserId));

  const o = await createFreshTestUser(admin, {
    email: OWNER_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (o.error || !o.data.user) throw new Error(`createUser owner: ${o.error?.message}`);
  ownerUserId = o.data.user.id;
  // owner stays as default role='owner'
});

afterAll(async () => {
  await purgeUserByEmail(ADMIN_EMAIL);
  await purgeUserByEmail(OWNER_EMAIL);
});

describe("enforce_admin_no_pets trigger", () => {
  it("blocks inserting an ownership row for a user with role='admin'", async () => {
    // Insert a pet first (admin can be the inserter — pets table is unrelated)
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: `DIM-FA0-${Date.now().toString(36).toUpperCase().slice(-4)}`,
        name: "BlockedPet",
        species: "dog",
        sex: "unknown",
        status: "active",
        potentiallyDangerousBreed: false,
      })
      .returning();

    // The trigger raises with a message mentioning "admin"; expectDbError
    // matches it on the .cause chain (drizzle 0.45 moved the pg error there).
    await expectDbError(
      db.insert(ownerships).values({
        petId: pet.id,
        ownerUserId: adminUserId,
        role: "owner",
        startedAt: new Date(),
      }),
      { constraint: /admin/i },
    );

    // Cleanup: drop the pet (no ownership row exists yet because the insert
    // was rejected by the trigger).
    await withMutationOverride(async (tx) => {
      await tx.delete(pets).where(eq(pets.id, pet.id));
    });
  });

  it("permits ownership for non-admin users (regression guard)", async () => {
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: `DIM-FA0-${Date.now().toString(36).toUpperCase().slice(-4)}`,
        name: "AllowedPet",
        species: "dog",
        sex: "unknown",
        status: "active",
        potentiallyDangerousBreed: false,
      })
      .returning();

    await db.insert(ownerships).values({
      petId: pet.id,
      ownerUserId: ownerUserId,
      role: "owner",
      startedAt: new Date(),
    });

    await withMutationOverride(async (tx) => {
      await tx.delete(pets).where(eq(pets.id, pet.id));
    });
  });
});

describe("enforce_audit_log_append_only trigger", () => {
  it("blocks UPDATE without the bypass GUC", async () => {
    const [row] = await db
      .insert(auditLog)
      .values({
        actorUserId: adminUserId,
        action: "admin_seeded",
        payload: { source: "test" },
      })
      .returning();

    await expectDbError(
      db.update(auditLog).set({ action: "pii_queried" }).where(eq(auditLog.id, row.id)),
      { constraint: /append-only/i },
    );

    // Cleanup with the bypass.
    await db.transaction(async (tx) => {
      await setAuditMutationGucs(tx);
      await tx.delete(auditLog).where(eq(auditLog.id, row.id));
    });
  });

  it("blocks DELETE without the bypass GUC", async () => {
    const [row] = await db
      .insert(auditLog)
      .values({
        actorUserId: adminUserId,
        action: "admin_seeded",
        payload: { source: "test" },
      })
      .returning();

    await expectDbError(db.delete(auditLog).where(eq(auditLog.id, row.id)), {
      constraint: /append-only/i,
    });

    await db.transaction(async (tx) => {
      await setAuditMutationGucs(tx);
      await tx.delete(auditLog).where(eq(auditLog.id, row.id));
    });
  });

  it("permits UPDATE and DELETE when app.allow_audit_mutation = 'true'", async () => {
    const [row] = await db
      .insert(auditLog)
      .values({
        actorUserId: adminUserId,
        action: "admin_seeded",
        payload: { source: "test-bypass" },
      })
      .returning();

    await db.transaction(async (tx) => {
      await setAuditMutationGucs(tx);
      await tx
        .update(auditLog)
        .set({ payload: { source: "test-bypass-updated" } })
        .where(eq(auditLog.id, row.id));
      await tx.delete(auditLog).where(eq(auditLog.id, row.id));
    });

    const after = await db.select().from(auditLog).where(eq(auditLog.id, row.id));
    expect(after).toHaveLength(0);
  });
});

describe("approval_requests CHECK constraints (polymorphic target consistency)", () => {
  it("rejects role_upgrade_vet without a target_user_id", async () => {
    await expectDbError(
      db.insert(approvalRequests).values({
        publicToken: generateApprovalRequestToken(),
        type: "role_upgrade_vet",
        status: "pending",
        applicantUserId: ownerUserId,
        targetUserId: null, // wrong — vet upgrades target a user
        targetOrganizationId: null,
        jurisdictionProvince: "CABA",
        jurisdictionLocality: "Palermo",
        payload: { payload_version: 1, matricula_number: "MN-X", matricula_jurisdiccion: "CABA" },
      }),
      { constraint: /approval_target_consistent/i },
    );
  });

  it("rejects organization_verification without a target_organization_id", async () => {
    await expectDbError(
      db.insert(approvalRequests).values({
        publicToken: generateApprovalRequestToken(),
        type: "organization_verification",
        status: "pending",
        applicantUserId: ownerUserId,
        targetUserId: ownerUserId, // wrong — org verifications target an org
        targetOrganizationId: null,
        jurisdictionProvince: "CABA",
        jurisdictionLocality: "Palermo",
        payload: { payload_version: 1, org_type: "shelter" },
      }),
      { constraint: /approval_target_consistent/i },
    );
  });

  it("rejects an approved row with no decided_at / decided_by_user_id", async () => {
    await expectDbError(
      db.insert(approvalRequests).values({
        publicToken: generateApprovalRequestToken(),
        type: "role_upgrade_vet",
        status: "approved",
        applicantUserId: ownerUserId,
        targetUserId: ownerUserId,
        targetOrganizationId: null,
        jurisdictionProvince: "CABA",
        jurisdictionLocality: "Palermo",
        payload: { payload_version: 1, matricula_number: "MN-X", matricula_jurisdiccion: "CABA" },
      }),
      { constraint: /approval_decision_consistent/i },
    );
  });

  it("accepts a well-formed pending role_upgrade_vet", async () => {
    const token = generateApprovalRequestToken();
    const [row] = await db
      .insert(approvalRequests)
      .values({
        publicToken: token,
        type: "role_upgrade_vet",
        status: "pending",
        applicantUserId: ownerUserId,
        targetUserId: ownerUserId,
        targetOrganizationId: null,
        jurisdictionProvince: "CABA",
        jurisdictionLocality: "Palermo",
        payload: { payload_version: 1, matricula_number: "MN-OK", matricula_jurisdiccion: "CABA" },
      })
      .returning();
    expect(row.publicToken).toBe(token);
    expect(row.status).toBe("pending");

    await db.delete(approvalRequests).where(eq(approvalRequests.id, row.id));
  });
});

describe("validateApprovalPayload + token generator", () => {
  it("APR token matches LBR/DIM format with APR prefix", () => {
    expect(generateApprovalRequestToken()).toMatch(/^APR-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });
});

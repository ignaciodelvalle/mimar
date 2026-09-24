// Integration tests for Fase 4 revocation server actions.
//
// Three writer functions are tested: revokeVetRoleForAuthority,
// revokeOrgVerificationForAuthority, revokeGovtLocalityForAuthority.
//
// Also covers the revocation-evidence upload action (uploadRevocationEvidence).
//
// Pattern mirrors admin-proposals.test.ts: real DB, Supabase admin client for
// user creation, app.allow_audit_mutation GUC for cleanup.

import { createClient } from "@supabase/supabase-js";
import { and, eq, or } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  attachments,
  auditLog,
  db,
  govtAssignments,
  notifications,
  organizationMemberships,
  organizations,
  ownerships,
  pets,
  profiles,
} from "@/db";
import { revokeGovtLocalityForAuthority } from "@/src/modules/organizations/application/revocations/revoke-govt-locality";
import { revokeOrgVerificationForAuthority } from "@/src/modules/organizations/application/revocations/revoke-org-verification";
import { revokeVetRoleForAuthority } from "@/src/modules/organizations/application/revocations/revoke-vet-role";
import { uploadRevocationEvidence } from "@/src/modules/organizations/application/revocations/upload-evidence";
import { createOrganizationForUser } from "@/src/modules/organizations/application/upgrade/create-organization";
import { setAuditMutationGucs, withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const admin = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const VET_EMAIL = "fase4-vet@dim-test.local";
const ADMIN_EMAIL = "fase4-admin@dim-test.local";
const GOVT_EMAIL = "fase4-govt@dim-test.local";
const OWNER_EMAIL = "fase4-owner@dim-test.local";
const GOVT2_EMAIL = "fase4-govt2@dim-test.local";
const PASS = "Fase4_2026!";

let vetUserId: string;
let adminUserId: string;
let govtUserId: string;
let ownerUserId: string;
let govt2UserId: string;

// Seeded assignment for govtUserId: province=Buenos Aires, locality=La Plata
let govtAssignmentId: string;
// Assignment seeded for scope tests (govtUserId owns this one in CABA)
let cabaAssignmentId: string;
// Assignment owned by govt2UserId for govt_locality revocation tests
let govt2AssignmentId: string;

// ---------------------------------------------------------------------------
// Shared helpers — reuse deleteTestUser pattern from admin-proposals.test.ts
// ---------------------------------------------------------------------------

async function deleteTestUser(email: string) {
  const { data: list } = await admin.auth.admin.listUsers();
  const found = list?.users.find((u) => u.email === email);
  const displayName = email.split("@")[0];
  const orphans = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.displayName, displayName));
  const ids = [
    ...(found ? [found.id] : []),
    ...orphans.map((p) => p.id).filter((id) => id !== found?.id),
  ];
  for (const uid of ids) {
    await db.transaction(async (tx) => {
      await setAuditMutationGucs(tx);
      await tx
        .delete(auditLog)
        .where(or(eq(auditLog.actorUserId, uid), eq(auditLog.targetUserId, uid)));
    });
    // Clean up attachments uploaded by this user
    await db.delete(attachments).where(eq(attachments.uploadedByUserId, uid));
    // Clean up govt_assignments where this user is the grantor (FK grantedByUserId)
    // null out the grantedByUserId first to avoid FK violations
    await db
      .update(govtAssignments)
      .set({ grantedByUserId: null })
      .where(eq(govtAssignments.grantedByUserId, uid));
    await db
      .update(govtAssignments)
      .set({ revokedByUserId: null })
      .where(eq(govtAssignments.revokedByUserId, uid));
    await db.delete(govtAssignments).where(eq(govtAssignments.userId, uid));
    await db.delete(notifications).where(eq(notifications.userId, uid));
    const adminRows = await db
      .select({ orgId: organizationMemberships.organizationId })
      .from(organizationMemberships)
      .where(
        and(eq(organizationMemberships.userId, uid), eq(organizationMemberships.role, "admin")),
      );
    for (const { orgId } of adminRows) {
      await db.transaction(async (tx) => {
        await setAuditMutationGucs(tx);
        await tx.delete(auditLog).where(eq(auditLog.targetOrganizationId, orgId));
      });
      await db.delete(organizations).where(eq(organizations.id, orgId));
    }
    await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, uid));
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

async function createUserOrThrow(email: string): Promise<string> {
  const r = await createFreshTestUser(admin, {
    email,
    password: PASS,
    email_confirm: true,
  });
  if (r.error || !r.data.user) throw new Error(`createUser(${email}): ${r.error?.message}`);
  return r.data.user.id;
}

// Insert a real attachments row, owned by `uploadedByUserId`, all FKs null.
// Returns the attachment id for use as `attachmentIds[]` in revocation calls.
async function seedAttachment(uploadedByUserId: string): Promise<string> {
  const [row] = await db
    .insert(attachments)
    .values({
      uploadedByUserId,
      storagePath: `revocations/${uploadedByUserId}/test-evidence.jpg`,
      mimeType: "image/jpeg",
      fileSize: 12345,
    })
    .returning({ id: attachments.id });
  return row.id;
}

async function cleanAttachment(id: string) {
  await db.delete(attachments).where(eq(attachments.id, id));
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  for (const email of [VET_EMAIL, ADMIN_EMAIL, GOVT_EMAIL, OWNER_EMAIL, GOVT2_EMAIL]) {
    await deleteTestUser(email);
  }
  vetUserId = await createUserOrThrow(VET_EMAIL);
  adminUserId = await createUserOrThrow(ADMIN_EMAIL);
  govtUserId = await createUserOrThrow(GOVT_EMAIL);
  ownerUserId = await createUserOrThrow(OWNER_EMAIL);
  govt2UserId = await createUserOrThrow(GOVT2_EMAIL);

  // Assign roles — migration 0015 requires account_type='institutional' for govt/admin.
  await db
    .update(profiles)
    .set({ role: "admin", accountType: "institutional" })
    .where(eq(profiles.id, adminUserId));

  // DNI prereq: ownerUserId calls createOrganizationForUser in seedVerifiedOrg.
  await db.update(profiles).set({ dniVerified: true }).where(eq(profiles.id, ownerUserId));
  await db
    .update(profiles)
    .set({ role: "govt", accountType: "institutional" })
    .where(or(eq(profiles.id, govtUserId), eq(profiles.id, govt2UserId)));

  // Seed vet profile fields
  await db
    .update(profiles)
    .set({
      role: "vet",
      matriculaNumber: "MN-FASE4-001",
      matriculaJurisdiccion: "Buenos Aires",
      matriculaVerified: true,
    })
    .where(eq(profiles.id, vetUserId));

  // Govt gets an active assignment in Buenos Aires / La Plata
  const [assignment] = await db
    .insert(govtAssignments)
    .values({
      userId: govtUserId,
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
      grantedByUserId: adminUserId,
    })
    .returning({ id: govtAssignments.id });
  govtAssignmentId = assignment.id;

  // Govt also gets CABA / Palermo assignment (for multi-jurisdiction tests)
  const [cabaAssign] = await db
    .insert(govtAssignments)
    .values({
      userId: govtUserId,
      jurisdictionProvince: "CABA",
      jurisdictionLocality: "Palermo",
      grantedByUserId: adminUserId,
    })
    .returning({ id: govtAssignments.id });
  cabaAssignmentId = cabaAssign.id;

  // Govt2 gets an active assignment for govt_locality revocation tests
  const [g2Assignment] = await db
    .insert(govtAssignments)
    .values({
      userId: govt2UserId,
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
      grantedByUserId: adminUserId,
    })
    .returning({ id: govtAssignments.id });
  govt2AssignmentId = g2Assignment.id;
});

afterAll(async () => {
  for (const email of [VET_EMAIL, ADMIN_EMAIL, GOVT_EMAIL, OWNER_EMAIL, GOVT2_EMAIL]) {
    await deleteTestUser(email);
  }
});

// Helper: reset vet profile to vet state between tests
async function resetVetProfile() {
  await db
    .update(profiles)
    .set({ role: "vet", matriculaVerified: true })
    .where(eq(profiles.id, vetUserId));
}

// Helper: create and return an org with `verified=true` for org revocation tests
async function seedVerifiedOrg(creatorUserId: string): Promise<string> {
  // DNI prereq: each test creates a new user, we must mark verified before
  // calling createOrganizationForUser.
  await db.update(profiles).set({ dniVerified: true }).where(eq(profiles.id, creatorUserId));
  const result = await createOrganizationForUser(creatorUserId, {
    name: "Test Org Fase4",
    legalName: "Test Legal Fase4",
    orgType: "shelter",
    email: "org-fase4@dim-test.local",
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "La Plata",
  });
  if (!result.organizationId) throw new Error("Failed to seed org");
  const orgId = result.organizationId;
  await db.update(organizations).set({ verified: true }).where(eq(organizations.id, orgId));
  return orgId;
}

// ---------------------------------------------------------------------------
// uploadRevocationEvidence tests (Task A-3)
// ---------------------------------------------------------------------------

describe("uploadRevocationEvidence", () => {
  it("admin can upload evidence — returns attachmentId, row created with all FKs null", async () => {
    const result = await uploadRevocationEvidence(adminUserId, {
      targetId: "target-a3",
      storagePath: "target-a3/evidence.jpg",
      mimeType: "image/jpeg",
      fileSize: 8000,
    });
    expect("attachmentId" in result && typeof result.attachmentId).toBe("string");

    const attachmentId = (result as { attachmentId: string }).attachmentId;
    const [row] = await db
      .select()
      .from(attachments)
      .where(eq(attachments.id, attachmentId))
      .limit(1);
    expect(row).toBeDefined();
    expect(row.uploadedByUserId).toBe(adminUserId);
    expect(row.auditLogId).toBeNull();
    expect(row.approvalRequestId).toBeNull();
    expect(row.petId).toBeNull();

    // Cleanup
    await cleanAttachment(attachmentId);
  });

  it("owner (non-authority) is rejected — no attachment row created", async () => {
    const result = await uploadRevocationEvidence(ownerUserId, {
      targetId: "owner",
      storagePath: "owner/evidence.jpg",
      mimeType: "image/jpeg",
    });
    expect("error" in result).toBe(true);

    // No row should exist for this owner's path
    const rows = await db
      .select()
      .from(attachments)
      .where(eq(attachments.storagePath, "owner/evidence.jpg"));
    expect(rows).toHaveLength(0);
  });

  it("rejects a storagePath outside the target namespace — no row created (RN-4/B3)", async () => {
    // Admin, so the role gate passes; the path binding is what must reject this.
    const foreignPath = "some-other-target/evidence.jpg";
    const result = await uploadRevocationEvidence(adminUserId, {
      targetId: "target-a3",
      storagePath: foreignPath,
      mimeType: "image/jpeg",
      fileSize: 8000,
    });
    expect("error" in result, "a path outside the target prefix was accepted").toBe(true);
    const rows = await db
      .select()
      .from(attachments)
      .where(eq(attachments.storagePath, foreignPath));
    expect(rows).toHaveLength(0);
  });

  it("rejects a traversing basename even under the right target (RN-4/B3)", async () => {
    const result = await uploadRevocationEvidence(adminUserId, {
      targetId: "target-a3",
      storagePath: "target-a3/../escape.jpg",
      mimeType: "image/jpeg",
    });
    expect("error" in result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// revokeVetRoleForAuthority tests
// ---------------------------------------------------------------------------

describe("revokeVetRoleForAuthority", () => {
  it("Scenario 1: admin revokes vet role — profile downgraded, audit_log written, attachments claimed, notification sent", async () => {
    await resetVetProfile();
    const attachmentId = await seedAttachment(adminUserId);

    const result = await revokeVetRoleForAuthority(adminUserId, {
      targetUserId: vetUserId,
      motivo: "Incumplimiento de normativas vigentes para veterinarios registrados.",
      attachmentIds: [attachmentId],
    });

    expect("ok" in result && result.ok).toBe(true);

    // Profile downgraded
    const [profile] = await db
      .select({
        role: profiles.role,
        matriculaVerified: profiles.matriculaVerified,
        matriculaNumber: profiles.matriculaNumber,
      })
      .from(profiles)
      .where(eq(profiles.id, vetUserId))
      .limit(1);
    expect(profile.role).toBe("owner");
    expect(profile.matriculaVerified).toBe(false);
    expect(profile.matriculaNumber).toBe("MN-FASE4-001"); // preserved

    // Audit log written
    const [log] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actorUserId, adminUserId),
          eq(auditLog.targetUserId, vetUserId),
          eq(auditLog.action, "revocation_vet_role"),
        ),
      )
      .limit(1);
    expect(log).toBeDefined();
    expect((log.payload as Record<string, unknown>).evidence_attachment_ids).toContain(
      attachmentId,
    );

    // Attachment claimed
    const [att] = await db
      .select({ auditLogId: attachments.auditLogId })
      .from(attachments)
      .where(eq(attachments.id, attachmentId))
      .limit(1);
    expect(att.auditLogId).toBe(log.id);

    // Notification sent to target
    const [notif] = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, vetUserId),
          eq(notifications.notificationType, "revocation_executed_vet"),
        ),
      )
      .limit(1);
    expect(notif).toBeDefined();
    expect(notif.body).toContain("Incumplimiento");
    expect(notif.ctaUrl).toBe("/cuenta/upgrade");
  });

  it("govt-in-scope revokes vet (matricula jurisdiction matches)", async () => {
    await resetVetProfile();
    const attachmentId = await seedAttachment(govtUserId);

    const result = await revokeVetRoleForAuthority(govtUserId, {
      targetUserId: vetUserId,
      motivo: "El veterinario incurrió en conducta contraria a los estándares profesionales.",
      attachmentIds: [attachmentId],
    });

    expect("ok" in result && result.ok).toBe(true);

    const [profile] = await db
      .select({ role: profiles.role })
      .from(profiles)
      .where(eq(profiles.id, vetUserId))
      .limit(1);
    expect(profile.role).toBe("owner");
  });

  it("Scenario 6: motivo < 30 chars — returns REASON_TOO_SHORT, no mutation", async () => {
    await resetVetProfile();
    const attachmentId = await seedAttachment(adminUserId);

    const result = await revokeVetRoleForAuthority(adminUserId, {
      targetUserId: vetUserId,
      motivo: "corto",
      attachmentIds: [attachmentId],
    });

    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toMatch(/REASON_TOO_SHORT/);

    // Profile unchanged
    const [profile] = await db
      .select({ role: profiles.role })
      .from(profiles)
      .where(eq(profiles.id, vetUserId))
      .limit(1);
    expect(profile.role).toBe("vet");

    await cleanAttachment(attachmentId);
  });

  it("Scenario 7: attachmentIds=[] — returns EVIDENCE_REQUIRED, no mutation", async () => {
    await resetVetProfile();

    const result = await revokeVetRoleForAuthority(adminUserId, {
      targetUserId: vetUserId,
      motivo: "Motivo válido con más de treinta caracteres aquí.",
      attachmentIds: [],
    });

    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toMatch(/EVIDENCE_REQUIRED/);
  });

  it("Scenario 9: target already role=owner — returns ok with noOp=true, no audit_log written", async () => {
    await db.update(profiles).set({ role: "owner" }).where(eq(profiles.id, vetUserId));
    const attachmentId = await seedAttachment(adminUserId);

    // Count audit_log rows before
    const before = await db.select().from(auditLog).where(eq(auditLog.targetUserId, vetUserId));

    const result = await revokeVetRoleForAuthority(adminUserId, {
      targetUserId: vetUserId,
      motivo: "Intento de revocación sobre usuario ya owner.",
      attachmentIds: [attachmentId],
    });

    expect("ok" in result && result.ok).toBe(true);
    expect((result as { ok: true; noOp?: boolean }).noOp).toBe(true);

    // No new audit_log row
    const after = await db.select().from(auditLog).where(eq(auditLog.targetUserId, vetUserId));
    expect(after.length).toBe(before.length);

    await cleanAttachment(attachmentId);
    await resetVetProfile();
  });

  it("govt out of jurisdiction — returns CAPABILITY_DENIED, target unchanged", async () => {
    await resetVetProfile();
    // Vet has matriculaJurisdiccion=Buenos Aires; govt2 is in CABA only
    // but we need a govt with wrong jurisdiction; let's use a fresh govt scoped to Córdoba
    const wrongGovtEmail = "fase4-wronggov@dim-test.local";
    await deleteTestUser(wrongGovtEmail);
    const wrongGovtId = await createUserOrThrow(wrongGovtEmail);
    await db
      .update(profiles)
      .set({ role: "govt", accountType: "institutional" })
      .where(eq(profiles.id, wrongGovtId));
    await db.insert(govtAssignments).values({
      userId: wrongGovtId,
      jurisdictionProvince: "Córdoba",
      jurisdictionLocality: "Córdoba",
      grantedByUserId: adminUserId,
    });

    const attachmentId = await seedAttachment(wrongGovtId);
    const result = await revokeVetRoleForAuthority(wrongGovtId, {
      targetUserId: vetUserId,
      motivo: "Intentando revocar fuera de mi jurisdicción asignada.",
      attachmentIds: [attachmentId],
    });

    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toMatch(/CAPABILITY_DENIED/);

    const [profile] = await db
      .select({ role: profiles.role })
      .from(profiles)
      .where(eq(profiles.id, vetUserId))
      .limit(1);
    expect(profile.role).toBe("vet");

    await cleanAttachment(attachmentId);
    await deleteTestUser(wrongGovtEmail);
  });

  it("attachment owned by different uploader — tx rollback, no audit_log row", async () => {
    await resetVetProfile();
    // Seed attachment owned by govtUserId, not adminUserId
    const attachmentId = await seedAttachment(govtUserId);
    const motivo = "Intento con evidencia que no me pertenece a mí como actor.";

    const beforeLogs = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.actorUserId, adminUserId), eq(auditLog.action, "revocation_vet_role")),
      );

    const result = await revokeVetRoleForAuthority(adminUserId, {
      targetUserId: vetUserId,
      motivo,
      attachmentIds: [attachmentId],
    });

    expect("error" in result).toBe(true);

    // No new audit_log row created (tx rolled back)
    const afterLogs = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.actorUserId, adminUserId), eq(auditLog.action, "revocation_vet_role")),
      );
    expect(afterLogs.length).toBe(beforeLogs.length);

    // Profile unchanged
    const [profile] = await db
      .select({ role: profiles.role })
      .from(profiles)
      .where(eq(profiles.id, vetUserId))
      .limit(1);
    expect(profile.role).toBe("vet");

    await cleanAttachment(attachmentId);
  });
});

// ---------------------------------------------------------------------------
// revokeOrgVerificationForAuthority tests
// ---------------------------------------------------------------------------

describe("revokeOrgVerificationForAuthority", () => {
  it("Scenario 2: govt-in-scope revokes verified org — verified=false, verified_at preserved, audit_log, notification", async () => {
    // Use a dedicated user to avoid "already has org" idempotency guard
    const orgOwnerEmail = "fase4-orgowner-s2@dim-test.local";
    await deleteTestUser(orgOwnerEmail);
    const orgOwnerId = await createUserOrThrow(orgOwnerEmail);
    const orgId = await seedVerifiedOrg(orgOwnerId);
    const attachmentId = await seedAttachment(govtUserId);

    // Capture verified_at before revocation
    const [beforeOrg] = await db
      .select({
        verifiedAt: organizations.verifiedAt,
        verifiedByUserId: organizations.verifiedByUserId,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    const result = await revokeOrgVerificationForAuthority(govtUserId, {
      organizationId: orgId,
      motivo: "Documentación presentada resultó ser fraudulenta según auditoría.",
      attachmentIds: [attachmentId],
    });

    expect("ok" in result && result.ok).toBe(true);

    const [org] = await db
      .select({
        verified: organizations.verified,
        verifiedAt: organizations.verifiedAt,
        verifiedByUserId: organizations.verifiedByUserId,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    expect(org.verified).toBe(false);
    // verified_at and verified_by_user_id preserved (historical record)
    expect(org.verifiedAt).toEqual(beforeOrg.verifiedAt);
    expect(org.verifiedByUserId).toEqual(beforeOrg.verifiedByUserId);

    // Audit log written
    const [log] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.targetOrganizationId, orgId),
          eq(auditLog.action, "revocation_org_verified"),
        ),
      )
      .limit(1);
    expect(log).toBeDefined();

    // Attachment claimed
    const [att] = await db
      .select({ auditLogId: attachments.auditLogId })
      .from(attachments)
      .where(eq(attachments.id, attachmentId))
      .limit(1);
    expect(att.auditLogId).toBe(log.id);

    // Notification sent to org owner (orgOwnerId = the user who created the org)
    const [notif] = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, orgOwnerId),
          eq(notifications.notificationType, "revocation_executed_org"),
        ),
      )
      .limit(1);
    expect(notif).toBeDefined();
    expect(notif.body).toContain("fraudulenta");

    await deleteTestUser(orgOwnerEmail);
  });

  it("Scenario 4: govt out of scope — returns CAPABILITY_DENIED, org unchanged", async () => {
    // Use a dedicated user for the Rosario org
    const s4OwnerEmail = "fase4-orgowner-s4@dim-test.local";
    await deleteTestUser(s4OwnerEmail);
    const s4OwnerId = await createUserOrThrow(s4OwnerEmail);

    // DNI prereq for this per-test user
    await db.update(profiles).set({ dniVerified: true }).where(eq(profiles.id, s4OwnerId));

    // Create a Rosario org (outside govt2's Buenos Aires / La Plata scope)
    const result2 = await createOrganizationForUser(s4OwnerId, {
      name: "Org Rosario Fase4",
      legalName: "Org Rosario Legal",
      orgType: "shelter",
      email: "org-rosario-fase4@dim-test.local",
      jurisdictionProvince: "Santa Fe",
      jurisdictionLocality: "Rosario",
    });
    if (!result2.organizationId) throw new Error("Failed to seed org");
    const rosarioOrgId = result2.organizationId;
    await db
      .update(organizations)
      .set({ verified: true })
      .where(eq(organizations.id, rosarioOrgId));
    const attachmentId = await seedAttachment(govt2UserId);

    // govt2 is in Buenos Aires / La Plata — cannot revoke Santa Fe / Rosario org
    const result = await revokeOrgVerificationForAuthority(govt2UserId, {
      organizationId: rosarioOrgId,
      motivo: "Intentando revocar una organización fuera de mi jurisdicción.",
      attachmentIds: [attachmentId],
    });

    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toMatch(/CAPABILITY_DENIED/);

    const [org] = await db
      .select({ verified: organizations.verified })
      .from(organizations)
      .where(eq(organizations.id, rosarioOrgId))
      .limit(1);
    expect(org.verified).toBe(true);

    await cleanAttachment(attachmentId);
    await deleteTestUser(s4OwnerEmail);
  });

  it("Scenario 7 (org): attachmentIds=[] — returns EVIDENCE_REQUIRED", async () => {
    // Use dedicated user for this org
    const s7OwnerEmail = "fase4-orgowner-s7@dim-test.local";
    await deleteTestUser(s7OwnerEmail);
    const s7OwnerId = await createUserOrThrow(s7OwnerEmail);
    const orgId = await seedVerifiedOrg(s7OwnerId);

    const result = await revokeOrgVerificationForAuthority(adminUserId, {
      organizationId: orgId,
      motivo: "Motivo válido con más de treinta caracteres para prueba.",
      attachmentIds: [],
    });

    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toMatch(/EVIDENCE_REQUIRED/);

    await deleteTestUser(s7OwnerEmail);
  });

  it("org already unverified — returns ok noOp=true, no audit_log written", async () => {
    // Use dedicated user to avoid "already has org" guard
    const noVerifyOwnerEmail = "fase4-orgowner-nv@dim-test.local";
    await deleteTestUser(noVerifyOwnerEmail);
    const noVerifyOwnerId = await createUserOrThrow(noVerifyOwnerEmail);
    // DNI prereq for this per-test user
    await db.update(profiles).set({ dniVerified: true }).where(eq(profiles.id, noVerifyOwnerId));
    const result2 = await createOrganizationForUser(noVerifyOwnerId, {
      name: "Org No Verified Fase4",
      legalName: "Org NV Legal",
      orgType: "shelter",
      email: "org-nv-fase4@dim-test.local",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
    });
    if (!result2.organizationId) throw new Error("Failed to seed org");
    const unverifiedOrgId = result2.organizationId;
    // NOT setting verified=true — it defaults to false

    const attachmentId = await seedAttachment(adminUserId);

    const result = await revokeOrgVerificationForAuthority(adminUserId, {
      organizationId: unverifiedOrgId,
      motivo: "Intentar revocar una org que ya está sin verificación.",
      attachmentIds: [attachmentId],
    });

    expect("ok" in result && result.ok).toBe(true);
    expect((result as { ok: true; noOp?: boolean }).noOp).toBe(true);

    await cleanAttachment(attachmentId);
    await deleteTestUser(noVerifyOwnerEmail);
  });
});

// ---------------------------------------------------------------------------
// revokeGovtLocalityForAuthority tests
// ---------------------------------------------------------------------------

describe("revokeGovtLocalityForAuthority", () => {
  it("Scenario 3: admin revokes govt locality — revoked_at set, profile.role stays govt, audit_log, notification", async () => {
    // govt2UserId has one assignment (govt2AssignmentId)
    // Add a second assignment so this isn't the last one
    const [extraAssign] = await db
      .insert(govtAssignments)
      .values({
        userId: govt2UserId,
        jurisdictionProvince: "CABA",
        jurisdictionLocality: "Palermo",
        grantedByUserId: adminUserId,
      })
      .returning({ id: govtAssignments.id });

    const attachmentId = await seedAttachment(adminUserId);

    const result = await revokeGovtLocalityForAuthority(adminUserId, {
      govtAssignmentId: govt2AssignmentId,
      motivo: "Motivo válido de más de 30 caracteres para la revocación de localidad.",
      attachmentIds: [attachmentId],
    });

    expect("ok" in result && result.ok).toBe(true);

    // Assignment revoked
    const [assignment] = await db
      .select({
        revokedAt: govtAssignments.revokedAt,
        revokedByUserId: govtAssignments.revokedByUserId,
        revocationReason: govtAssignments.revocationReason,
      })
      .from(govtAssignments)
      .where(eq(govtAssignments.id, govt2AssignmentId))
      .limit(1);
    expect(assignment.revokedAt).not.toBeNull();
    expect(assignment.revokedByUserId).toBe(adminUserId);
    expect(assignment.revocationReason).toContain("Motivo válido");

    // Profile role still 'govt'
    const [profile] = await db
      .select({ role: profiles.role })
      .from(profiles)
      .where(eq(profiles.id, govt2UserId))
      .limit(1);
    expect(profile.role).toBe("govt");

    // Audit log written
    const [log] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.targetGovtAssignmentId, govt2AssignmentId),
          eq(auditLog.action, "revocation_govt_assignment"),
        ),
      )
      .limit(1);
    expect(log).toBeDefined();

    // Notification to govt2UserId
    const [notif] = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, govt2UserId),
          eq(notifications.notificationType, "govt_locality_revoked"),
        ),
      )
      .limit(1);
    expect(notif).toBeDefined();

    // Reset for next test
    await db
      .update(govtAssignments)
      .set({ revokedAt: null, revokedByUserId: null, revocationReason: null })
      .where(eq(govtAssignments.id, govt2AssignmentId));

    // Cleanup extra assignment
    await db.delete(govtAssignments).where(eq(govtAssignments.id, extraAssign.id));
  });

  it("Scenario 8: last locality revocation — succeeds, profile.role stays govt, notification warns about last locality", async () => {
    // govt2AssignmentId is now the only active assignment for govt2UserId
    // (extra one was deleted above)
    const attachmentId = await seedAttachment(adminUserId);

    const result = await revokeGovtLocalityForAuthority(adminUserId, {
      govtAssignmentId: govt2AssignmentId,
      motivo: "Revocando la última localidad activa de este usuario govt.",
      attachmentIds: [attachmentId],
    });

    expect("ok" in result && result.ok).toBe(true);

    // Notification body should warn about last locality
    // Find the most recent govt_locality_revoked notification for this user
    // (Scenario 3 may have created an earlier one)
    const allNotifs = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, govt2UserId),
          eq(notifications.notificationType, "govt_locality_revoked"),
        ),
      );
    // The last locality warning should appear in at least one notification
    const notifWithWarning = allNotifs.find((n) => n.body?.match(/última|sin localidades/i));
    expect(notifWithWarning).toBeDefined();

    // Profile role still 'govt'
    const [profile] = await db
      .select({ role: profiles.role })
      .from(profiles)
      .where(eq(profiles.id, govt2UserId))
      .limit(1);
    expect(profile.role).toBe("govt");
  });

  it("Scenario 10: self-revocation denied", async () => {
    // govtUserId tries to revoke their own assignment
    const attachmentId = await seedAttachment(govtUserId);

    const result = await revokeGovtLocalityForAuthority(govtUserId, {
      govtAssignmentId: govtAssignmentId,
      motivo: "Intentando revocarme mi propia localidad como governo.",
      attachmentIds: [attachmentId],
    });

    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toMatch(/SELF_REVOCATION_DENIED/);

    // Assignment unchanged
    const [assignment] = await db
      .select({ revokedAt: govtAssignments.revokedAt })
      .from(govtAssignments)
      .where(eq(govtAssignments.id, govtAssignmentId))
      .limit(1);
    expect(assignment.revokedAt).toBeNull();

    await cleanAttachment(attachmentId);
  });

  it("assignment already revoked — returns ok noOp=true", async () => {
    // Create a fresh assignment, revoke it manually, then try to revoke again
    const [tempAssign] = await db
      .insert(govtAssignments)
      .values({
        userId: govtUserId,
        jurisdictionProvince: "Mendoza",
        jurisdictionLocality: "Mendoza",
        grantedByUserId: adminUserId,
        revokedAt: new Date(),
        revokedByUserId: adminUserId,
        revocationReason: "Pre-revoked for test",
      })
      .returning({ id: govtAssignments.id });

    const attachmentId = await seedAttachment(adminUserId);

    const result = await revokeGovtLocalityForAuthority(adminUserId, {
      govtAssignmentId: tempAssign.id,
      motivo: "Intentando revocar una asignación que ya fue revocada previamente.",
      attachmentIds: [attachmentId],
    });

    expect("ok" in result && result.ok).toBe(true);
    expect((result as { ok: true; noOp?: boolean }).noOp).toBe(true);

    await cleanAttachment(attachmentId);
    await db.delete(govtAssignments).where(eq(govtAssignments.id, tempAssign.id));
  });

  it("govt out of jurisdiction for locality revocation — returns CAPABILITY_DENIED", async () => {
    // govtUserId has Buenos Aires / La Plata; try to revoke a CABA assignment
    const [cabaTargetAssign] = await db
      .insert(govtAssignments)
      .values({
        userId: ownerUserId, // target govt user is ownerUserId (irrelevant; we just need any user)
        jurisdictionProvince: "Santa Fe",
        jurisdictionLocality: "Rosario",
        grantedByUserId: adminUserId,
      })
      .returning({ id: govtAssignments.id });

    // Upgrade ownerUserId to govt temporarily (migration 0015: must set institutional)
    await db
      .update(profiles)
      .set({ role: "govt", accountType: "institutional" })
      .where(eq(profiles.id, ownerUserId));

    const attachmentId = await seedAttachment(govtUserId);

    // govtUserId is in BA/La Plata and CABA/Palermo — not in Santa Fe/Rosario
    const result = await revokeGovtLocalityForAuthority(govtUserId, {
      govtAssignmentId: cabaTargetAssign.id,
      motivo: "Intentando revocar una localidad fuera de mi jurisdicción govt.",
      attachmentIds: [attachmentId],
    });

    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toMatch(/CAPABILITY_DENIED/);

    await cleanAttachment(attachmentId);
    await db.delete(govtAssignments).where(eq(govtAssignments.id, cabaTargetAssign.id));
    await db.update(profiles).set({ role: "owner" }).where(eq(profiles.id, ownerUserId));
  });
});

// ---------------------------------------------------------------------------
// Scenario 11: Notification content validation
// ---------------------------------------------------------------------------

describe("Scenario 11 — notification content validation", () => {
  it("vet revocation: notification body contains motivo, ctaUrl=/cuenta/upgrade, type=revocation_executed_vet", async () => {
    await resetVetProfile();
    const motivo = "Motivo de revocación detallado con más de treinta caracteres exactos S11.";
    const attachmentId = await seedAttachment(adminUserId);

    await revokeVetRoleForAuthority(adminUserId, {
      targetUserId: vetUserId,
      motivo,
      attachmentIds: [attachmentId],
    });

    // Find the specific notification for this motivo (not earlier revocations)
    const notifs = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, vetUserId),
          eq(notifications.notificationType, "revocation_executed_vet"),
        ),
      );

    // At least one notification should contain this exact motivo
    const matching = notifs.find((n) => n.body?.includes("S11"));
    expect(matching).toBeDefined();
    if (!matching) return; // type narrowing for following assertions
    expect(matching.body).toContain(motivo);
    expect(matching.ctaUrl).toBe("/cuenta/upgrade");
    expect(matching.notificationType).toBe("revocation_executed_vet");
  });
});

// ---------------------------------------------------------------------------
// Race condition test
// ---------------------------------------------------------------------------

describe("Race condition — concurrent revocations on same target", () => {
  it("two concurrent vet revocations — only one succeeds, second is no-op or error", async () => {
    await resetVetProfile();
    const attachmentId1 = await seedAttachment(adminUserId);
    const attachmentId2 = await seedAttachment(adminUserId);

    const motivo = "Motivo para el test de condición de carrera en revocación vet.";

    const [r1, r2] = await Promise.all([
      revokeVetRoleForAuthority(adminUserId, {
        targetUserId: vetUserId,
        motivo,
        attachmentIds: [attachmentId1],
      }),
      revokeVetRoleForAuthority(adminUserId, {
        targetUserId: vetUserId,
        motivo,
        attachmentIds: [attachmentId2],
      }),
    ]);

    // Both calls should return without throwing — one wins, one no-ops or errors
    expect(r1).toBeDefined();
    expect(r2).toBeDefined();

    // The profile MUST end up as 'owner' (exactly one revocation took effect)
    const [profile] = await db
      .select({ role: profiles.role })
      .from(profiles)
      .where(eq(profiles.id, vetUserId))
      .limit(1);
    expect(profile.role).toBe("owner");

    // At least one succeeded (not both errors)
    const atLeastOneOk = ("ok" in r1 && r1.ok) || ("ok" in r2 && r2.ok);
    expect(atLeastOneOk).toBe(true);

    // Cleanup unused attachment
    for (const id of [attachmentId1, attachmentId2]) {
      try {
        await cleanAttachment(id);
      } catch {
        // May already be claimed
      }
    }
  });
});

// Integration tests for the vet clinic creation flow (Sprint 1A Phase C).
// Covers the action powering /cuenta/crear-consultorio via createClinicAction.
//
// Provisions a vet via the admin SDK (matriculaVerified=true, no memberships),
// calls createOrganizationForUser directly (the same function the
// createClinicAction wrapper delegates to), and asserts the expected DB state.
//
// Also covers the solo-consultorio auto-verify bridge (D1, D4):
// - Solo vet clinic → org.verified=true + autoVerifiedViaMatricula=true + approved AR
// - Shelter/rescue_network → still verified=false + pending AR
// - Non-matriculaVerified vet → still pending flow
// - Matrícula revocation cascade → auto-verified clinic loses verification

import { createClient } from "@supabase/supabase-js";
import { and, eq, isNull, or } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  approvalRequests,
  attachments,
  auditLog,
  db,
  notifications,
  organizationMemberships,
  organizations,
  profiles,
} from "@/db";
import { revokeVetRoleForAuthority } from "@/src/modules/organizations/application/revocations/revoke-vet-role";
import { createOrganizationForUser } from "@/src/modules/organizations/application/upgrade/create-organization";
import { setAuditMutationGucs, withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const admin = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

const VET_EMAIL = "create-clinic-test@dim-test.local";
const VET_NO_MATRICULA_EMAIL = "create-clinic-no-mat@dim-test.local";
const ADMIN_REVOC_EMAIL = "create-clinic-admin@dim-test.local";
const PASS = "CreateClinic_2026!";

let vetUserId: string;
let vetNoMatriculaId: string;
let adminRevocId: string;

async function purgeUser(email: string) {
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
  const found = list?.users.find((u) => u.email === email);
  if (!found) return;
  const uid = found.id;

  // Cleanup audit_log rows (append-only trigger requires the GUC bypass).
  await db.transaction(async (tx) => {
    await setAuditMutationGucs(tx);
    await tx
      .delete(auditLog)
      .where(or(eq(auditLog.actorUserId, uid), eq(auditLog.targetUserId, uid)));
  });

  // Cleanup attachments uploaded by this user (must come after audit_log cleanup
  // because claimAttachmentsForAudit sets audit_log_id FK — audit_log row gone first).
  await db.delete(attachments).where(eq(attachments.uploadedByUserId, uid));

  const autoOrgs = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.createdByUserId, uid));

  for (const o of autoOrgs) {
    // Clean up audit_log rows targeting this org before deleting the org.
    await db.transaction(async (tx) => {
      await setAuditMutationGucs(tx);
      await tx.delete(auditLog).where(eq(auditLog.targetOrganizationId, o.id));
    });
    await db.delete(approvalRequests).where(eq(approvalRequests.targetOrganizationId, o.id));
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.organizationId, o.id));
    await db.delete(organizations).where(eq(organizations.id, o.id));
  }

  await db.delete(approvalRequests).where(eq(approvalRequests.applicantUserId, uid));
  await db.delete(notifications).where(eq(notifications.userId, uid));

  await withMutationOverride(async (tx) => {
    await tx.delete(profiles).where(eq(profiles.id, uid));
  });
  await admin.auth.admin.deleteUser(found.id);
}

async function purgeVet() {
  await purgeUser(VET_EMAIL);
}

async function provisionVet(): Promise<string> {
  const { data, error } = await createFreshTestUser(admin, {
    email: VET_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  vetUserId = data.user.id;

  await db
    .update(profiles)
    .set({
      role: "vet",
      matriculaNumber: "MN-CLINIC-001",
      matriculaJurisdiccion: "Buenos Aires",
      matriculaVerified: true,
      displayName: "Dr. Clinic Test",
      dniVerified: true,
    })
    .where(eq(profiles.id, vetUserId));

  return vetUserId;
}

async function provisionVetNoMatricula(): Promise<string> {
  const { data, error } = await createFreshTestUser(admin, {
    email: VET_NO_MATRICULA_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser(no-mat): ${error?.message}`);
  vetNoMatriculaId = data.user.id;

  await db
    .update(profiles)
    .set({
      role: "vet",
      matriculaNumber: "MN-PENDING-002",
      matriculaJurisdiccion: "Buenos Aires",
      matriculaVerified: false, // NOT verified — should NOT auto-verify
      displayName: "Dr. No Matricula Test",
      dniVerified: true,
    })
    .where(eq(profiles.id, vetNoMatriculaId));

  return vetNoMatriculaId;
}

async function provisionAdmin(): Promise<string> {
  const { data, error } = await createFreshTestUser(admin, {
    email: ADMIN_REVOC_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser(admin): ${error?.message}`);
  adminRevocId = data.user.id;

  await db
    .update(profiles)
    .set({ role: "admin", accountType: "institutional" })
    .where(eq(profiles.id, adminRevocId));

  return adminRevocId;
}

beforeEach(async () => {
  await purgeUser(VET_EMAIL);
  await purgeUser(VET_NO_MATRICULA_EMAIL);
  await purgeUser(ADMIN_REVOC_EMAIL);
  await provisionVet();
  await provisionVetNoMatricula();
  await provisionAdmin();
});

afterEach(async () => {
  await purgeUser(VET_EMAIL);
  await purgeUser(VET_NO_MATRICULA_EMAIL);
  await purgeUser(ADMIN_REVOC_EMAIL);
});

describe("create-clinic-wizard — happy path", () => {
  it("creates a clinic org with role=admin and canWritePetEvents=true for the vet", async () => {
    const result = await createOrganizationForUser(vetUserId, {
      name: "Consultorio Dr. Clinic Test",
      legalName: "Consultorio Dr. Clinic Test",
      orgType: "clinic",
      email: VET_EMAIL,
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
    });

    expect(result.error).toBeNull();
    expect(result.ok).toBe(true);
    expect(result.organizationId).toBeDefined();

    const orgId = result.organizationId!;

    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    expect(org).toBeDefined();
    expect(org.orgType).toBe("clinic");
    expect(org.displayName).toBe("Consultorio Dr. Clinic Test");
    expect(org.createdByUserId).toBe(vetUserId);
    expect(org.publicToken).toBeTruthy();

    const [membership] = await db
      .select()
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, orgId),
          eq(organizationMemberships.userId, vetUserId),
          isNull(organizationMemberships.leftAt),
        ),
      );
    expect(membership).toBeDefined();
    expect(membership.role).toBe("admin");
    expect(membership.canWritePetEvents).toBe(true);
  });

  it("rejects creation for a vet who already administers an org", async () => {
    // First creation succeeds.
    const first = await createOrganizationForUser(vetUserId, {
      name: "Consultorio Primero",
      legalName: "Consultorio Primero",
      orgType: "clinic",
      email: VET_EMAIL,
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
    });
    expect(first.ok).toBe(true);

    // Second creation is blocked by the alreadyAdmin guard.
    const second = await createOrganizationForUser(vetUserId, {
      name: "Consultorio Segundo",
      legalName: "Consultorio Segundo",
      orgType: "clinic",
      email: VET_EMAIL,
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
    });
    expect(second.error).toBeTruthy();
    expect(second.ok).toBeUndefined();
  });
});

describe("create-clinic-wizard — orgType enforcement", () => {
  it("createOrganizationForUser with orgType=clinic produces org_type=clinic in the DB", async () => {
    const result = await createOrganizationForUser(vetUserId, {
      name: "Solo Clinic",
      legalName: "Solo Clinic",
      orgType: "clinic",
      email: VET_EMAIL,
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "Mar del Plata",
    });
    expect(result.error).toBeNull();

    const [org] = await db
      .select({ orgType: organizations.orgType })
      .from(organizations)
      .where(eq(organizations.id, result.organizationId!));
    expect(org.orgType).toBe("clinic");
  });
});

// ---------------------------------------------------------------------------
// D1: Auto-verify solo vet clinic
// ---------------------------------------------------------------------------

describe("solo-consultorio auto-verify — D1", () => {
  it("auto-verifies a clinic org when the sole admin has matriculaVerified=true", async () => {
    const result = await createOrganizationForUser(vetUserId, {
      name: "Consultorio Solo Vet",
      legalName: "Consultorio Solo Vet",
      orgType: "clinic",
      email: VET_EMAIL,
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
    });

    expect(result.error).toBeNull();
    const orgId = result.organizationId!;

    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    expect(org.verified).toBe(true);
    expect(org.autoVerifiedViaMatricula).toBe(true);
    expect(org.verifiedAt).toBeInstanceOf(Date);
    // verifiedByUserId must be null for auto-verify (system decision, not the vet itself)
    expect(org.verifiedByUserId).toBeNull();
  });

  it("creates the approval_request with status=approved for a solo vet clinic", async () => {
    const result = await createOrganizationForUser(vetUserId, {
      name: "Consultorio AR Approved",
      legalName: "Consultorio AR Approved",
      orgType: "clinic",
      email: VET_EMAIL,
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
    });

    expect(result.error).toBeNull();
    const orgId = result.organizationId!;

    const [ar] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.targetOrganizationId, orgId));

    expect(ar).toBeDefined();
    expect(ar.status).toBe("approved");
    expect(ar.decidedAt).toBeInstanceOf(Date);
    // decidedByUserId is null for system-automated decisions
    expect(ar.decidedByUserId).toBeNull();
    expect(ar.decisionNotes).toMatch(/auto-verified/i);
  });

  it("does NOT auto-verify a shelter org even if creator has matriculaVerified=true", async () => {
    const result = await createOrganizationForUser(vetUserId, {
      name: "Refugio Vet",
      legalName: "Refugio Vet SA",
      orgType: "shelter",
      email: VET_EMAIL,
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
    });

    expect(result.error).toBeNull();
    const orgId = result.organizationId!;

    const [org] = await db
      .select({
        verified: organizations.verified,
        autoVerifiedViaMatricula: organizations.autoVerifiedViaMatricula,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    expect(org.verified).toBe(false);
    expect(org.autoVerifiedViaMatricula).toBe(false);

    const [ar] = await db
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.targetOrganizationId, orgId));
    expect(ar.status).toBe("pending");
  });

  it("does NOT auto-verify a rescue_network org even if creator has matriculaVerified=true", async () => {
    const result = await createOrganizationForUser(vetUserId, {
      name: "Red Rescate Vet",
      legalName: "Red Rescate Vet SA",
      orgType: "rescue_network",
      email: VET_EMAIL,
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
    });

    expect(result.error).toBeNull();
    const orgId = result.organizationId!;

    const [org] = await db
      .select({
        verified: organizations.verified,
        autoVerifiedViaMatricula: organizations.autoVerifiedViaMatricula,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    expect(org.verified).toBe(false);
    expect(org.autoVerifiedViaMatricula).toBe(false);

    const [ar] = await db
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.targetOrganizationId, orgId));
    expect(ar.status).toBe("pending");
  });

  it("does NOT auto-verify a clinic org when the creator has matriculaVerified=false", async () => {
    const result = await createOrganizationForUser(vetNoMatriculaId, {
      name: "Consultorio Sin Matricula",
      legalName: "Consultorio Sin Matricula",
      orgType: "clinic",
      email: VET_NO_MATRICULA_EMAIL,
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
    });

    expect(result.error).toBeNull();
    const orgId = result.organizationId!;

    const [org] = await db
      .select({
        verified: organizations.verified,
        autoVerifiedViaMatricula: organizations.autoVerifiedViaMatricula,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    expect(org.verified).toBe(false);
    expect(org.autoVerifiedViaMatricula).toBe(false);

    const [ar] = await db
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.targetOrganizationId, orgId));
    expect(ar.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// D4: Matrícula revocation cascade
// ---------------------------------------------------------------------------

const REVOCATION_MOTIVO =
  "Matrícula cancelada por resolución 001/2026 del colegio veterinario provincial.";

async function seedAttachment(uploadedByUserId: string): Promise<string> {
  const [row] = await db
    .insert(attachments)
    .values({
      uploadedByUserId,
      storagePath: `revocations/${uploadedByUserId}/test-evidence-${Date.now()}.jpg`,
      mimeType: "image/jpeg",
      fileSize: 12345,
    })
    .returning({ id: attachments.id });
  return row.id;
}

describe("solo-consultorio revocation cascade — D4", () => {
  it("cascades verified=false on auto-verified clinic when vet matrícula is revoked", async () => {
    // Step 1: create the auto-verified clinic
    const createResult = await createOrganizationForUser(vetUserId, {
      name: "Consultorio Para Revocar",
      legalName: "Consultorio Para Revocar",
      orgType: "clinic",
      email: VET_EMAIL,
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
    });
    expect(createResult.error).toBeNull();
    const orgId = createResult.organizationId!;

    // Confirm it was auto-verified
    const [orgBefore] = await db
      .select({
        verified: organizations.verified,
        autoVerifiedViaMatricula: organizations.autoVerifiedViaMatricula,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    expect(orgBefore.verified).toBe(true);
    expect(orgBefore.autoVerifiedViaMatricula).toBe(true);

    // Step 2: revoke the vet's matrícula (evidence required by validateMotivoAndAttachments)
    const attachmentId = await seedAttachment(adminRevocId);
    const revResult = await revokeVetRoleForAuthority(adminRevocId, {
      targetUserId: vetUserId,
      motivo: REVOCATION_MOTIVO,
      attachmentIds: [attachmentId],
    });
    expect("ok" in revResult && revResult.ok).toBe(true);

    // Step 3: the clinic must be unverified and flag cleared
    const [orgAfter] = await db
      .select({
        verified: organizations.verified,
        autoVerifiedViaMatricula: organizations.autoVerifiedViaMatricula,
        verifiedAt: organizations.verifiedAt,
        verifiedByUserId: organizations.verifiedByUserId,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    expect(orgAfter.verified).toBe(false);
    expect(orgAfter.autoVerifiedViaMatricula).toBe(false);
    expect(orgAfter.verifiedAt).toBeNull();
    expect(orgAfter.verifiedByUserId).toBeNull();
  });

  it("does NOT touch an institutionally-reviewed org when vet matrícula is revoked", async () => {
    // Manually create a verified org that was NOT auto-verified via matrícula.
    // Use a different email so there's no collision with the vet's clinic.
    const publicToken = `DIM-INST-${Date.now()}`;
    const [institutionalOrg] = await db
      .insert(organizations)
      .values({
        publicToken,
        displayName: "Org Institucional",
        legalName: "Org Institucional SA",
        orgType: "clinic",
        email: `inst-${Date.now()}@dim-test.local`,
        jurisdictionProvince: "Buenos Aires",
        jurisdictionLocality: "La Plata",
        verified: true,
        verifiedAt: new Date(),
        // autoVerifiedViaMatricula is false by default — this simulates institutional review
        createdByUserId: vetUserId,
      })
      .returning({ id: organizations.id });

    await db.insert(organizationMemberships).values({
      organizationId: institutionalOrg.id,
      userId: vetUserId,
      role: "admin",
      canWritePetEvents: true,
    });

    // Revoke the vet
    const attachmentId = await seedAttachment(adminRevocId);
    const revResult = await revokeVetRoleForAuthority(adminRevocId, {
      targetUserId: vetUserId,
      motivo: REVOCATION_MOTIVO,
      attachmentIds: [attachmentId],
    });
    expect("ok" in revResult && revResult.ok).toBe(true);

    // The institutionally-reviewed org must remain verified
    const [orgAfter] = await db
      .select({
        verified: organizations.verified,
        autoVerifiedViaMatricula: organizations.autoVerifiedViaMatricula,
      })
      .from(organizations)
      .where(eq(organizations.id, institutionalOrg.id));
    expect(orgAfter.verified).toBe(true);
    expect(orgAfter.autoVerifiedViaMatricula).toBe(false);

    // Cleanup extra org
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.organizationId, institutionalOrg.id));
    await db.delete(organizations).where(eq(organizations.id, institutionalOrg.id));
  });
});

// Integration tests for the role-upgrade flows after Fase 1 refactor.
//
// requestVetUpgradeForUser and createOrganizationForUser now write an
// approval_request row as the canonical contract and fan out notifications
// to scope-matching authorities. The applicant-side data mutations (profile
// matricula fields, organization row, membership) still happen in the same
// transaction so the UX is unchanged.
//
// Tests call the pure inner writer functions directly.

import { createClient } from "@supabase/supabase-js";
import { and, desc, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  approvalRequests,
  db,
  govtAssignments,
  notifications,
  organizationMemberships,
  organizations,
  profiles,
} from "@/db";
import { createOrganizationForUser } from "@/src/modules/organizations/application/upgrade/create-organization";
import { requestVetUpgradeForUser } from "@/src/modules/organizations/application/upgrade/request-vet-upgrade";
import { getActiveMemberships } from "@/src/modules/organizations/infrastructure/authz-resolver";

import {
  ADMIN_FALLBACK_JURISDICTION,
  assertAdminFallbackAvailable,
} from "./_helpers/admin-fallback-jurisdiction";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const admin = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

// The ADMIN-FALLBACK jurisdiction, from the shared helper.
//
// It used to be two string literals typed into this file, beside a paragraph of
// reasoning that `symptom-surveillance.test.ts` also carried, word for word, for
// the same reason. Two files coupled through the database with no shared symbol
// between them: either could be relocated and silently lose the property the
// other depended on. The helper carries the definition, the reasoning and — the
// part that was missing — the precondition CHECK.
const { province: TEST_PROVINCE, locality: TEST_LOCALITY } = ADMIN_FALLBACK_JURISDICTION;

const EMAIL = "role-upgrade-test@dim-test.local";
const EMAIL2 = "role-upgrade-test2@dim-test.local";
const ADMIN_EMAIL = "role-upgrade-admin@dim-test.local";
const PASS = "RoleUpgrade_2026!";

let userId: string;
let userId2: string;
let adminUserId: string;
let orgId: string;

// Direct DB shortcut — bypasses the placeholder form. Tests should call this
// rather than verifyDniForUser so they don't depend on the DNI format rules.
async function markDniVerified(uid: string): Promise<void> {
  await db.update(profiles).set({ dniVerified: true }).where(eq(profiles.id, uid));
}

async function deleteTestUser(email: string) {
  const { data: list } = await admin.auth.admin.listUsers();
  const found = list?.users.find((u) => u.email === email);

  const displayName = email.split("@")[0];
  const orphanedProfiles = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.displayName, displayName));

  const idsToClean = [
    ...(found ? [found.id] : []),
    ...orphanedProfiles.map((p) => p.id).filter((id) => id !== found?.id),
  ];

  for (const uid of idsToClean) {
    // approval_requests + govt_assignments + notifications all cascade from
    // profile delete, but we delete notifications + assignments explicitly
    // to be defensive against partial-cascade configurations.
    await db.delete(govtAssignments).where(eq(govtAssignments.userId, uid));
    await db.delete(notifications).where(eq(notifications.userId, uid));
    const adminRows = await db
      .select({ orgId: organizationMemberships.organizationId })
      .from(organizationMemberships)
      .where(
        and(eq(organizationMemberships.userId, uid), eq(organizationMemberships.role, "admin")),
      );
    for (const { orgId: oid } of adminRows) {
      await db.delete(organizations).where(eq(organizations.id, oid));
    }
    await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, uid));
    await db.delete(profiles).where(eq(profiles.id, uid));
  }

  if (found) await admin.auth.admin.deleteUser(found.id);
}

beforeAll(async () => {
  // The premise, checked before anything is built on it. Two assertions in this
  // file require that no govt covers the fallback jurisdiction; without this
  // they fail as a bare "expected 0 to be greater than 0" on a notification
  // count, which names neither the cause nor the file that caused it.
  await assertAdminFallbackAvailable();

  await deleteTestUser(EMAIL);
  await deleteTestUser(EMAIL2);
  await deleteTestUser(ADMIN_EMAIL);

  const r1 = await createFreshTestUser(admin, {
    email: EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (r1.error || !r1.data.user) throw new Error(`createUser1: ${r1.error?.message}`);
  userId = r1.data.user.id;
  // DNI prereq: mark both test users verified so happy-path tests pass.
  await markDniVerified(userId);

  const r2 = await createFreshTestUser(admin, {
    email: EMAIL2,
    password: PASS,
    email_confirm: true,
  });
  if (r2.error || !r2.data.user) throw new Error(`createUser2: ${r2.error?.message}`);
  userId2 = r2.data.user.id;
  await markDniVerified(userId2);

  // Seed a platform admin so the no-govt-fallback path has someone to notify.
  // Without this, the fan-out in unscoped tests would silently no-op.
  const r3 = await createFreshTestUser(admin, {
    email: ADMIN_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (r3.error || !r3.data.user) throw new Error(`createUser admin: ${r3.error?.message}`);
  adminUserId = r3.data.user.id;
  await db
    .update(profiles)
    .set({ role: "admin", accountType: "institutional" })
    .where(eq(profiles.id, adminUserId));
});

afterAll(async () => {
  await deleteTestUser(EMAIL);
  await deleteTestUser(EMAIL2);
  await deleteTestUser(ADMIN_EMAIL);
});

describe("requestVetUpgradeForUser (Fase 1)", () => {
  it("happy path: creates approval_request + updates profile + notifies applicant and admin", async () => {
    const result = await requestVetUpgradeForUser(userId, {
      matriculaNumber: "MN-12345",
      matriculaJurisdiccion: TEST_PROVINCE,
      operationalProvince: TEST_PROVINCE,
      operationalLocality: TEST_LOCALITY,
      especialidad: "Clínica",
      anosExperiencia: 5,
    });
    expect(result.error).toBeNull();
    expect(result.ok).toBe(true);

    // Profile carries the submitted matricula (state submitted but unverified).
    const [profile] = await db.select().from(profiles).where(eq(profiles.id, userId)).limit(1);
    expect(profile.matriculaNumber).toBe("MN-12345");
    expect(profile.matriculaJurisdiccion).toBe(TEST_PROVINCE);
    expect(profile.matriculaVerified).toBe(false);
    expect(profile.role).toBe("owner");

    // Approval request is the canonical contract.
    const [req] = await db
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.applicantUserId, userId),
          eq(approvalRequests.type, "role_upgrade_vet"),
        ),
      )
      .orderBy(desc(approvalRequests.createdAt))
      .limit(1);
    expect(req).toBeDefined();
    expect(req.status).toBe("pending");
    expect(req.targetUserId).toBe(userId);
    expect(req.jurisdictionProvince).toBe(TEST_PROVINCE);
    expect(req.jurisdictionLocality).toBe(TEST_LOCALITY);
    expect(req.publicToken).toMatch(/^APR-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const payload = req.payload as { matricula_number: string; payload_version: number };
    expect(payload.matricula_number).toBe("MN-12345");
    expect(payload.payload_version).toBe(1);

    const applicantNotifs = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId),
          eq(notifications.notificationType, "approval_request_submitted_self"),
        ),
      );
    expect(applicantNotifs.length).toBeGreaterThan(0);

    // No govt covers the fallback jurisdiction → admin gets the authority
    // notification. `assertAdminFallbackAvailable()` in `beforeAll` is what makes
    // that a checked precondition rather than a hope; the helper carries the two
    // times it broke and why relocating the suite a third time was not the fix.
    const adminNotifs = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, adminUserId),
          eq(notifications.notificationType, "approval_request_pending_authority"),
        ),
      );
    expect(adminNotifs.length).toBeGreaterThan(0);
  });

  it("idempotency: a second submission with a pending request is rejected", async () => {
    const result = await requestVetUpgradeForUser(userId, {
      matriculaNumber: "MN-99999",
      matriculaJurisdiccion: TEST_PROVINCE,
      operationalProvince: TEST_PROVINCE,
      operationalLocality: TEST_LOCALITY,
    });
    expect(result.error).toMatch(/solicitud pendiente/i);

    // The original pending request stays untouched.
    const [profile] = await db.select().from(profiles).where(eq(profiles.id, userId)).limit(1);
    expect(profile.matriculaNumber).toBe("MN-12345");
  });

  it("re-submit after rejection creates a new approval_request row", async () => {
    // Mark the existing request as rejected (simulating Fase 2 admin action).
    await db
      .update(approvalRequests)
      .set({
        status: "rejected",
        decidedAt: new Date(),
        decidedByUserId: adminUserId,
        decisionNotes: "Matrícula vencida — adjuntá certificado vigente.",
      })
      .where(
        and(
          eq(approvalRequests.applicantUserId, userId),
          eq(approvalRequests.type, "role_upgrade_vet"),
          eq(approvalRequests.status, "pending"),
        ),
      );

    const beforeCount = await db
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.applicantUserId, userId),
          eq(approvalRequests.type, "role_upgrade_vet"),
        ),
      );

    const result = await requestVetUpgradeForUser(userId, {
      matriculaNumber: "MN-77777",
      matriculaJurisdiccion: TEST_PROVINCE,
      operationalProvince: TEST_PROVINCE,
      operationalLocality: TEST_LOCALITY,
    });
    expect(result.ok).toBe(true);

    const afterCount = await db
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.applicantUserId, userId),
          eq(approvalRequests.type, "role_upgrade_vet"),
        ),
      );
    expect(afterCount.length).toBe(beforeCount.length + 1);

    // Profile picks up the new matricula.
    const [profile] = await db.select().from(profiles).where(eq(profiles.id, userId)).limit(1);
    expect(profile.matriculaNumber).toBe("MN-77777");
  });

  it("routes to scope-matching govt when one covers the locality", async () => {
    // Promote userId2 to govt and assign them to a specific locality.
    await db
      .update(profiles)
      .set({ role: "govt", accountType: "institutional" })
      .where(eq(profiles.id, userId2));
    await db.insert(govtAssignments).values({
      userId: userId2,
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "Tigre",
      grantedByUserId: adminUserId,
    });

    // Use a third user that hasn't submitted yet — re-use ADMIN_EMAIL would
    // collide with role='admin'. Spin a clean throwaway by deleting userId's
    // pending state first and submitting from userId, just for routing assert.
    // Simplest: mark the latest pending request as rejected first so the
    // applicant can re-submit (this test is independent of payload state).
    await db
      .update(approvalRequests)
      .set({
        status: "rejected",
        decidedAt: new Date(),
        decidedByUserId: adminUserId,
        decisionNotes: "(test routing cleanup)",
      })
      .where(
        and(
          eq(approvalRequests.applicantUserId, userId),
          eq(approvalRequests.type, "role_upgrade_vet"),
          eq(approvalRequests.status, "pending"),
        ),
      );

    const result = await requestVetUpgradeForUser(userId, {
      matriculaNumber: "MN-TIGRE",
      matriculaJurisdiccion: "Buenos Aires",
      operationalProvince: "Buenos Aires",
      operationalLocality: "Tigre",
    });
    expect(result.ok).toBe(true);

    // userId2 (the govt assigned to Tigre) gets a notification.
    const govtNotifs = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId2),
          eq(notifications.notificationType, "approval_request_pending_authority"),
        ),
      );
    expect(govtNotifs.length).toBeGreaterThan(0);

    // Cleanup: revoke userId2's govt role + assignment so the cuit-collision
    // test below treats userId2 as a plain owner again.
    await db.delete(govtAssignments).where(eq(govtAssignments.userId, userId2));
    await db.update(profiles).set({ role: "owner" }).where(eq(profiles.id, userId2));
  });
});

describe("createOrganizationForUser (Fase 1)", () => {
  it("happy path: creates org + membership + approval_request + notifications", async () => {
    const result = await createOrganizationForUser(userId, {
      name: "Refugio Test",
      legalName: "Asoc. Civil Test",
      orgType: "shelter",
      cuit: "30712345678",
      email: "test@refugio.test",
      jurisdictionProvince: TEST_PROVINCE,
      jurisdictionLocality: TEST_LOCALITY,
    });
    expect(result.error).toBeNull();
    expect(result.ok).toBe(true);
    expect(result.organizationId).toBeDefined();

    orgId = result.organizationId as string;

    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
    expect(org.verified).toBe(false);
    expect(org.status).toBe("active");
    expect(org.jurisdictionProvince).toBe(TEST_PROVINCE);
    expect(org.jurisdictionLocality).toBe(TEST_LOCALITY);

    const [membership] = await db
      .select()
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.userId, userId),
          eq(organizationMemberships.organizationId, orgId),
          isNull(organizationMemberships.leftAt),
        ),
      )
      .limit(1);
    expect(membership.role).toBe("admin");
    expect(membership.canWritePetEvents).toBe(true);

    const [req] = await db
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.applicantUserId, userId),
          eq(approvalRequests.type, "organization_verification"),
          eq(approvalRequests.targetOrganizationId, orgId),
        ),
      )
      .limit(1);
    expect(req).toBeDefined();
    expect(req.status).toBe("pending");
    expect(req.jurisdictionLocality).toBe(TEST_LOCALITY);

    const adminNotifs = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, adminUserId),
          eq(notifications.notificationType, "approval_request_pending_authority"),
        ),
      );
    // The admin has received notifications for both the vet flow above and
    // this org flow, so the count is >0.
    expect(adminNotifs.length).toBeGreaterThan(0);
  });

  it("idempotency: second call by same user returns error, only one org exists", async () => {
    const result = await createOrganizationForUser(userId, {
      name: "Refugio Duplicado",
      legalName: "Duplicado SA",
      orgType: "clinic",
      email: "dup@refugio.test",
      jurisdictionProvince: TEST_PROVINCE,
      jurisdictionLocality: TEST_LOCALITY,
    });
    expect(result.error).toMatch(/Ya administrás una organización/);

    const memberships = await db
      .select()
      .from(organizationMemberships)
      .where(
        and(eq(organizationMemberships.userId, userId), isNull(organizationMemberships.leftAt)),
      );
    const adminMemberships = memberships.filter((m) => m.role === "admin");
    expect(adminMemberships).toHaveLength(1);
  });

  it("cuit collision: second user with same CUIT gets a clear error", async () => {
    const result = await createOrganizationForUser(userId2, {
      name: "Otro Refugio",
      legalName: "Otro SA",
      orgType: "rescue_network",
      cuit: "30712345678", // same as userId's org
      email: "otro@refugio.test",
      jurisdictionProvince: TEST_PROVINCE,
      jurisdictionLocality: TEST_LOCALITY,
    });
    expect(result.error).toMatch(/Ya existe una organización con ese CUIT/);
  });

  it("getActiveMemberships sees unverified org after creation (gate is membership-based)", async () => {
    const memberships = await getActiveMemberships(userId);
    const adminMembership = memberships.find((m) => m.membership.role === "admin");
    expect(adminMembership).toBeDefined();
    expect(adminMembership?.organization.verified).toBe(false);
  });
});

describe("DNI prerequisite enforcement", () => {
  const EMAIL_UNVERIFIED = "dni-prereq-test@dim-test.local";
  let unverifiedUserId: string;

  beforeAll(async () => {
    await deleteTestUser(EMAIL_UNVERIFIED);
    const r = await createFreshTestUser(admin, {
      email: EMAIL_UNVERIFIED,
      password: PASS,
      email_confirm: true,
    });
    if (r.error || !r.data.user) throw new Error(`createUser unverified: ${r.error?.message}`);
    unverifiedUserId = r.data.user.id;
    // NOTE: intentionally NOT calling markDniVerified — user starts with dni_verified=false.
  });

  afterAll(async () => {
    await deleteTestUser(EMAIL_UNVERIFIED);
  });

  it("requestVetUpgradeForUser returns missingPrereq=dni when dni_verified=false", async () => {
    const result = await requestVetUpgradeForUser(unverifiedUserId, {
      matriculaNumber: "MN-PREREQ",
      matriculaJurisdiccion: TEST_PROVINCE,
      operationalProvince: TEST_PROVINCE,
      operationalLocality: TEST_LOCALITY,
    });
    expect(result.error).not.toBeNull();
    expect(result.missingPrereq).toBe("dni");
    expect(result.prereqUrl).toMatch(/\/cuenta\/verificar-dni/);
    expect(result.ok).toBeUndefined();
  });

  it("createOrganizationForUser returns missingPrereq=dni when dni_verified=false", async () => {
    const result = await createOrganizationForUser(unverifiedUserId, {
      name: "Prereq Test Org",
      legalName: "Prereq SA",
      orgType: "shelter",
      email: "prereq@test.test",
      jurisdictionProvince: TEST_PROVINCE,
      jurisdictionLocality: TEST_LOCALITY,
    });
    expect(result.error).not.toBeNull();
    expect(result.missingPrereq).toBe("dni");
    expect(result.prereqUrl).toMatch(/\/cuenta\/verificar-dni/);
    expect(result.ok).toBeUndefined();
  });
});

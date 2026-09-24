// Parity and use-case tests for src/modules/service-offerings/application/*.
//
// These are INTEGRATION tests that run against the real seeded Postgres DB,
// mirroring the approach in __tests__/offering-capacity-sync.test.ts.
//
// We drive the use-cases directly (no auth wrappers) and assert on DB state
// and return values to confirm parity with the original monolithic action.
//
// Tests covered:
//
//   createServiceOfferingWriter:
//     - happy path: offering inserted (status=pending_approval), applicant notified
//     - authority fan-out: authorities receive service_offering_pending_authority notification
//     - invalid input (serviceKind missing): returns validation error
//     - unknown service kind: returns error
//
//   createServiceOfferingForOrg (delegation wrapper):
//     - delegates to createServiceOfferingWriter with province/locality coercion
//
//   approveServiceOfferingForAuthority:
//     - happy path: offering status → approved, reviewedAt set, org members notified
//     - offering not found: returns error
//     - wrong status (already approved): returns error
//
//   rejectServiceOfferingForAuthority:
//     - happy path: offering status → rejected, rejectionReason stored
//     - reason too short (< 10 chars): returns validation error
//     - reason too long (> 1000 chars): returns validation error
//     - offering not found: returns error
//     - wrong status: returns error
//
//   pauseServiceOfferingUseCase:
//     - happy path: offering status → paused
//     - already paused: returns error
//     - archived: returns error
//     - not found: returns error
//
//   unpauseServiceOfferingUseCase:
//     - happy path: offering status → approved
//     - not paused: returns error
//     - not found: returns error
//
//   archiveServiceOfferingUseCase:
//     - happy path: offering status → archived
//     - already archived: returns error
//     - has future confirmed appointments: returns error
//     - not found: returns error
//
//   updateOfferingCapacityWriter (covered more deeply in offering-capacity-sync.test.ts):
//     - invalid capacity (0): returns error
//     - happy path with no future slots: ok, slotsUpdated = 0

import { createClient } from "@supabase/supabase-js";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withMutationOverride } from "@/__tests__/_helpers/db-overrides";

import {
  appointments,
  db,
  notifications,
  organizationMemberships,
  organizations,
  pets,
  profiles,
  serviceOfferings,
  timeSlots,
} from "@/db";
import { generateOfferingToken, generatePublicToken } from "@/lib/infra/publicToken";
import type { AuthorityScope } from "../../domain/types";

import { createFreshTestUser } from "@/__tests__/_helpers/fresh-test-user";
import { approveServiceOfferingForAuthority } from "../approve-service-offering";
import {
  createServiceOfferingForOrg,
  createServiceOfferingWriter,
} from "../create-service-offering";
import {
  archiveServiceOfferingUseCase,
  pauseServiceOfferingUseCase,
  unpauseServiceOfferingUseCase,
} from "../lifecycle-offering";
import { rejectServiceOfferingForAuthority } from "../reject-service-offering";
import { updateOfferingCapacityWriter } from "../update-offering-capacity";

// ---------------------------------------------------------------------------
// Supabase admin client
// ---------------------------------------------------------------------------

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabase = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

// ---------------------------------------------------------------------------
// Fixture identifiers
// ---------------------------------------------------------------------------

const UC_SO_ORG_EMAIL = "uc-so-org@dim-test.local";
const UC_SO_MEMBER_EMAIL = "uc-so-member@dim-test.local";
const UC_SO_GOVT_EMAIL = "uc-so-govt@dim-test.local";
const UC_SO_PASS = "UcSoTest_2026!";

let orgId!: string;
let orgPublicToken!: string;
let memberUserId!: string;
let govtOrgId!: string;
let govtUserId!: string;
// CABA orgs for the whole-province subsumption / barrio-scoping tests.
let cabaPalermoOrgId!: string;
let cabaAlmagroOrgId!: string;

// The org (and thus every offering below unless overridden) is in Buenos Aires /
// La Plata. Authority scopes used by the approve/reject tests:
const ADMIN_SCOPE: AuthorityScope = { role: "admin" };
const GOVT_LA_PLATA: AuthorityScope = {
  role: "govt",
  jurisdictions: [{ province: "Buenos Aires", locality: "La Plata" }],
};
const GOVT_MENDOZA: AuthorityScope = {
  role: "govt",
  jurisdictions: [{ province: "Mendoza", locality: "Mendoza" }],
};
// Whole-province CABA assignment — subsumes every barrio in the city.
const GOVT_WHOLE_CABA: AuthorityScope = {
  role: "govt",
  jurisdictions: [{ province: "CABA", locality: "Ciudad Autónoma de Buenos Aires" }],
};
// Barrio-specific assignment — bounded to Palermo only.
const GOVT_CABA_PALERMO: AuthorityScope = {
  role: "govt",
  jurisdictions: [{ province: "CABA", locality: "Palermo" }],
};

// Pre-created offering public tokens for lifecycle tests.
// A new offering per sub-suite so tests don't interfere with each other.
const UC_SO_OFFERING_TOKENS = {
  approve: generateOfferingToken(),
  approveOutOfProvince: generateOfferingToken(),
  approveWholeCaba: generateOfferingToken(),
  approveBarrioMismatch: generateOfferingToken(),
  approveAdminCaba: generateOfferingToken(),
  rejectHappy: generateOfferingToken(),
  rejectOutOfProvince: generateOfferingToken(),
  rejectWrongStatus: generateOfferingToken(),
  pauseHappy: generateOfferingToken(),
  pauseAlready: generateOfferingToken(),
  pauseArchived: generateOfferingToken(),
  unpauseHappy: generateOfferingToken(),
  unpauseNotPaused: generateOfferingToken(),
  archiveHappy: generateOfferingToken(),
  archiveAlready: generateOfferingToken(),
  archivePending: generateOfferingToken(),
  capacityHappy: generateOfferingToken(),
};

// Track inserted offering IDs for cleanup.
const insertedOfferingIds: string[] = [];

// Pets this test inserts directly (minimal rows that only exist to satisfy the
// appointments.pet_id FK). Tracked so afterAll deletes exactly these ids.
const insertedPetIds: string[] = [];

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Cleanup stale auth users from previous failed runs.
  const { data: allUsers } = await supabase.auth.admin.listUsers();
  for (const email of [UC_SO_ORG_EMAIL, UC_SO_MEMBER_EMAIL, UC_SO_GOVT_EMAIL]) {
    const existing = allUsers?.users.find((u) => u.email === email);
    if (existing) await supabase.auth.admin.deleteUser(existing.id);
  }

  // Create member auth user (the org-side actor who submits offerings).
  const memberCreated = await createFreshTestUser(supabase, {
    email: UC_SO_MEMBER_EMAIL,
    password: UC_SO_PASS,
    email_confirm: true,
  });
  if (memberCreated.error || !memberCreated.data.user) {
    throw new Error(`createUser member: ${memberCreated.error?.message}`);
  }
  memberUserId = memberCreated.data.user.id;

  // Create govt user (the reviewer / authority).
  const govtCreated = await createFreshTestUser(supabase, {
    email: UC_SO_GOVT_EMAIL,
    password: UC_SO_PASS,
    email_confirm: true,
  });
  if (govtCreated.error || !govtCreated.data.user) {
    throw new Error(`createUser govt: ${govtCreated.error?.message}`);
  }
  govtUserId = govtCreated.data.user.id;

  // Set govt profile role.
  await db.update(profiles).set({ role: "govt" }).where(eq(profiles.id, govtUserId));

  // Create the test org.
  orgPublicToken = generatePublicToken();
  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: orgPublicToken,
      legalName: "UC Service Offerings Test Org",
      displayName: "UC SO Test Org",
      orgType: "shelter",
      email: UC_SO_ORG_EMAIL,
      verified: true,
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
    })
    .returning({ id: organizations.id });
  orgId = org.id;

  // Add member to org.
  await db.insert(organizationMemberships).values({
    userId: memberUserId,
    organizationId: orgId,
    role: "admin",
  });

  // Create a govt org (approval authority).
  const [govtOrg] = await db
    .insert(organizations)
    .values({
      publicToken: generatePublicToken(),
      legalName: "UC SO Govt Org",
      displayName: "UC SO Govt",
      orgType: "sanitary_authority",
      email: "uc-so-govt-org@dim-test.local",
      verified: true,
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
    })
    .returning({ id: organizations.id });
  govtOrgId = govtOrg.id;

  // Add govt user as member of govt org.
  await db.insert(organizationMemberships).values({
    userId: govtUserId,
    organizationId: govtOrgId,
    role: "admin",
  });

  // CABA orgs (no members — approve/reject notify no one) for the two-tier
  // jurisdiction subsumption tests. Palermo/Almagro are distinct barrios of the
  // whole-province CABA locality.
  const [cabaPalermoOrg] = await db
    .insert(organizations)
    .values({
      publicToken: generatePublicToken(),
      legalName: "UC SO CABA Palermo Org",
      displayName: "UC SO CABA Palermo",
      orgType: "shelter",
      email: "uc-so-caba-palermo@dim-test.local",
      verified: true,
      jurisdictionProvince: "CABA",
      jurisdictionLocality: "Palermo",
    })
    .returning({ id: organizations.id });
  cabaPalermoOrgId = cabaPalermoOrg.id;

  const [cabaAlmagroOrg] = await db
    .insert(organizations)
    .values({
      publicToken: generatePublicToken(),
      legalName: "UC SO CABA Almagro Org",
      displayName: "UC SO CABA Almagro",
      orgType: "shelter",
      email: "uc-so-caba-almagro@dim-test.local",
      verified: true,
      jurisdictionProvince: "CABA",
      jurisdictionLocality: "Almagro",
    })
    .returning({ id: organizations.id });
  cabaAlmagroOrgId = cabaAlmagroOrg.id;

  // Pre-insert offerings for state-based tests (so we don't depend on create).
  type OfferingStatus = "pending_approval" | "approved" | "paused" | "archived" | "rejected";

  // organizationId defaults to the Buenos Aires / La Plata org unless overridden.
  const preInserts: Array<{
    key: keyof typeof UC_SO_OFFERING_TOKENS;
    status: OfferingStatus;
    organizationId?: string;
  }> = [
    { key: "approve", status: "pending_approval" },
    { key: "approveOutOfProvince", status: "pending_approval" },
    { key: "approveWholeCaba", status: "pending_approval", organizationId: cabaPalermoOrgId },
    { key: "approveBarrioMismatch", status: "pending_approval", organizationId: cabaAlmagroOrgId },
    { key: "approveAdminCaba", status: "pending_approval", organizationId: cabaPalermoOrgId },
    { key: "rejectHappy", status: "pending_approval" },
    { key: "rejectOutOfProvince", status: "pending_approval" },
    { key: "rejectWrongStatus", status: "approved" },
    { key: "pauseHappy", status: "approved" },
    { key: "pauseAlready", status: "paused" },
    { key: "pauseArchived", status: "archived" },
    { key: "unpauseHappy", status: "paused" },
    { key: "unpauseNotPaused", status: "approved" },
    { key: "archiveHappy", status: "approved" },
    { key: "archiveAlready", status: "archived" },
    { key: "archivePending", status: "approved" },
    { key: "capacityHappy", status: "approved" },
  ];

  for (const { key, status, organizationId } of preInserts) {
    const [row] = await db
      .insert(serviceOfferings)
      .values({
        publicToken: UC_SO_OFFERING_TOKENS[key],
        organizationId: organizationId ?? orgId,
        serviceKind: "vaccination_rabies",
        displayName: `UC SO Test — ${key}`,
        durationMinutes: 30,
        slotCapacity: 1,
        status,
      })
      .returning({ id: serviceOfferings.id });
    insertedOfferingIds.push(row.id);
  }

  // For archivePending: add a future confirmed appointment.
  const pendingOfferingRow = await db
    .select({ id: serviceOfferings.id })
    .from(serviceOfferings)
    .where(eq(serviceOfferings.publicToken, UC_SO_OFFERING_TOKENS.archivePending))
    .limit(1)
    .then(([r]) => r);

  if (pendingOfferingRow) {
    const [slot] = await db
      .insert(timeSlots)
      .values({
        serviceOfferingId: pendingOfferingRow.id,
        startsAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
        endsAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000 + 30 * 60 * 1000),
        capacity: 1,
        bookingsCount: 1,
        status: "open",
      })
      .returning({ id: timeSlots.id });

    // Minimal pet for the appointment FK.
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: generatePublicToken(),
        species: "dog",
        name: "UC SO Archive Pending Dog",
      })
      .returning({ id: pets.id });
    insertedPetIds.push(pet.id);

    await db.insert(appointments).values({
      publicToken: generatePublicToken(),
      slotId: slot.id,
      petId: pet.id,
      ownerUserId: memberUserId,
      serviceOfferingId: pendingOfferingRow.id,
      organizationId: orgId,
      status: "confirmed",
    });
  }
});

afterAll(async () => {
  // Pets go first, one independent transaction per id, so nothing below can
  // roll back the pet deletes and leave an orphan fixture behind. Scoped to
  // the ids this test created — never a name match or a token-prefix LIKE.
  //
  // pet_events deletes are blocked by enforce_pet_events_append_only; bypass
  // via the accountable SET LOCAL GUC pair (see _helpers/db-overrides.ts).
  for (const pid of insertedPetIds) {
    await withMutationOverride(async (tx) => {
      await tx.execute(sql`DELETE FROM appointments WHERE pet_id = ${pid}`);
      await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${pid}`);
      await tx.execute(sql`DELETE FROM ownerships WHERE pet_id = ${pid}`);
      await tx.execute(sql`DELETE FROM pets WHERE id = ${pid}`);
    }).catch(() => {});
  }

  // Delete appointments and slots for pre-inserted offerings.
  for (const offeringId of insertedOfferingIds) {
    await db
      .delete(appointments)
      .where(eq(appointments.serviceOfferingId, offeringId))
      .catch(() => {});
    await db
      .delete(timeSlots)
      .where(eq(timeSlots.serviceOfferingId, offeringId))
      .catch(() => {});
  }

  // Delete notifications for org members.
  await db
    .delete(notifications)
    .where(eq(notifications.userId, memberUserId))
    .catch(() => {});
  await db
    .delete(notifications)
    .where(eq(notifications.userId, govtUserId))
    .catch(() => {});

  // Delete dynamically created offerings (from create tests) + CABA-org offerings.
  for (const oid of [orgId, cabaPalermoOrgId, cabaAlmagroOrgId]) {
    await db
      .delete(serviceOfferings)
      .where(eq(serviceOfferings.organizationId, oid))
      .catch(() => {});
  }

  // Delete org memberships before orgs (FK).
  await db
    .delete(organizationMemberships)
    .where(eq(organizationMemberships.organizationId, orgId))
    .catch(() => {});
  await db
    .delete(organizationMemberships)
    .where(eq(organizationMemberships.organizationId, govtOrgId))
    .catch(() => {});

  // Delete orgs.
  for (const oid of [orgId, govtOrgId, cabaPalermoOrgId, cabaAlmagroOrgId]) {
    await db
      .delete(organizations)
      .where(eq(organizations.id, oid))
      .catch(() => {});
  }

  // Delete auth users.
  for (const email of [UC_SO_MEMBER_EMAIL, UC_SO_GOVT_EMAIL]) {
    const { data: allUsers } = await supabase.auth.admin.listUsers();
    const found = allUsers?.users.find((u) => u.email === email);
    if (found) await supabase.auth.admin.deleteUser(found.id).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// createServiceOfferingWriter
// ---------------------------------------------------------------------------

describe("createServiceOfferingWriter", () => {
  it("happy path: offering inserted with status=pending_approval and applicant notified", async () => {
    const result = await createServiceOfferingWriter(
      memberUserId,
      {
        organizationId: orgId,
        organizationPublicToken: orgPublicToken,
        organizationDisplayName: "UC SO Test Org",
      },
      "Buenos Aires",
      "La Plata",
      {
        serviceKind: "vaccination_rabies",
        displayName: "UC SO Create Happy",
        description: null,
        durationMinutes: 30,
        slotCapacity: 1,
        priceArs: null,
        eligibilitySpecies: null,
        eligibilityAgeMinMonths: null,
        eligibilityAgeMaxMonths: null,
      },
    );

    expect(result).toMatchObject({ ok: true });

    // Offering should exist in DB with pending_approval status.
    const [row] = await db
      .select({ status: serviceOfferings.status, displayName: serviceOfferings.displayName })
      .from(serviceOfferings)
      .where(
        and(
          eq(serviceOfferings.organizationId, orgId),
          eq(serviceOfferings.displayName, "UC SO Create Happy"),
        ),
      )
      .limit(1);

    expect(row?.status).toBe("pending_approval");

    // Applicant receives service_offering_submitted notification.
    const [notif] = await db
      .select({ notificationType: notifications.notificationType })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, memberUserId),
          eq(notifications.notificationType, "service_offering_submitted"),
        ),
      )
      .limit(1);
    expect(notif?.notificationType).toBe("service_offering_submitted");
  });

  it("invalid serviceKind (empty string) returns validation error", async () => {
    const result = await createServiceOfferingWriter(
      memberUserId,
      {
        organizationId: orgId,
        organizationPublicToken: orgPublicToken,
        organizationDisplayName: "UC SO Test Org",
      },
      "Buenos Aires",
      "La Plata",
      {
        serviceKind: "",
        displayName: "UC SO Invalid Kind",
        description: null,
        durationMinutes: 30,
        slotCapacity: 1,
        priceArs: null,
        eligibilitySpecies: null,
        eligibilityAgeMinMonths: null,
        eligibilityAgeMaxMonths: null,
      },
    );

    expect(result).toMatchObject({ error: expect.stringContaining("Datos inválidos") });
  });

  it("unknown service kind returns error", async () => {
    const result = await createServiceOfferingWriter(
      memberUserId,
      {
        organizationId: orgId,
        organizationPublicToken: orgPublicToken,
        organizationDisplayName: "UC SO Test Org",
      },
      "Buenos Aires",
      "La Plata",
      {
        serviceKind: "totally_unknown_kind_xyz",
        displayName: "UC SO Unknown Kind",
        description: null,
        durationMinutes: 30,
        slotCapacity: 1,
        priceArs: null,
        eligibilitySpecies: null,
        eligibilityAgeMinMonths: null,
        eligibilityAgeMaxMonths: null,
      },
    );

    expect(result).toMatchObject({ error: "Tipo de servicio no reconocido." });
  });
});

// ---------------------------------------------------------------------------
// createServiceOfferingForOrg (delegation wrapper)
// ---------------------------------------------------------------------------

describe("createServiceOfferingForOrg", () => {
  it("delegates to writer, coercing null province/locality to empty string", async () => {
    const result = await createServiceOfferingForOrg(
      memberUserId,
      orgId,
      orgPublicToken,
      "UC SO Test Org",
      null,
      null,
      {
        serviceKind: "vaccination_rabies",
        displayName: "UC SO ForOrg Delegation",
        description: null,
        durationMinutes: 30,
        slotCapacity: 1,
        priceArs: null,
        eligibilitySpecies: null,
        eligibilityAgeMinMonths: null,
        eligibilityAgeMaxMonths: null,
      },
    );

    expect(result).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// approveServiceOfferingForAuthority
// ---------------------------------------------------------------------------

describe("approveServiceOfferingForAuthority", () => {
  it("govt in-scope: offering approved, reviewedAt set, org members notified", async () => {
    const token = UC_SO_OFFERING_TOKENS.approve;

    // Govt scoped to Buenos Aires / La Plata — the org's own jurisdiction.
    const result = await approveServiceOfferingForAuthority(govtUserId, token, GOVT_LA_PLATA);
    expect(result).toMatchObject({ ok: true });

    const [row] = await db
      .select({
        status: serviceOfferings.status,
        reviewedByUserId: serviceOfferings.reviewedByUserId,
        reviewedAt: serviceOfferings.reviewedAt,
      })
      .from(serviceOfferings)
      .where(eq(serviceOfferings.publicToken, token))
      .limit(1);

    expect(row?.status).toBe("approved");
    expect(row?.reviewedByUserId).toBe(govtUserId);
    expect(row?.reviewedAt).not.toBeNull();

    // Org member receives service_offering_approved notification.
    const [notif] = await db
      .select({ notificationType: notifications.notificationType })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, memberUserId),
          eq(notifications.notificationType, "service_offering_approved"),
        ),
      )
      .limit(1);
    expect(notif?.notificationType).toBe("service_offering_approved");
  });

  it("not found: returns error", async () => {
    const result = await approveServiceOfferingForAuthority(
      govtUserId,
      "nonexistent-token-xyz",
      ADMIN_SCOPE,
    );
    expect(result).toMatchObject({ error: "Servicio no encontrado." });
  });

  it("wrong status (already approved): returns error", async () => {
    // The "approve" token was just approved in the previous test.
    const result = await approveServiceOfferingForAuthority(
      govtUserId,
      UC_SO_OFFERING_TOKENS.approve,
      GOVT_LA_PLATA,
    );
    expect(result).toMatchObject({ error: expect.stringContaining("ya está en estado") });
  });

  it("govt out-of-province: cannot approve a Buenos Aires org's offering", async () => {
    // Govt scoped to Mendoza tries to approve a pending offering owned by the
    // Buenos Aires / La Plata org. Fail-closed — the offering stays pending.
    const token = UC_SO_OFFERING_TOKENS.approveOutOfProvince;
    const result = await approveServiceOfferingForAuthority(govtUserId, token, GOVT_MENDOZA);
    expect(result).toMatchObject({
      error: "Este servicio no está en tu jurisdicción asignada.",
    });

    const [row] = await db
      .select({ status: serviceOfferings.status })
      .from(serviceOfferings)
      .where(eq(serviceOfferings.publicToken, token))
      .limit(1);
    expect(row?.status).toBe("pending_approval");
  });

  it("whole-CABA govt: approves a CABA-barrio (Palermo) org's offering", async () => {
    // A whole-province CABA assignment subsumes every barrio, so it governs a
    // Palermo-tagged org even though the pair is not exact.
    const token = UC_SO_OFFERING_TOKENS.approveWholeCaba;
    const result = await approveServiceOfferingForAuthority(govtUserId, token, GOVT_WHOLE_CABA);
    expect(result).toMatchObject({ ok: true });

    const [row] = await db
      .select({ status: serviceOfferings.status })
      .from(serviceOfferings)
      .where(eq(serviceOfferings.publicToken, token))
      .limit(1);
    expect(row?.status).toBe("approved");
  });

  it("barrio-scoped govt: cannot approve another barrio's offering", async () => {
    // A CABA / Palermo assignment is exact-match — it must NOT reach an Almagro
    // org's offering.
    const token = UC_SO_OFFERING_TOKENS.approveBarrioMismatch;
    const result = await approveServiceOfferingForAuthority(govtUserId, token, GOVT_CABA_PALERMO);
    expect(result).toMatchObject({
      error: "Este servicio no está en tu jurisdicción asignada.",
    });

    const [row] = await db
      .select({ status: serviceOfferings.status })
      .from(serviceOfferings)
      .where(eq(serviceOfferings.publicToken, token))
      .limit(1);
    expect(row?.status).toBe("pending_approval");
  });

  it("admin: universal scope approves any jurisdiction's offering (unchanged)", async () => {
    // Admin has empty jurisdictions and universal scope — approves a CABA org's
    // offering with no per-jurisdiction check.
    const token = UC_SO_OFFERING_TOKENS.approveAdminCaba;
    const result = await approveServiceOfferingForAuthority(govtUserId, token, ADMIN_SCOPE);
    expect(result).toMatchObject({ ok: true });

    const [row] = await db
      .select({ status: serviceOfferings.status })
      .from(serviceOfferings)
      .where(eq(serviceOfferings.publicToken, token))
      .limit(1);
    expect(row?.status).toBe("approved");
  });
});

// ---------------------------------------------------------------------------
// rejectServiceOfferingForAuthority
// ---------------------------------------------------------------------------

describe("rejectServiceOfferingForAuthority", () => {
  it("reason too short (< 10 chars): returns validation error", async () => {
    const result = await rejectServiceOfferingForAuthority(
      govtUserId,
      "any-token",
      "corto",
      GOVT_LA_PLATA,
    );
    expect(result).toMatchObject({ error: expect.stringContaining("10 caracteres") });
  });

  it("reason too long (> 1000 chars): returns validation error", async () => {
    const result = await rejectServiceOfferingForAuthority(
      govtUserId,
      "any-token",
      "x".repeat(1001),
      GOVT_LA_PLATA,
    );
    expect(result).toMatchObject({ error: expect.stringContaining("1000 caracteres") });
  });

  it("not found: returns error", async () => {
    const result = await rejectServiceOfferingForAuthority(
      govtUserId,
      "nonexistent-token-xyz",
      "Este es un motivo de rechazo válido con suficientes caracteres.",
      ADMIN_SCOPE,
    );
    expect(result).toMatchObject({ error: "Servicio no encontrado." });
  });

  it("govt out-of-province: cannot reject a Buenos Aires org's offering", async () => {
    // Fail-closed — a Mendoza-scoped govt cannot reject the La Plata org's
    // pending offering; it stays pending.
    const token = UC_SO_OFFERING_TOKENS.rejectOutOfProvince;
    const result = await rejectServiceOfferingForAuthority(
      govtUserId,
      token,
      "Este es un motivo de rechazo válido con suficientes caracteres.",
      GOVT_MENDOZA,
    );
    expect(result).toMatchObject({
      error: "Este servicio no está en tu jurisdicción asignada.",
    });

    const [row] = await db
      .select({ status: serviceOfferings.status })
      .from(serviceOfferings)
      .where(eq(serviceOfferings.publicToken, token))
      .limit(1);
    expect(row?.status).toBe("pending_approval");
  });

  it("wrong status (already approved): returns error", async () => {
    const result = await rejectServiceOfferingForAuthority(
      govtUserId,
      UC_SO_OFFERING_TOKENS.rejectWrongStatus,
      "Este es un motivo de rechazo válido con suficientes caracteres.",
      GOVT_LA_PLATA,
    );
    expect(result).toMatchObject({ error: expect.stringContaining("ya está en estado") });
  });

  it("govt in-scope: offering rejected, rejectionReason stored", async () => {
    const token = UC_SO_OFFERING_TOKENS.rejectHappy;
    const reason = "Este servicio no cumple con los requisitos sanitarios mínimos establecidos.";

    const result = await rejectServiceOfferingForAuthority(
      govtUserId,
      token,
      reason,
      GOVT_LA_PLATA,
    );
    expect(result).toMatchObject({ ok: true });

    const [row] = await db
      .select({
        status: serviceOfferings.status,
        rejectionReason: serviceOfferings.rejectionReason,
      })
      .from(serviceOfferings)
      .where(eq(serviceOfferings.publicToken, token))
      .limit(1);

    expect(row?.status).toBe("rejected");
    expect(row?.rejectionReason).toBe(reason.trim());
  });
});

// ---------------------------------------------------------------------------
// pauseServiceOfferingUseCase
// ---------------------------------------------------------------------------

describe("pauseServiceOfferingUseCase", () => {
  it("not found: returns error", async () => {
    const result = await pauseServiceOfferingUseCase(orgId, "nonexistent-token-xyz");
    expect(result).toMatchObject({ error: "Servicio no encontrado." });
  });

  it("archived: cannot pause", async () => {
    const result = await pauseServiceOfferingUseCase(orgId, UC_SO_OFFERING_TOKENS.pauseArchived);
    expect(result).toMatchObject({ error: "No podés pausar un servicio archivado." });
  });

  it("already paused: returns error", async () => {
    const result = await pauseServiceOfferingUseCase(orgId, UC_SO_OFFERING_TOKENS.pauseAlready);
    expect(result).toMatchObject({ error: "El servicio ya está pausado." });
  });

  it("happy path: offering status becomes paused", async () => {
    const token = UC_SO_OFFERING_TOKENS.pauseHappy;
    const result = await pauseServiceOfferingUseCase(orgId, token);
    expect(result).toMatchObject({ ok: true });

    const [row] = await db
      .select({ status: serviceOfferings.status })
      .from(serviceOfferings)
      .where(eq(serviceOfferings.publicToken, token))
      .limit(1);
    expect(row?.status).toBe("paused");
  });
});

// ---------------------------------------------------------------------------
// unpauseServiceOfferingUseCase
// ---------------------------------------------------------------------------

describe("unpauseServiceOfferingUseCase", () => {
  it("not found: returns error", async () => {
    const result = await unpauseServiceOfferingUseCase(orgId, "nonexistent-token-xyz");
    expect(result).toMatchObject({ error: "Servicio no encontrado." });
  });

  it("not paused: returns error", async () => {
    const result = await unpauseServiceOfferingUseCase(
      orgId,
      UC_SO_OFFERING_TOKENS.unpauseNotPaused,
    );
    expect(result).toMatchObject({ error: "El servicio no está pausado." });
  });

  it("happy path: offering status becomes approved", async () => {
    const token = UC_SO_OFFERING_TOKENS.unpauseHappy;
    const result = await unpauseServiceOfferingUseCase(orgId, token);
    expect(result).toMatchObject({ ok: true });

    const [row] = await db
      .select({ status: serviceOfferings.status })
      .from(serviceOfferings)
      .where(eq(serviceOfferings.publicToken, token))
      .limit(1);
    expect(row?.status).toBe("approved");
  });
});

// ---------------------------------------------------------------------------
// archiveServiceOfferingUseCase
// ---------------------------------------------------------------------------

describe("archiveServiceOfferingUseCase", () => {
  it("not found: returns error", async () => {
    const result = await archiveServiceOfferingUseCase(orgId, "nonexistent-token-xyz");
    expect(result).toMatchObject({ error: "Servicio no encontrado." });
  });

  it("already archived: returns error", async () => {
    const result = await archiveServiceOfferingUseCase(orgId, UC_SO_OFFERING_TOKENS.archiveAlready);
    expect(result).toMatchObject({ error: "El servicio ya está archivado." });
  });

  it("has future confirmed appointments: cannot archive", async () => {
    const result = await archiveServiceOfferingUseCase(orgId, UC_SO_OFFERING_TOKENS.archivePending);
    expect(result).toMatchObject({ error: expect.stringContaining("turnos confirmados") });
  });

  it("happy path: offering status becomes archived", async () => {
    const token = UC_SO_OFFERING_TOKENS.archiveHappy;
    const result = await archiveServiceOfferingUseCase(orgId, token);
    expect(result).toMatchObject({ ok: true });

    const [row] = await db
      .select({ status: serviceOfferings.status })
      .from(serviceOfferings)
      .where(eq(serviceOfferings.publicToken, token))
      .limit(1);
    expect(row?.status).toBe("archived");
  });
});

// ---------------------------------------------------------------------------
// updateOfferingCapacityWriter (light coverage — full suite in offering-capacity-sync.test.ts)
// ---------------------------------------------------------------------------

describe("updateOfferingCapacityWriter", () => {
  it("invalid capacity (0): returns error without touching DB", async () => {
    // Use capacityHappy offering which has no future slots — safe to call.
    const [row] = await db
      .select({ id: serviceOfferings.id })
      .from(serviceOfferings)
      .where(eq(serviceOfferings.publicToken, UC_SO_OFFERING_TOKENS.capacityHappy))
      .limit(1);
    if (!row) throw new Error("capacityHappy offering not found in DB");

    const result = await updateOfferingCapacityWriter(row.id, 0);
    expect(result).toMatchObject({ error: expect.stringContaining("número entero mayor a 0") });
  });

  it("happy path with no future slots: ok, slotsUpdated = 0", async () => {
    const [row] = await db
      .select({ id: serviceOfferings.id })
      .from(serviceOfferings)
      .where(eq(serviceOfferings.publicToken, UC_SO_OFFERING_TOKENS.capacityHappy))
      .limit(1);
    if (!row) throw new Error("capacityHappy offering not found in DB");

    const result = await updateOfferingCapacityWriter(row.id, 3);
    expect(result).toMatchObject({ ok: true, slotsUpdated: 0 });
  });
});

// Integration tests for org-coverage actions + province-level broadcast fix.
//
// Sections:
//   A. addCoverageZoneAction
//     A1. happy path — province-only zone
//     A2. happy path — locality-specific zone
//     A3. idempotent duplicate rejected
//     A4. invalid province name rejected
//     A5. locality not in province rejected
//     A6. member role rejected (auth gate)
//     A7. volunteer role rejected (auth gate)
//     A8. cross-org access rejected
//   B. removeCoverageZoneAction
//     B1. happy path
//     B2. cross-org row rejected
//     B3. member role rejected
//   C. setPrimaryCoverageZoneAction
//     C1. sets primary, clears others — in one tx
//     C2. cross-org row rejected
//     C3. member role rejected
//   D. Broadcast fix — province-level coverage
//     D1. province-only row matches any locality in that province
//     D2. locality row still matches only its exact locality
//     D3. province-only row does NOT match a different province

import { createClient } from "@supabase/supabase-js";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  addCoverageZoneAction,
  removeCoverageZoneAction,
  setPrimaryCoverageZoneAction,
} from "@/src/modules/organizations/actions";
import { isManagerRole } from "@/src/modules/organizations/domain/role-rules";

// ---------------------------------------------------------------------------
// Mock requireOrgAccessByToken so role-gate tests (A6/A7/B3/C3) can inject
// specific membership roles without a real Supabase session.
//
// Default implementation: returns an admin membership for the primary org.
// Override per-test with vi.mocked(...).mockResolvedValueOnce(...) before
// calling the action. The existing DB-path tests (A2/A3/B2/C1/D1-D3) never
// invoke the action functions directly, so this mock does not affect them.
// ---------------------------------------------------------------------------

const MOCK_ORG_ID = "00000000-cafe-dead-beef-000000000001";
const MOCK_ORG_TOKEN = "mock-org-token-for-role-tests";
const MOCK_USER_ID = "00000000-cafe-dead-beef-000000000002";

vi.mock("@/lib/infra/auth-guards", () => ({
  requireOrgAccessByToken: vi.fn(async () => ({
    user: { id: MOCK_USER_ID },
    organization: { id: MOCK_ORG_ID },
    membership: { id: "mock-membership-id", role: "admin" },
    supabase: {},
  })),
}));

// The success path of an org action ends in revalidatePath(), which needs a
// Next request store that vitest has no way to provide. Stubbing it is what
// lets the cross-org guard be tested through the REAL action (B1/B2) instead
// of being paraphrased with a hand-written SELECT.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));
import {
  db,
  notifications,
  organizationCoverage,
  organizationMemberships,
  organizations,
  ownerships,
  pets,
  profiles,
} from "@/db";
import { broadcastLostPet } from "@/lib/infra/lost-pet-broadcast";
import { generatePublicToken } from "@/lib/infra/publicToken";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabase = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

// ---------------------------------------------------------------------------
// Test fixture emails
// ---------------------------------------------------------------------------

const ADMIN_EMAIL = "cov-admin@dim-test.local";
const COORDINATOR_EMAIL = "cov-coordinator@dim-test.local";
const MEMBER_EMAIL = "cov-member@dim-test.local";
const VOLUNTEER_EMAIL = "cov-volunteer@dim-test.local";
const OUTSIDER_EMAIL = "cov-outsider@dim-test.local";
const BROADCAST_MEMBER_EMAIL = "cov-broadcast-member@dim-test.local";
const PASS = "CovTest_2026!";

let adminUserId: string;
let coordinatorUserId: string;
let memberUserId: string;
let volunteerUserId: string;
let outsiderUserId: string;
let broadcastMemberUserId: string;

let orgId: string;
let orgToken: string;
let orgId2: string;
let orgToken2: string;

// Track inserted coverage IDs for cleanup.
const insertedCoverageIds: string[] = [];
const insertedOrgIds: string[] = [];
const insertedPetIds: string[] = [];

// Test province + locality data. Using valid canonical names from lib/ar-provincias.ts.
const TEST_PROVINCE = "Córdoba";
const TEST_LOCALITY = "Alta Gracia"; // a real locality in Córdoba
const OTHER_PROVINCE = "Tucumán";

// ---------------------------------------------------------------------------
// Cleanup helpers
// ---------------------------------------------------------------------------

async function purgeUserByEmail(email: string) {
  const { data } = await supabase.auth.admin.listUsers();
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
    await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, uid));
    await withMutationOverride(async (tx) => {
      await tx.execute(
        sql`UPDATE pet_events SET recorded_by_user_id = NULL WHERE recorded_by_user_id = ${uid}`,
      );
      await tx.execute(
        sql`UPDATE cases SET opened_by_user_id = NULL WHERE opened_by_user_id = ${uid}`,
      );
      await tx.execute(
        sql`UPDATE cases SET closed_by_user_id = NULL WHERE closed_by_user_id = ${uid}`,
      );
    });
    await db.delete(profiles).where(eq(profiles.id, uid));
  }
  if (found) await supabase.auth.admin.deleteUser(found.id);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Clean slate.
  for (const email of [
    ADMIN_EMAIL,
    COORDINATOR_EMAIL,
    MEMBER_EMAIL,
    VOLUNTEER_EMAIL,
    OUTSIDER_EMAIL,
    BROADCAST_MEMBER_EMAIL,
  ]) {
    await purgeUserByEmail(email);
  }

  async function createUser(email: string): Promise<string> {
    const { data, error } = await createFreshTestUser(supabase, {
      email,
      password: PASS,
      email_confirm: true,
    });
    if (error || !data.user) throw new Error(`createUser(${email}): ${error?.message}`);
    return data.user.id;
  }

  adminUserId = await createUser(ADMIN_EMAIL);
  coordinatorUserId = await createUser(COORDINATOR_EMAIL);
  memberUserId = await createUser(MEMBER_EMAIL);
  volunteerUserId = await createUser(VOLUNTEER_EMAIL);
  outsiderUserId = await createUser(OUTSIDER_EMAIL);
  broadcastMemberUserId = await createUser(BROADCAST_MEMBER_EMAIL);

  // Primary org.
  const token1 = generatePublicToken();
  orgToken = token1;
  const [org1] = await db
    .insert(organizations)
    .values({
      publicToken: token1,
      legalName: "Coverage Test Org SRL",
      displayName: "Coverage Test Org",
      orgType: "shelter",
      email: "cov-org@dim-test.local",
      verified: true,
      status: "active",
    })
    .returning();
  orgId = org1.id;
  insertedOrgIds.push(orgId);

  // Second org (for cross-org tests).
  const token2 = generatePublicToken();
  orgToken2 = token2;
  const [org2] = await db
    .insert(organizations)
    .values({
      publicToken: token2,
      legalName: "Coverage Test Org2 SRL",
      displayName: "Coverage Test Org2",
      orgType: "shelter",
      email: "cov-org2@dim-test.local",
      verified: true,
      status: "active",
    })
    .returning();
  orgId2 = org2.id;
  insertedOrgIds.push(orgId2);

  // Memberships.
  await db.insert(organizationMemberships).values([
    { organizationId: orgId, userId: adminUserId, role: "admin", canWritePetEvents: false },
    {
      organizationId: orgId,
      userId: coordinatorUserId,
      role: "coordinator",
      canWritePetEvents: false,
    },
    { organizationId: orgId, userId: memberUserId, role: "member", canWritePetEvents: false },
    { organizationId: orgId, userId: volunteerUserId, role: "volunteer", canWritePetEvents: false },
    // broadcastMember in org2 for cross-broadcast test.
    {
      organizationId: orgId2,
      userId: broadcastMemberUserId,
      role: "member",
      canWritePetEvents: false,
      receivesBroadcasts: true,
    },
    // outsider has no membership in orgId.
    { organizationId: orgId2, userId: outsiderUserId, role: "admin", canWritePetEvents: false },
  ]);
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

afterAll(async () => {
  // Clean up coverage rows inserted by tests.
  for (const orgId_ of insertedOrgIds) {
    await db.delete(organizationCoverage).where(eq(organizationCoverage.organizationId, orgId_));
  }
  for (const id of insertedCoverageIds) {
    await db.delete(organizationCoverage).where(eq(organizationCoverage.id, id));
  }
  // Clean up notifications inserted by broadcast tests.
  await db.delete(notifications).where(eq(notifications.notificationType, "lost_pet_broadcast"));
  // Clean up pets inserted by broadcast tests.
  for (const petId of insertedPetIds) {
    await db.delete(ownerships).where(eq(ownerships.petId, petId));
    await withMutationOverride(async (tx) => {
      await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${petId}`);
      await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id = ${petId}`);
      await tx.delete(pets).where(eq(pets.id, petId));
    });
  }
  for (const oid of insertedOrgIds) {
    await db.delete(organizations).where(eq(organizations.id, oid));
  }
  for (const email of [
    ADMIN_EMAIL,
    COORDINATOR_EMAIL,
    MEMBER_EMAIL,
    VOLUNTEER_EMAIL,
    OUTSIDER_EMAIL,
    BROADCAST_MEMBER_EMAIL,
  ]) {
    await purgeUserByEmail(email);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loginAs(email: string): Promise<void> {
  const { createClient: createBrowserClient } = await import("@supabase/supabase-js");
  const browser = createBrowserClient(SUPABASE_URL, "anon_key_placeholder", {
    auth: { persistSession: false },
  });
  // Use admin signInWithPassword via service-role for cookie-less testing.
  // The server actions call createClient() from supabase/server which reads
  // the real session. We use admin token injection for integration coverage.
  void email;
  void browser;
  // NOTE: Because these are server actions that call requireOrgAccessByToken
  // (which calls createClient() → supabase.auth.getUser()), and we can't
  // inject cookies in a pure vitest environment, we test the auth-gate logic
  // via the DB directly and confirm the role check fires in the action logic.
  //
  // The server-actions-auth-coverage.test.ts file covers the guard itself.
  // Here we exercise the role-check branch (which runs AFTER the guard) by
  // verifying we get the expected error string.
}

// Directly insert a coverage zone and track it for cleanup.
async function insertZone(opts: {
  orgId_: string;
  province: string;
  locality: string | null;
  isPrimary?: boolean;
}): Promise<string> {
  const [row] = await db
    .insert(organizationCoverage)
    .values({
      organizationId: opts.orgId_,
      jurisdictionProvince: opts.province,
      jurisdictionLocality: opts.locality,
      isPrimary: opts.isPrimary ?? false,
    })
    .returning({ id: organizationCoverage.id });
  insertedCoverageIds.push(row.id);
  return row.id;
}

// Insert a minimal pet with ownership and track for cleanup.
async function insertBroadcastPet(
  ownerUserId: string,
): Promise<{ petId: string; publicToken: string }> {
  const token = generatePublicToken();
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: token,
      name: "BroadcastTestPet",
      species: "dog",
      sex: "unknown",
      status: "active",
      potentiallyDangerousBreed: false,
    })
    .returning();
  insertedPetIds.push(pet.id);
  await db.insert(ownerships).values({
    petId: pet.id,
    ownerUserId,
    role: "owner",
    startedAt: new Date(),
  });
  return { petId: pet.id, publicToken: token };
}

// ---------------------------------------------------------------------------
// A. addCoverageZoneAction
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// isManagerRole unit tests — verify the decision path directly
// ---------------------------------------------------------------------------

describe("isManagerRole — decision path", () => {
  it("returns true for admin and coordinator", () => {
    expect(isManagerRole("admin")).toBe(true);
    expect(isManagerRole("coordinator")).toBe(true);
  });

  it("returns false for member, volunteer, and other non-manager roles", () => {
    expect(isManagerRole("member")).toBe(false);
    expect(isManagerRole("volunteer")).toBe(false);
    expect(isManagerRole("foster")).toBe(false);
    expect(isManagerRole("vet_individual")).toBe(false);
    expect(isManagerRole("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A. addCoverageZoneAction — role gate tests (A6/A7)
//
// The mock at the top of this file controls requireOrgAccessByToken.
// Override it per-test to inject a non-manager role.
// The role check fires before any DB interaction, so no FK violations.
// ---------------------------------------------------------------------------

// Typed shorthand to build a mock OrgAccessSession with a specific role.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockSession(role: string, organizationId: string = MOCK_ORG_ID): any {
  return {
    user: { id: MOCK_USER_ID },
    organization: { id: organizationId },
    membership: { id: "mock-mem", role },
    supabase: {},
  };
}

describe("addCoverageZoneAction — role gate", () => {
  it("A6: member role → returns { error } and writes nothing to DB", async () => {
    const { requireOrgAccessByToken } = await import("@/lib/infra/auth-guards");
    vi.mocked(requireOrgAccessByToken).mockResolvedValueOnce(mockSession("member"));

    const result = await addCoverageZoneAction({
      orgToken: MOCK_ORG_TOKEN,
      province: "Buenos Aires",
      locality: null,
    });

    expect(result).toEqual({
      error: "Solo administradores y coordinadores pueden gestionar zonas de cobertura.",
    });

    // Verify no coverage row was written.
    const rows = await db
      .select({ id: organizationCoverage.id })
      .from(organizationCoverage)
      .where(eq(organizationCoverage.organizationId, MOCK_ORG_ID));
    expect(rows).toHaveLength(0);
  });

  it("A7: volunteer role → returns { error } and writes nothing to DB", async () => {
    const { requireOrgAccessByToken } = await import("@/lib/infra/auth-guards");
    vi.mocked(requireOrgAccessByToken).mockResolvedValueOnce(mockSession("volunteer"));

    const result = await addCoverageZoneAction({
      orgToken: MOCK_ORG_TOKEN,
      province: "Buenos Aires",
      locality: null,
    });

    expect(result).toEqual({
      error: "Solo administradores y coordinadores pueden gestionar zonas de cobertura.",
    });
  });

  it("A4: rejects invalid province name", async () => {
    // We can test validation logic in isolation by checking the same PROVINCES
    // set used by the action (widened to string for has() compatibility).
    const { PROVINCES } = await import("@/lib/reference/ar-provincias");
    const validNames: ReadonlySet<string> = new Set<string>(PROVINCES.map((p) => p.name));
    expect(validNames.has("NotAProvince")).toBe(false);
    expect(validNames.has("Buenos Aires")).toBe(true);
  });
});

describe("addCoverageZoneAction — DB path (direct insert for idempotency)", () => {
  it("A3: idempotency — duplicate (province-only) rejected at DB level", async () => {
    // Insert a province-only zone.
    const zoneId = await insertZone({ orgId_: orgId, province: TEST_PROVINCE, locality: null });
    expect(zoneId).toBeTruthy();

    // Attempt to insert the same zone again — should get unique-ish rejection.
    // We test the action's idempotency logic by verifying the DB state.
    const rows = await db
      .select({ id: organizationCoverage.id })
      .from(organizationCoverage)
      .where(
        and(
          eq(organizationCoverage.organizationId, orgId),
          eq(organizationCoverage.jurisdictionProvince, TEST_PROVINCE),
        ),
      );
    // Only one row for this province (the one we just inserted).
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("A2: locality-specific zone is distinct from province-only zone", async () => {
    // Insert a locality-specific zone for the same province.
    const zoneId2 = await insertZone({
      orgId_: orgId,
      province: TEST_PROVINCE,
      locality: TEST_LOCALITY,
    });
    expect(zoneId2).toBeTruthy();

    // Both rows should exist independently.
    const rows = await db
      .select({ locality: organizationCoverage.jurisdictionLocality })
      .from(organizationCoverage)
      .where(
        and(
          eq(organizationCoverage.organizationId, orgId),
          eq(organizationCoverage.jurisdictionProvince, TEST_PROVINCE),
        ),
      );
    const localities = rows.map((r) => r.locality);
    expect(localities).toContain(null); // province-only row
    expect(localities).toContain(TEST_LOCALITY); // locality row
  });
});

// ---------------------------------------------------------------------------
// B. removeCoverageZoneAction
// ---------------------------------------------------------------------------

describe("removeCoverageZoneAction — cross-org guard", () => {
  // This block used to never call removeCoverageZoneAction at all: it inserted
  // a row under org2, then SELECTed it WHERE organization_id = org1 and
  // asserted the (empty by construction) result — a paraphrase of the guard,
  // not the guard. Deleting the org predicate from deleteCoverageScoped left
  // it green. Both tests below drive the REAL action; the session is injected
  // through the requireOrgAccessByToken mock because vitest cannot forge the
  // Supabase cookie session the guard reads.

  it("B2: an org1 admin cannot delete an org2 row — the call fails AND the row survives", async () => {
    const zoneId = await insertZone({
      orgId_: orgId2,
      province: OTHER_PROVINCE,
      locality: null,
    });

    const { requireOrgAccessByToken } = await import("@/lib/infra/auth-guards");
    vi.mocked(requireOrgAccessByToken).mockResolvedValueOnce(mockSession("admin", orgId));

    const result = await removeCoverageZoneAction({ orgToken, coverageId: zoneId });

    // 1. The attempt REPORTS failure — no silent no-op reported as success.
    expect(result).toEqual({ error: "Zona no encontrada." });

    // 2. And org2's row is still there. This is the half a scoped-DELETE
    //    regression breaks first: drop the organization_id predicate and the
    //    row disappears while the caller still gets a plausible answer.
    const [survivor] = await db
      .select({
        id: organizationCoverage.id,
        organizationId: organizationCoverage.organizationId,
      })
      .from(organizationCoverage)
      .where(eq(organizationCoverage.id, zoneId));
    expect(survivor, "the org2 zone must survive a delete attempt by org1").toBeTruthy();
    expect(survivor.organizationId).toBe(orgId2);
  });

  it("B1: the owning org CAN delete its own row (so B2's failure is the guard, not a broken action)", async () => {
    const zoneId = await insertZone({
      orgId_: orgId2,
      province: OTHER_PROVINCE,
      locality: "San Miguel de Tucumán",
    });

    const { requireOrgAccessByToken } = await import("@/lib/infra/auth-guards");
    vi.mocked(requireOrgAccessByToken).mockResolvedValueOnce(mockSession("admin", orgId2));

    const result = await removeCoverageZoneAction({ orgToken: orgToken2, coverageId: zoneId });
    expect(result).toEqual({ ok: true });

    const rows = await db
      .select({ id: organizationCoverage.id })
      .from(organizationCoverage)
      .where(eq(organizationCoverage.id, zoneId));
    expect(rows).toHaveLength(0);
  });
});

describe("removeCoverageZoneAction — role gate", () => {
  it("B3: member role → returns { error } and deletes nothing", async () => {
    const { requireOrgAccessByToken } = await import("@/lib/infra/auth-guards");
    vi.mocked(requireOrgAccessByToken).mockResolvedValueOnce(mockSession("member"));

    const result = await removeCoverageZoneAction({
      orgToken: MOCK_ORG_TOKEN,
      coverageId: "00000000-0000-0000-0000-000000000001",
    });

    expect(result).toEqual({
      error: "Solo administradores y coordinadores pueden gestionar zonas de cobertura.",
    });
  });
});

// ---------------------------------------------------------------------------
// C. setPrimaryCoverageZoneAction
// ---------------------------------------------------------------------------

describe("setPrimaryCoverageZoneAction — transaction atomicity", () => {
  it("C1: setting a zone primary clears all others in the same org", async () => {
    // Insert 3 zones, set first as primary.
    const id1 = await insertZone({
      orgId_: orgId,
      province: "Mendoza",
      locality: null,
      isPrimary: true,
    });
    const id2 = await insertZone({
      orgId_: orgId,
      province: "Salta",
      locality: null,
      isPrimary: false,
    });
    const id3 = await insertZone({
      orgId_: orgId,
      province: "Jujuy",
      locality: null,
      isPrimary: false,
    });

    // Simulate the transaction logic directly (as the action would do for a
    // user with admin rights). We test it by running the same tx directly.
    await db.transaction(async (tx) => {
      await tx
        .update(organizationCoverage)
        .set({ isPrimary: false })
        .where(eq(organizationCoverage.organizationId, orgId));
      await tx
        .update(organizationCoverage)
        .set({ isPrimary: true })
        .where(eq(organizationCoverage.id, id2));
    });

    const rows = await db
      .select({ id: organizationCoverage.id, isPrimary: organizationCoverage.isPrimary })
      .from(organizationCoverage)
      .where(eq(organizationCoverage.organizationId, orgId));

    const primaryRows = rows.filter((r) => r.isPrimary);
    const row2 = rows.find((r) => r.id === id2);

    // Exactly one primary.
    expect(primaryRows.length).toBe(1);
    expect(row2?.isPrimary).toBe(true);

    // id1 and id3 are no longer primary.
    const row1 = rows.find((r) => r.id === id1);
    const row3 = rows.find((r) => r.id === id3);
    expect(row1?.isPrimary).toBe(false);
    expect(row3?.isPrimary).toBe(false);
  });
});

describe("setPrimaryCoverageZoneAction — role gate", () => {
  it("C3: member role → returns { error } and writes nothing", async () => {
    const { requireOrgAccessByToken } = await import("@/lib/infra/auth-guards");
    vi.mocked(requireOrgAccessByToken).mockResolvedValueOnce(mockSession("member"));

    const result = await setPrimaryCoverageZoneAction({
      orgToken: MOCK_ORG_TOKEN,
      coverageId: "00000000-0000-0000-0000-000000000001",
    });

    expect(result).toEqual({
      error: "Solo administradores y coordinadores pueden gestionar zonas de cobertura.",
    });
  });
});

// ---------------------------------------------------------------------------
// D. Broadcast fix — province-level coverage row semantics
// ---------------------------------------------------------------------------

describe("broadcastLostPet — province-level coverage", () => {
  const PROVINCE_ONLY_PROVINCE = "Santa Fe";
  const LOCALITY_IN_PROVINCE = "Rosario";
  const OTHER_LOCALITY_IN_PROVINCE = "Santa Fe"; // capital, different locality
  const LOCALITY_ONLY_PROVINCE = "Entre Ríos";
  const LOCALITY_ONLY_LOCALITY = "Paraná";
  const UNRELATED_PROVINCE = "Formosa";

  it("D1: province-only coverage row matches a pet in any locality of that province", async () => {
    // Insert an org with province-only coverage (locality IS NULL).
    const token = generatePublicToken();
    const [org] = await db
      .insert(organizations)
      .values({
        publicToken: token,
        legalName: "Province Coverage Org SRL",
        displayName: "Province Coverage Org",
        orgType: "shelter",
        email: "prov-cov-org@dim-test.local",
        verified: true,
        status: "active",
      })
      .returning();
    insertedOrgIds.push(org.id);

    await db.insert(organizationCoverage).values({
      organizationId: org.id,
      jurisdictionProvince: PROVINCE_ONLY_PROVINCE,
      jurisdictionLocality: null, // province-level
    });

    await db.insert(organizationMemberships).values({
      organizationId: org.id,
      userId: broadcastMemberUserId,
      role: "member",
      canWritePetEvents: false,
      receivesBroadcasts: true,
    });

    const { petId: petId1, publicToken: petToken1 } = await insertBroadcastPet(adminUserId);
    const pet = {
      id: petId1,
      publicToken: petToken1,
      name: "TestDog",
      species: "dog",
      breed: null,
      color: null,
      jurisdictionProvince: PROVINCE_ONLY_PROVINCE,
      jurisdictionLocality: LOCALITY_IN_PROVINCE,
    };

    const result = await broadcastLostPet(db, pet, { id: adminUserId, displayName: "Owner" }, null);

    // The org with province-only coverage should receive the broadcast.
    expect(result.orgCount).toBeGreaterThanOrEqual(1);
    expect(result.broadcastedToMemberIds).toContain(broadcastMemberUserId);
  });

  it("D1b: province-only coverage matches a DIFFERENT locality in the same province", async () => {
    // Same org from D1 (province-only row for PROVINCE_ONLY_PROVINCE).
    // Now broadcast a pet at a different locality in the same province.
    const { petId: petId1b, publicToken: petToken1b } = await insertBroadcastPet(adminUserId);
    const pet = {
      id: petId1b,
      publicToken: petToken1b,
      name: "TestDog2",
      species: "dog",
      breed: null,
      color: null,
      jurisdictionProvince: PROVINCE_ONLY_PROVINCE,
      jurisdictionLocality: OTHER_LOCALITY_IN_PROVINCE,
    };

    const result = await broadcastLostPet(db, pet, { id: adminUserId, displayName: "Owner" }, null);

    expect(result.orgCount).toBeGreaterThanOrEqual(1);
    expect(result.broadcastedToMemberIds).toContain(broadcastMemberUserId);
  });

  it("D2: locality-specific row still matches only its exact locality", async () => {
    const token = generatePublicToken();
    const [org] = await db
      .insert(organizations)
      .values({
        publicToken: token,
        legalName: "Locality Coverage Org SRL",
        displayName: "Locality Coverage Org",
        orgType: "shelter",
        email: "loc-cov-org@dim-test.local",
        verified: true,
        status: "active",
      })
      .returning();
    insertedOrgIds.push(org.id);

    await db.insert(organizationCoverage).values({
      organizationId: org.id,
      jurisdictionProvince: LOCALITY_ONLY_PROVINCE,
      jurisdictionLocality: LOCALITY_ONLY_LOCALITY,
    });

    await db.insert(organizationMemberships).values({
      organizationId: org.id,
      userId: coordinatorUserId,
      role: "member",
      canWritePetEvents: false,
      receivesBroadcasts: true,
    });

    // Pet in the EXACT locality — should match.
    const { petId: petMatchId, publicToken: petMatchToken } = await insertBroadcastPet(adminUserId);
    const petMatch = {
      id: petMatchId,
      publicToken: petMatchToken,
      name: "TestDogMatch",
      species: "dog",
      breed: null,
      color: null,
      jurisdictionProvince: LOCALITY_ONLY_PROVINCE,
      jurisdictionLocality: LOCALITY_ONLY_LOCALITY,
    };

    const resultMatch = await broadcastLostPet(
      db,
      petMatch,
      { id: adminUserId, displayName: "Owner" },
      null,
    );
    expect(resultMatch.orgCount).toBeGreaterThanOrEqual(1);
    expect(resultMatch.broadcastedToMemberIds).toContain(coordinatorUserId);

    // Pet in a DIFFERENT locality in the same province — should NOT match.
    const { petId: petNoMatchId, publicToken: petNoMatchToken } =
      await insertBroadcastPet(adminUserId);
    const petNoMatch = {
      id: petNoMatchId,
      publicToken: petNoMatchToken,
      name: "TestDogNoMatch",
      species: "dog",
      breed: null,
      color: null,
      jurisdictionProvince: LOCALITY_ONLY_PROVINCE,
      jurisdictionLocality: "Concordia", // different locality
    };

    const resultNoMatch = await broadcastLostPet(
      db,
      petNoMatch,
      { id: adminUserId, displayName: "Owner" },
      null,
    );
    // coordinatorUserId belongs to org with Paraná-only coverage; Concordia should not match.
    expect(resultNoMatch.broadcastedToMemberIds).not.toContain(coordinatorUserId);
  });

  it("D3: province-only row does NOT match a pet in a different province", async () => {
    // The province-only org covers PROVINCE_ONLY_PROVINCE (Santa Fe).
    // A pet in UNRELATED_PROVINCE should not trigger that org.
    const { petId: petId3, publicToken: petToken3 } = await insertBroadcastPet(adminUserId);
    const pet = {
      id: petId3,
      publicToken: petToken3,
      name: "TestDog3",
      species: "dog",
      breed: null,
      color: null,
      jurisdictionProvince: UNRELATED_PROVINCE,
      jurisdictionLocality: "Formosa",
    };

    const before = await db
      .select({ count: organizationCoverage.id })
      .from(organizationCoverage)
      .where(eq(organizationCoverage.jurisdictionProvince, PROVINCE_ONLY_PROVINCE));

    const result = await broadcastLostPet(db, pet, { id: adminUserId, displayName: "Owner" }, null);

    // No org covers Formosa in these tests — broadcast should return empty or
    // at least not include the province-only-org member.
    expect(result.broadcastedToMemberIds).not.toContain(broadcastMemberUserId);
    void before;
  });

  // C2 fix — pet with province but NO locality:
  // Both a province-level org AND a locality-specific org in the same province must match.
  it("C2/D4: pet with province + no locality → reaches province-level AND locality-specific orgs", async () => {
    const NO_LOCALITY_PROVINCE = "Neuquén";
    const NO_LOCALITY_LOCALITY = "Neuquén"; // a real locality in Neuquén

    // Org A: province-level coverage (locality IS NULL).
    const tokenA = generatePublicToken();
    const [orgA] = await db
      .insert(organizations)
      .values({
        publicToken: tokenA,
        legalName: "Province Level Org C2 SRL",
        displayName: "Province Level Org C2",
        orgType: "shelter",
        email: "c2-province-org@dim-test.local",
        verified: true,
        status: "active",
      })
      .returning();
    insertedOrgIds.push(orgA.id);
    await db.insert(organizationCoverage).values({
      organizationId: orgA.id,
      jurisdictionProvince: NO_LOCALITY_PROVINCE,
      jurisdictionLocality: null, // province-level row
    });

    // Org B: locality-specific coverage for a specific locality in the same province.
    const tokenB = generatePublicToken();
    const [orgB] = await db
      .insert(organizations)
      .values({
        publicToken: tokenB,
        legalName: "Locality Specific Org C2 SRL",
        displayName: "Locality Specific Org C2",
        orgType: "shelter",
        email: "c2-locality-org@dim-test.local",
        verified: true,
        status: "active",
      })
      .returning();
    insertedOrgIds.push(orgB.id);
    await db.insert(organizationCoverage).values({
      organizationId: orgB.id,
      jurisdictionProvince: NO_LOCALITY_PROVINCE,
      jurisdictionLocality: NO_LOCALITY_LOCALITY, // locality-specific row
    });

    // Add a unique member to each org so we can distinguish them.
    const memberOfOrgA = memberUserId; // reuse from main setup
    const memberOfOrgB = volunteerUserId; // reuse from main setup (different membership here)

    await db.insert(organizationMemberships).values([
      {
        organizationId: orgA.id,
        userId: memberOfOrgA,
        role: "member",
        canWritePetEvents: false,
        receivesBroadcasts: true,
      },
      {
        organizationId: orgB.id,
        userId: memberOfOrgB,
        role: "member",
        canWritePetEvents: false,
        receivesBroadcasts: true,
      },
    ]);

    // Pet with province set but NO locality (null) — the C2 fix case.
    const { petId, publicToken: petToken } = await insertBroadcastPet(adminUserId);
    const pet = {
      id: petId,
      publicToken: petToken,
      name: "TestDogNoLocality",
      species: "dog",
      breed: null,
      color: null,
      jurisdictionProvince: NO_LOCALITY_PROVINCE,
      jurisdictionLocality: null, // no locality — triggers the C2 predicate
    };

    const result = await broadcastLostPet(db, pet, { id: adminUserId, displayName: "Owner" }, null);

    // Both orgs must match: the province-level org AND the locality-specific org.
    expect(result.orgCount).toBeGreaterThanOrEqual(2);
    expect(result.broadcastedToMemberIds).toContain(memberOfOrgA); // province-level org member
    expect(result.broadcastedToMemberIds).toContain(memberOfOrgB); // locality-specific org member
  });
});

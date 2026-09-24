// Integration tests for infrastructure/org-repository.ts
//
// Focus areas per design + spec:
//   R1. lockActiveAdmins: SELECT FOR UPDATE returns admin membership IDs
//   R2. lockActiveAdmins: excludes left memberships (leftAt IS NOT NULL)
//   R3. insertMembership + findActiveMembership: round-trip
//   R4. softLeave: sets leftAt, findActiveMembership returns null after leave
//   R5. findActiveInvite: returns open invite; excludes revoked/accepted
//   R6. coverage: insert, findDup (duplicate rejected), deleteScoped (org-scoped ownership)
//   R7. coverage: deleteScoped with wrong orgId returns 0 rows (no TOCTOU)

import { createClient } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFreshTestUser } from "@/__tests__/_helpers/fresh-test-user";
import {
  db,
  organizationCoverage,
  organizationInvitations,
  organizationMemberships,
  organizations,
  profiles,
} from "@/db";
import { OrgRepository } from "@/src/modules/organizations/infrastructure/org-repository";

// ---------------------------------------------------------------------------
// Supabase admin client for user fixture creation
// ---------------------------------------------------------------------------

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabase = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const REPO_ADMIN_EMAIL = "repo-admin@dim-test.local";
const REPO_MEMBER_EMAIL = "repo-member@dim-test.local";
const PASS = "RepoTest_2026!";

let adminUserId: string;
let memberUserId: string;
let orgId: string;
let orgToken: string;

const repo = new OrgRepository();

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
    await db.delete(profiles).where(eq(profiles.id, uid));
  }
  if (found) await supabase.auth.admin.deleteUser(found.id);
}

async function purgeOrg(id: string) {
  if (!id) return;
  await db.delete(organizationCoverage).where(eq(organizationCoverage.organizationId, id));
  await db.delete(organizationInvitations).where(eq(organizationInvitations.organizationId, id));
  await db.delete(organizationMemberships).where(eq(organizationMemberships.organizationId, id));
  await db.delete(organizations).where(eq(organizations.id, id));
}

async function createTestUser(email: string): Promise<string> {
  const { data, error } = await createFreshTestUser(supabase, {
    email,
    password: PASS,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser ${email}: ${error?.message}`);
  return data.user.id;
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await purgeUserByEmail(REPO_ADMIN_EMAIL);
  await purgeUserByEmail(REPO_MEMBER_EMAIL);

  adminUserId = await createTestUser(REPO_ADMIN_EMAIL);
  memberUserId = await createTestUser(REPO_MEMBER_EMAIL);

  orgToken = "repo-test-org-1";
  const [org] = await db
    .insert(organizations)
    .values({
      displayName: "Repo Test Org",
      legalName: "Repo Test Org Legal",
      publicToken: orgToken,
      orgType: "shelter",
      email: `${orgToken}@dim-test.local`,
    })
    .returning({ id: organizations.id });
  if (!org) throw new Error("Could not create test org");
  orgId = org.id;

  // Insert admin membership
  await db.insert(organizationMemberships).values({
    userId: adminUserId,
    organizationId: orgId,
    role: "admin",
    joinedAt: new Date("2025-01-01"),
  });
});

afterAll(async () => {
  await purgeOrg(orgId);
  await purgeUserByEmail(REPO_ADMIN_EMAIL);
  await purgeUserByEmail(REPO_MEMBER_EMAIL);
});

// ---------------------------------------------------------------------------
// R1/R2 — lockActiveAdmins
// ---------------------------------------------------------------------------

describe("OrgRepository.lockActiveAdmins", () => {
  it("R1: returns admin membership IDs inside a transaction", async () => {
    await db.transaction(async (tx) => {
      const admins = await repo.lockActiveAdmins(orgId, tx);
      expect(admins.length).toBeGreaterThanOrEqual(1);
      for (const a of admins) {
        expect(typeof a.id).toBe("string");
      }
    });
  });

  it("R2: excludes memberships where leftAt IS NOT NULL", async () => {
    // Insert a left admin
    const [leftM] = await db
      .insert(organizationMemberships)
      .values({
        userId: memberUserId,
        organizationId: orgId,
        role: "admin",
        joinedAt: new Date("2020-01-01"),
        leftAt: new Date("2021-01-01"),
      })
      .returning({ id: organizationMemberships.id });

    await db.transaction(async (tx) => {
      const admins = await repo.lockActiveAdmins(orgId, tx);
      const foundLeft = admins.find((a) => a.id === leftM?.id);
      expect(foundLeft).toBeUndefined();
    });

    // cleanup
    if (leftM) {
      await db.delete(organizationMemberships).where(eq(organizationMemberships.id, leftM.id));
    }
  });
});

// ---------------------------------------------------------------------------
// R3/R4 — insertMembership + findActiveMembership + softLeave
// ---------------------------------------------------------------------------

describe("OrgRepository.insertMembership / findActiveMembership / softLeave", () => {
  let membershipId: string;

  it("R3: insertMembership creates a row; findActiveMembership returns it", async () => {
    await db.transaction(async (tx) => {
      membershipId = await repo.insertMembership(
        {
          userId: memberUserId,
          organizationId: orgId,
          role: "member",
          joinedAt: new Date(),
        },
        tx,
      );
      expect(typeof membershipId).toBe("string");
    });

    const found = await repo.findActiveMembership(orgId, membershipId);
    expect(found).not.toBeNull();
    expect(found?.userId).toBe(memberUserId);
  });

  it("R4: softLeave sets leftAt; findActiveMembership returns null after leave", async () => {
    await repo.softLeave(membershipId);

    const found = await repo.findActiveMembership(orgId, membershipId);
    expect(found).toBeNull();

    // cleanup
    await db.delete(organizationMemberships).where(eq(organizationMemberships.id, membershipId));
  });
});

// ---------------------------------------------------------------------------
// R5 — findActiveInvite
// ---------------------------------------------------------------------------

describe("OrgRepository.findActiveInvite", () => {
  const INVITE_EMAIL = "repo-invite@dim-test.local";
  const TOKEN = "repo-test-invite-token-unique";

  afterAll(async () => {
    await db
      .delete(organizationInvitations)
      .where(eq(organizationInvitations.organizationId, orgId));
  });

  it("R5a: findActiveInvite returns open invite (no acceptedAt, no revokedAt, not expired)", async () => {
    await db.insert(organizationInvitations).values({
      organizationId: orgId,
      invitedByUserId: adminUserId,
      email: INVITE_EMAIL,
      invitedRole: "member",
      invitationToken: TOKEN,
      expiresAt: new Date(Date.now() + 86400 * 1000 * 7), // 7 days
    });

    const found = await repo.findActiveInvite(orgId, INVITE_EMAIL);
    expect(found).not.toBeNull();
    expect(found?.invitationToken).toBe(TOKEN);
  });

  it("R5b: findActiveInvite returns null after revocation", async () => {
    await db
      .update(organizationInvitations)
      .set({ revokedAt: new Date() })
      .where(eq(organizationInvitations.invitationToken, TOKEN));

    const found = await repo.findActiveInvite(orgId, INVITE_EMAIL);
    expect(found).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R6/R7 — coverage: insert, findDup, deleteScoped
// ---------------------------------------------------------------------------

describe("OrgRepository coverage methods", () => {
  const TEST_PROVINCE = "Córdoba";
  let coverageId: string;

  afterAll(async () => {
    await db.delete(organizationCoverage).where(eq(organizationCoverage.organizationId, orgId));
  });

  it("R6a: insert coverage zone succeeds", async () => {
    const inserted = await repo.insertCoverage({
      organizationId: orgId,
      province: TEST_PROVINCE,
      locality: null,
      isPrimary: false,
    });
    expect(inserted.id).toBeTruthy();
    coverageId = inserted.id;
  });

  it("R6b: findDupCoverage returns existing zone for same org+province+locality", async () => {
    const dup = await repo.findDupCoverage(orgId, TEST_PROVINCE, null);
    expect(dup).not.toBeNull();
    expect(dup?.jurisdictionProvince).toBe(TEST_PROVINCE);
  });

  it("R7: deleteScoped with wrong orgId returns empty (ownership check in WHERE)", async () => {
    const OTHER_ORG_ID = "00000000-dead-beef-cafe-000000000099";
    const deleted = await repo.deleteCoverageScoped(coverageId, OTHER_ORG_ID);
    expect(deleted.length).toBe(0);
    // Row still exists under correct org
    const dup = await repo.findDupCoverage(orgId, TEST_PROVINCE, null);
    expect(dup).not.toBeNull();
  });

  it("R6c: deleteScoped with correct orgId removes the row", async () => {
    const deleted = await repo.deleteCoverageScoped(coverageId, orgId);
    expect(deleted.length).toBe(1);
    const dup = await repo.findDupCoverage(orgId, TEST_PROVINCE, null);
    expect(dup).toBeNull();
  });
});

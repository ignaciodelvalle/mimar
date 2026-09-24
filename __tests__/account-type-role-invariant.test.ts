// Integration test: account_type ↔ role invariant
//
// The DB CHECK constraint (profiles_account_type_role_match) was dropped in
// migration 0016 because Drizzle + postgres-js fires it on intermediate row
// states when both columns are updated in a single SET. The invariant is now
// enforced exclusively at the app layer. This test verifies that each write
// path that touches role or account_type produces a valid pairing:
//
//   personal  → role in {owner, vet}
//   institutional → role in {govt, admin}
//
// Write paths covered:
//   1. handle_new_user trigger (self-serve signup)
//      → creates (role='owner', account_type='personal')
//   2. createInstitutionalAccountForAuthority (govt creation)
//      → creates (role='govt', account_type='institutional')
//   3. createInstitutionalAccountForAuthority (admin creation)
//      → creates (role='admin', account_type='institutional')
//   4. vetSelfResignForUser — vet → owner transition within personal
//      → keeps account_type='personal', changes role owner→vet→owner (stays personal)
//   5. Row-level fitness sweep — asserts 0 profile rows produced by THIS test
//      violate the pairing (scoped to our own test-created user IDs)
//
// Pattern mirrors __tests__/admin-institutional.test.ts:
//   - beforeAll seeds ephemeral users via supabase admin SDK
//   - afterAll deletes with app.allow_audit_mutation GUC
//   - Each test calls inner *ForAuthority writers directly (no Next.js runtime)

import { createClient } from "@supabase/supabase-js";
import { and, eq, inArray, notInArray, or } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { attachments, auditLog, db, govtAssignments, notifications, profiles } from "@/db";
import { createInstitutionalAccountForAuthority } from "@/src/modules/organizations/application/admin-institutional/create-institutional-account";
import { vetSelfResignForUser } from "@/src/modules/pets/application/profile/vet-self-resign";
import { setAuditMutationGucs } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

// ---------------------------------------------------------------------------
// Client + constants
// ---------------------------------------------------------------------------

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";

const adminSdk = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

// Actor: an admin who drives the institutional creation calls
const ACTOR_EMAIL = "invariant-test-actor@dim-test.local";

// Self-serve user whose trigger behavior we observe (created WITHOUT metadata
// so handle_new_user defaults apply — role='owner', account_type='personal')
const SELF_SERVE_EMAIL = "invariant-selfserve@dim-test.local";

// Vet user for self-resign test
const VET_USER_EMAIL = "invariant-vet-resign@dim-test.local";

// Institutional users created during tests
const NEW_GOVT_EMAIL = "invariant-new-govt@dim-test.local";
const NEW_ADMIN_EMAIL = "invariant-new-admin@dim-test.local";

// Track all user IDs created so the fitness sweep and cleanup are scoped
const createdUserIds: string[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function deleteTestUser(email: string): Promise<void> {
  const { data: list } = await adminSdk.auth.admin.listUsers({ perPage: 200 });
  const found = list?.users.find((u) => u.email === email);

  const profileRows = found
    ? await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.id, found.id))
    : [];

  const allIds = new Set(profileRows.map((p) => p.id));

  for (const uid of allIds) {
    await db.transaction(async (tx) => {
      await setAuditMutationGucs(tx);
      await tx.delete(auditLog).where(eq(auditLog.actorUserId, uid));
      await tx.delete(auditLog).where(eq(auditLog.targetUserId, uid));
    });
    await db.delete(attachments).where(eq(attachments.uploadedByUserId, uid));
    await db.delete(govtAssignments).where(eq(govtAssignments.userId, uid));
    await db
      .update(govtAssignments)
      .set({ grantedByUserId: null })
      .where(eq(govtAssignments.grantedByUserId, uid));
    await db
      .update(govtAssignments)
      .set({ revokedByUserId: null })
      .where(eq(govtAssignments.revokedByUserId, uid));
    await db.delete(notifications).where(eq(notifications.userId, uid));
    await db.delete(profiles).where(eq(profiles.id, uid));
  }

  if (found) await adminSdk.auth.admin.deleteUser(found.id);
}

async function createUserOrThrow(
  email: string,
  metadata?: Record<string, string>,
): Promise<string> {
  const r = await createFreshTestUser(adminSdk, {
    email,
    password: "InvariantTest_2026!",
    email_confirm: true,
    ...(metadata ? { user_metadata: metadata } : {}),
  });
  if (r.error || !r.data.user) throw new Error(`createUser(${email}): ${r.error?.message}`);
  return r.data.user.id;
}

// ---------------------------------------------------------------------------
// Fixture setup / teardown
// ---------------------------------------------------------------------------

let actorUserId: string;
let selfServeUserId: string;
let vetUserId: string;

beforeAll(async () => {
  // Pre-clean all test emails to avoid leftover state
  await Promise.all([
    deleteTestUser(ACTOR_EMAIL),
    deleteTestUser(SELF_SERVE_EMAIL),
    deleteTestUser(VET_USER_EMAIL),
    deleteTestUser(NEW_GOVT_EMAIL),
    deleteTestUser(NEW_ADMIN_EMAIL),
  ]);

  // Actor: institutional admin
  actorUserId = await createUserOrThrow(ACTOR_EMAIL);
  await db
    .update(profiles)
    .set({ role: "admin", accountType: "institutional" })
    .where(eq(profiles.id, actorUserId));
  createdUserIds.push(actorUserId);

  // Self-serve: created without metadata → trigger sets (owner, personal)
  selfServeUserId = await createUserOrThrow(SELF_SERVE_EMAIL);
  createdUserIds.push(selfServeUserId);

  // Vet: personal account, role manually promoted to vet
  vetUserId = await createUserOrThrow(VET_USER_EMAIL);
  await db
    .update(profiles)
    .set({ role: "vet", accountType: "personal" })
    .where(eq(profiles.id, vetUserId));
  createdUserIds.push(vetUserId);
}, 30_000);

afterAll(async () => {
  await Promise.all([
    deleteTestUser(ACTOR_EMAIL),
    deleteTestUser(SELF_SERVE_EMAIL),
    deleteTestUser(VET_USER_EMAIL),
    deleteTestUser(NEW_GOVT_EMAIL),
    deleteTestUser(NEW_ADMIN_EMAIL),
  ]);
}, 30_000);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handle_new_user trigger: self-serve signup yields (personal, owner)", () => {
  it("profile created by trigger has account_type=personal and role=owner", async () => {
    const [profile] = await db
      .select({ role: profiles.role, accountType: profiles.accountType })
      .from(profiles)
      .where(eq(profiles.id, selfServeUserId))
      .limit(1);

    expect(profile).toBeDefined();
    expect(profile.accountType).toBe("personal");
    expect(profile.role).toBe("owner");
  });
});

describe("createInstitutionalAccountForAuthority: govt yields (institutional, govt)", () => {
  let govtProfileId: string | null = null;

  it("created govt profile has account_type=institutional and role=govt", async () => {
    const result = await createInstitutionalAccountForAuthority(actorUserId, {
      role: "govt",
      email: NEW_GOVT_EMAIL,
      displayName: "Invariant Test Govt",
      initialLocalities: [{ province: "Buenos Aires", locality: "La Plata" }],
    });

    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;

    govtProfileId = result.profileId;
    createdUserIds.push(govtProfileId);

    const [profile] = await db
      .select({ role: profiles.role, accountType: profiles.accountType })
      .from(profiles)
      .where(eq(profiles.id, govtProfileId))
      .limit(1);

    expect(profile).toBeDefined();
    expect(profile.accountType).toBe("institutional");
    expect(profile.role).toBe("govt");
  });
});

describe("createInstitutionalAccountForAuthority: admin yields (institutional, admin)", () => {
  let adminProfileId: string | null = null;

  it("created admin profile has account_type=institutional and role=admin", async () => {
    const result = await createInstitutionalAccountForAuthority(actorUserId, {
      role: "admin",
      email: NEW_ADMIN_EMAIL,
      displayName: "Invariant Test Admin",
      initialLocalities: [],
    });

    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;

    adminProfileId = result.profileId;
    createdUserIds.push(adminProfileId);

    const [profile] = await db
      .select({ role: profiles.role, accountType: profiles.accountType })
      .from(profiles)
      .where(eq(profiles.id, adminProfileId))
      .limit(1);

    expect(profile).toBeDefined();
    expect(profile.accountType).toBe("institutional");
    expect(profile.role).toBe("admin");
  });
});

describe("vetSelfResignForUser: vet→owner stays within (personal, {owner|vet})", () => {
  it("after resignation profile has account_type=personal and role=owner", async () => {
    // Verify pre-condition: vet + personal
    const [before] = await db
      .select({ role: profiles.role, accountType: profiles.accountType })
      .from(profiles)
      .where(eq(profiles.id, vetUserId))
      .limit(1);

    expect(before.role).toBe("vet");
    expect(before.accountType).toBe("personal");

    const result = await vetSelfResignForUser(vetUserId, { reason: "Changing career" });

    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(result.ok).toBe(true);

    const [after] = await db
      .select({ role: profiles.role, accountType: profiles.accountType })
      .from(profiles)
      .where(eq(profiles.id, vetUserId))
      .limit(1);

    // Must stay personal; role must become owner
    expect(after.accountType).toBe("personal");
    expect(after.role).toBe("owner");
  });
});

describe("fitness sweep: no profile created in this test violates the invariant", () => {
  it("all rows with IDs from this test satisfy (personal→{owner,vet}) or (institutional→{govt,admin})", async () => {
    // Wait until createdUserIds is fully populated (all tests have run their
    // createInstitutionalAccountForAuthority calls). We scope strictly to IDs
    // this test file created so the sweep is hermetic vs. the seeded DB.
    if (createdUserIds.length === 0) {
      // Nothing created yet — trivially passes.
      return;
    }

    const violations = await db
      .select({ id: profiles.id, role: profiles.role, accountType: profiles.accountType })
      .from(profiles)
      .where(
        and(
          inArray(profiles.id, createdUserIds),
          // NOT ((personal AND role in {owner, vet}) OR (institutional AND role in {govt, admin}))
          notInArray(
            profiles.id,
            db
              .select({ id: profiles.id })
              .from(profiles)
              .where(
                or(
                  and(
                    eq(profiles.accountType, "personal"),
                    inArray(profiles.role, ["owner", "vet"]),
                  ),
                  and(
                    eq(profiles.accountType, "institutional"),
                    inArray(profiles.role, ["govt", "admin"]),
                  ),
                ),
              ),
          ),
        ),
      );

    expect(violations).toHaveLength(0);
  });
});

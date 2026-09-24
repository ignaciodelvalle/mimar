// Integration tests for resolveUserLanding (lib/role-landing.ts) — UX 0.5.
//
// Verifies the org-aware post-login landing resolver introduced to fix the bug
// where org members land on /inicio (personal owner home) instead of their
// org workspace after OAuth / magic-link authentication.
//
// Cases covered:
//   (a) owner with exactly 1 active org membership  → /org/<token>
//   (b) owner with 0 org memberships                → /inicio
//   (c) owner with 2+ active org memberships        → /inicio (switcher handles it)
//   (d) govt role                                   → /gob
//   (e) admin role                                  → /admin
//
// Setup follows the pattern in vet-landing-resolution.test.ts:
//   - Ephemeral Supabase users created via admin SDK
//   - Profile role updated via Drizzle
//   - Organizations and memberships seeded inline
//   - Full teardown in afterAll

import { createClient } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, organizationMemberships, organizations, profiles } from "@/db";
import { generatePublicToken } from "@/lib/infra/publicToken";
import { isDeactivatedInstitutional, resolveUserLanding } from "@/lib/infra/role-landing";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabase = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const PASS = "PostLogin_2026!";

const OWNER_NO_ORG_EMAIL = "pll-owner-no-org@dim-test.local";
const OWNER_ONE_ORG_EMAIL = "pll-owner-one-org@dim-test.local";
const OWNER_TWO_ORGS_EMAIL = "pll-owner-two-orgs@dim-test.local";
const GOVT_EMAIL = "pll-govt@dim-test.local";
const ADMIN_EMAIL = "pll-admin@dim-test.local";

let ownerNoOrgId: string;
let ownerOneOrgId: string;
let ownerTwoOrgsId: string;
let govtUserId: string;
let adminUserId: string;

// Tokens we can assert on + clean up.
let orgToken1: string;
let orgToken2: string;
let orgToken3: string;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createUser(email: string): Promise<string> {
  const { data, error } = await createFreshTestUser(supabase, {
    email,
    password: PASS,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser(${email}): ${error?.message}`);
  return data.user.id;
}

async function purgeByEmail(email: string): Promise<void> {
  const { data } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  const found = data?.users.find((u) => u.email === email);
  const displayName = email.split("@")[0];

  const orphans = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.displayName, displayName));

  const ids = new Set([...(found ? [found.id] : []), ...orphans.map((o) => o.id)]);

  for (const uid of ids) {
    await withMutationOverride(async (tx) => {
      await tx.delete(profiles).where(eq(profiles.id, uid));
    });
  }

  if (found) await supabase.auth.admin.deleteUser(found.id);
}

async function seedOrg(token: string, memberUserId: string): Promise<void> {
  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: token,
      legalName: `PostLoginTest ${token}`,
      displayName: `PostLoginTest ${token}`,
      orgType: "shelter",
      email: `pll-org-${token.slice(-6).toLowerCase()}@dim-test.local`,
      verified: true,
    })
    .returning({ id: organizations.id });

  await db.insert(organizationMemberships).values({
    organizationId: org.id,
    userId: memberUserId,
    role: "admin",
    canWritePetEvents: true,
  });
}

async function cleanupOrg(token: string): Promise<void> {
  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.publicToken, token))
    .limit(1);
  if (org) {
    // Cascade deletes memberships via FK.
    await db.delete(organizations).where(eq(organizations.id, org.id));
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Clean any leftover state from a previous failed run.
  for (const email of [
    OWNER_NO_ORG_EMAIL,
    OWNER_ONE_ORG_EMAIL,
    OWNER_TWO_ORGS_EMAIL,
    GOVT_EMAIL,
    ADMIN_EMAIL,
  ]) {
    await purgeByEmail(email);
  }

  ownerNoOrgId = await createUser(OWNER_NO_ORG_EMAIL);
  ownerOneOrgId = await createUser(OWNER_ONE_ORG_EMAIL);
  ownerTwoOrgsId = await createUser(OWNER_TWO_ORGS_EMAIL);
  govtUserId = await createUser(GOVT_EMAIL);
  adminUserId = await createUser(ADMIN_EMAIL);

  // Adjust roles (trigger creates everyone as "owner" by default).
  await db
    .update(profiles)
    .set({ role: "govt", accountType: "institutional" })
    .where(eq(profiles.id, govtUserId));
  await db
    .update(profiles)
    .set({ role: "admin", accountType: "institutional" })
    .where(eq(profiles.id, adminUserId));

  // Seed org memberships.
  orgToken1 = `PLLOrg1-${generatePublicToken()}`.slice(0, 40);
  orgToken2 = `PLLOrg2-${generatePublicToken()}`.slice(0, 40);
  orgToken3 = `PLLOrg3-${generatePublicToken()}`.slice(0, 40);

  await seedOrg(orgToken1, ownerOneOrgId); // ownerOneOrg → 1 membership
  await seedOrg(orgToken2, ownerTwoOrgsId); // ownerTwoOrgs → 2 memberships
  await seedOrg(orgToken3, ownerTwoOrgsId);
}, 60_000);

afterAll(async () => {
  await cleanupOrg(orgToken1);
  await cleanupOrg(orgToken2);
  await cleanupOrg(orgToken3);

  for (const email of [
    OWNER_NO_ORG_EMAIL,
    OWNER_ONE_ORG_EMAIL,
    OWNER_TWO_ORGS_EMAIL,
    GOVT_EMAIL,
    ADMIN_EMAIL,
  ]) {
    await purgeByEmail(email);
  }
}, 60_000);

// ---------------------------------------------------------------------------
// resolveUserLanding
// ---------------------------------------------------------------------------

describe("resolveUserLanding", () => {
  it("(a) owner with exactly 1 active org membership → /org/<token>", async () => {
    const path = await resolveUserLanding(ownerOneOrgId);
    expect(path).toBe(`/org/${orgToken1}`);
  });

  it("(b) owner with 0 org memberships → /inicio", async () => {
    const path = await resolveUserLanding(ownerNoOrgId);
    expect(path).toBe("/inicio");
  });

  it("(c) owner with 2+ active org memberships → /inicio (switcher handles selection)", async () => {
    const path = await resolveUserLanding(ownerTwoOrgsId);
    expect(path).toBe("/inicio");
  });

  it("(d) govt role → /gob", async () => {
    const path = await resolveUserLanding(govtUserId);
    expect(path).toBe("/gob");
  });

  it("(e) admin role → /admin", async () => {
    const path = await resolveUserLanding(adminUserId);
    expect(path).toBe("/admin");
  });

  // Task #39 regression: a deactivated institutional account must never be
  // auto-redirected into its portal — the guard bounces it back to `/` and the
  // two redirects loop forever (ERR_TOO_MANY_REDIRECTS). /iniciar-sesion renders the
  // deactivated notice + logout instead.
  it("(f) deactivated institutional admin → /iniciar-sesion (never the portal)", async () => {
    await db
      .update(profiles)
      .set({ deactivatedAt: new Date() })
      .where(eq(profiles.id, adminUserId));
    try {
      const path = await resolveUserLanding(adminUserId);
      expect(path).toBe("/iniciar-sesion");
    } finally {
      await db.update(profiles).set({ deactivatedAt: null }).where(eq(profiles.id, adminUserId));
    }
  });
});

// ---------------------------------------------------------------------------
// isDeactivatedInstitutional (pure predicate behind the loop guard)
// ---------------------------------------------------------------------------

describe("isDeactivatedInstitutional", () => {
  it("true only for institutional accounts with deactivatedAt set", () => {
    expect(
      isDeactivatedInstitutional({ accountType: "institutional", deactivatedAt: new Date() }),
    ).toBe(true);
    expect(isDeactivatedInstitutional({ accountType: "institutional", deactivatedAt: null })).toBe(
      false,
    );
    expect(isDeactivatedInstitutional({ accountType: "personal", deactivatedAt: new Date() })).toBe(
      false,
    );
    expect(isDeactivatedInstitutional(null)).toBe(false);
    expect(isDeactivatedInstitutional(undefined)).toBe(false);
  });
});

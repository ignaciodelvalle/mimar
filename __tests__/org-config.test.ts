// Tests for:
//  1. updateOrganizationForUser — admin-only, whitelisted columns enforced,
//     cross-org rejected, orgType/verified NOT writable.
//  2. createOrganizationForUser — server-side rejection of sanitary_authority.
//
// Runs against the local Supabase + Postgres stack (127.0.0.1:54321/54322).

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { db, organizationMemberships, organizations, profiles } from "@/db";
import { createClient } from "@/lib/supabase/server";
import { updateOrganizationForUser } from "@/src/modules/organizations/actions.internal";
import { createOrganizationForUser } from "@/src/modules/organizations/application/upgrade/create-organization";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabaseAdmin = createSupabaseClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const PASS = "OrgConfig_2026!";
const ADMIN_EMAIL = "org-config-admin@dim-test.local";
const MEMBER_EMAIL = "org-config-member@dim-test.local";
const OTHER_EMAIL = "org-config-other@dim-test.local";

let adminUserId: string;
let memberUserId: string;
let otherUserId: string;
let orgId: string;
let orgToken: string;

function mockSessionAs(userId: string) {
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      getUser: async () => ({
        data: { user: { id: userId } as unknown },
        error: null,
      }),
    },
  } as never);
}

async function deleteTestUser(email: string) {
  const { data: list } = await supabaseAdmin.auth.admin.listUsers();
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
    await db.delete(profiles).where(eq(profiles.id, uid));
  }
  if (found) await supabaseAdmin.auth.admin.deleteUser(found.id);
}

beforeAll(async () => {
  await deleteTestUser(ADMIN_EMAIL);
  await deleteTestUser(MEMBER_EMAIL);
  await deleteTestUser(OTHER_EMAIL);

  const r1 = await createFreshTestUser(supabaseAdmin, {
    email: ADMIN_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (r1.error || !r1.data.user) throw new Error(`createUser admin: ${r1.error?.message}`);
  adminUserId = r1.data.user.id;
  await db.update(profiles).set({ dniVerified: true }).where(eq(profiles.id, adminUserId));

  const r2 = await createFreshTestUser(supabaseAdmin, {
    email: MEMBER_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (r2.error || !r2.data.user) throw new Error(`createUser member: ${r2.error?.message}`);
  memberUserId = r2.data.user.id;

  const r3 = await createFreshTestUser(supabaseAdmin, {
    email: OTHER_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (r3.error || !r3.data.user) throw new Error(`createUser other: ${r3.error?.message}`);
  otherUserId = r3.data.user.id;
  await db.update(profiles).set({ dniVerified: true }).where(eq(profiles.id, otherUserId));

  // Create the test org directly — bypasses approval flow.
  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: "DIM-ORGCFG-TST",
      displayName: "Test Config Org",
      legalName: "Test Config Org SA",
      orgType: "shelter",
      email: "org-config@dim-test.local",
      verified: false,
    })
    .returning();
  orgId = org.id;
  orgToken = org.publicToken;

  // Seed admin membership.
  await db.insert(organizationMemberships).values({
    organizationId: orgId,
    userId: adminUserId,
    role: "admin",
    canWritePetEvents: true,
  });

  // Seed non-admin (member) membership.
  await db.insert(organizationMemberships).values({
    organizationId: orgId,
    userId: memberUserId,
    role: "member",
    canWritePetEvents: false,
  });
});

afterAll(async () => {
  await db.delete(organizationMemberships).where(eq(organizationMemberships.organizationId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await deleteTestUser(ADMIN_EMAIL);
  await deleteTestUser(MEMBER_EMAIL);
  await deleteTestUser(OTHER_EMAIL);
});

// ============================================================================
// § sanitary_authority self-registration rejection
// ============================================================================

describe("createOrganizationForUser — sanitary_authority blocked server-side", () => {
  it("rejects sanitary_authority even when the form bypasses the UI restriction", async () => {
    const result = await createOrganizationForUser(otherUserId, {
      name: "Autoridad Sanitaria CABA",
      legalName: "Dirección Gral. de Zoonosis GCBA",
      orgType: "sanitary_authority",
      email: "zoonosis@buenosaires.gob.ar",
      jurisdictionProvince: "CABA",
      jurisdictionLocality: "Balvanera",
    });
    expect(result.error).toBeTruthy();
    expect(result.error).toMatch(/autoridad sanitaria/i);
    // No org should have been created.
    const orgs = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.publicToken, "DIM-GOVTORG-TST"));
    expect(orgs).toHaveLength(0);
  });
});

// ============================================================================
// § updateOrganizationForUser
// ============================================================================

describe("updateOrganizationForUser — admin-only + whitelist enforcement", () => {
  it("happy path: admin can update safe profile fields", async () => {
    mockSessionAs(adminUserId);
    const result = await updateOrganizationForUser(adminUserId, orgToken, {
      orgToken,
      displayName: "Test Config Org (updated)",
      legalName: "Test Config Org SA Updated",
      email: "updated@dim-test.local",
      phone: "+54 11 1234-5678",
      website: "https://example.com",
      description: "Descripción de prueba.",
      personeriaJuridicaNumber: "12345/2026",
    });
    expect(result.error).toBeNull();
    expect(result.ok).toBe(true);

    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
    expect(org.displayName).toBe("Test Config Org (updated)");
    expect(org.legalName).toBe("Test Config Org SA Updated");
    expect(org.email).toBe("updated@dim-test.local");
    expect(org.phone).toBe("+54 11 1234-5678");
    expect(org.website).toBe("https://example.com");
    expect(org.description).toBe("Descripción de prueba.");
    expect(org.personeriaJuridicaNumber).toBe("12345/2026");

    // Sensitive fields must remain unchanged.
    expect(org.orgType).toBe("shelter");
    expect(org.verified).toBe(false);
    expect(org.status).toBe("active");
    expect(org.publicToken).toBe(orgToken);
  });

  it("rejects non-admin member (member role)", async () => {
    mockSessionAs(memberUserId);
    const result = await updateOrganizationForUser(memberUserId, orgToken, {
      orgToken,
      displayName: "Hacked Name",
    });
    expect(result.error).toBeTruthy();
    expect(result.error).toMatch(/administradores/i);

    // Display name must not have changed.
    const [org] = await db
      .select({ displayName: organizations.displayName })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    expect(org.displayName).not.toBe("Hacked Name");
  });

  it("rejects cross-org attempt (user has no membership in this org)", async () => {
    // otherUserId has no membership in this org — inner writer returns an error.
    mockSessionAs(otherUserId);
    const result = await updateOrganizationForUser(otherUserId, orgToken, {
      orgToken,
      displayName: "Cross-org hack",
    });
    expect(result.error).toBeTruthy();
    expect(result.error).toMatch(/acceso/i);

    // Display name must not have changed to "Cross-org hack".
    const [org] = await db
      .select({ displayName: organizations.displayName })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    expect(org.displayName).not.toBe("Cross-org hack");
  });

  it("rejects empty displayName", async () => {
    mockSessionAs(adminUserId);
    const result = await updateOrganizationForUser(adminUserId, orgToken, {
      orgToken,
      displayName: "",
    });
    expect(result.error).toBeTruthy();
    expect(result.error).toMatch(/nombre/i);
  });

  it("rejects blank legalName (present but empty)", async () => {
    mockSessionAs(adminUserId);
    const result = await updateOrganizationForUser(adminUserId, orgToken, {
      orgToken,
      displayName: "Valid name",
      legalName: "",
    });
    expect(result.error).toBeTruthy();
    expect(result.error).toMatch(/nombre legal/i);
  });

  it("rejects blank email (present but empty)", async () => {
    mockSessionAs(adminUserId);
    const result = await updateOrganizationForUser(adminUserId, orgToken, {
      orgToken,
      displayName: "Valid name",
      email: "",
    });
    expect(result.error).toBeTruthy();
    expect(result.error).toMatch(/email/i);
  });

  it("accepts absent legalName (undefined — leave unchanged)", async () => {
    mockSessionAs(adminUserId);
    const result = await updateOrganizationForUser(adminUserId, orgToken, {
      orgToken,
      displayName: "Valid name",
      // legalName absent — should leave the existing value unchanged
    });
    expect(result.error).toBeNull();
    expect(result.ok).toBe(true);
  });

  it("accepts absent email (undefined — leave unchanged)", async () => {
    mockSessionAs(adminUserId);
    const result = await updateOrganizationForUser(adminUserId, orgToken, {
      orgToken,
      displayName: "Valid name",
      // email absent — should leave the existing value unchanged
    });
    expect(result.error).toBeNull();
    expect(result.ok).toBe(true);
  });

  it("rejects invalid website format", async () => {
    mockSessionAs(adminUserId);
    const result = await updateOrganizationForUser(adminUserId, orgToken, {
      orgToken,
      displayName: "Valid name",
      website: "not-a-url",
    });
    expect(result.error).toBeTruthy();
    expect(result.error).toMatch(/sitio web/i);
  });

  it("orgType cannot be changed via update (field is not in the whitelist)", async () => {
    // The action simply does not accept orgType as an input field — there is no
    // orgType in UpdateOrgInput. This test documents the contract.
    mockSessionAs(adminUserId);
    const before = await db
      .select({ orgType: organizations.orgType })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    await updateOrganizationForUser(adminUserId, orgToken, {
      orgToken,
      displayName: "New name to trigger write",
    });

    const after = await db
      .select({ orgType: organizations.orgType })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    expect(after[0].orgType).toBe(before[0].orgType);
  });

  it("verified status cannot be changed via update (field is not in the whitelist)", async () => {
    mockSessionAs(adminUserId);
    const before = await db
      .select({ verified: organizations.verified })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    await updateOrganizationForUser(adminUserId, orgToken, {
      orgToken,
      displayName: "Another write attempt",
    });

    const after = await db
      .select({ verified: organizations.verified })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    expect(after[0].verified).toBe(before[0].verified);
  });
});

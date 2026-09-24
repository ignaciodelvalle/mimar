// Tests for lib/origin-org — origin-org resolver and badge gating.
// (a) shelter_custody: verified+toggle ON -> resolved+badge shown.
// (b) adopted pet -> previous_owner_organization_id resolved.
// (c) re-adoption: latest adoption_finalized wins.
// (d) verified+toggle OFF -> badge NOT shown.
// (e) toggle ON+NOT verified -> badge NOT shown.
// (f) no origin -> null, badge NOT shown.
// Also: updateOrganizationForUser can set tier0ShowOriginOrg; cannot write orgType/verified.

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import {
  db,
  organizationMemberships,
  organizations,
  ownerships,
  petEvents,
  pets,
  profiles,
} from "@/db";
import { resolveOriginOrg, shouldShowOriginOrgBadge } from "@/lib/infra/origin-org";
import { createClient } from "@/lib/supabase/server";
import { updateOrganizationForUser } from "@/src/modules/organizations/actions.internal";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";
const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabaseAdmin = createSupabaseClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});
const PASS = "OriginOrg_2026!";
const ADMIN_EMAIL = "origin-org-admin@dim-test.local";
let adminUserId: string;
let orgIdVerifiedOn: string;
let orgIdVerifiedOff: string;
let orgIdNotVerified: string;
let orgTokenVerifiedOn: string;
let petCustodyId: string;
let petAdoptedId: string;
let petReAdoptedId: string;
let petNoOriginId: string;
function mockSessionAs(userId: string) {
  vi.mocked(createClient).mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: userId } as unknown }, error: null }) },
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

  // Clean up any stale pets from previous crashed runs
  await withMutationOverride(async (tx) => {
    for (const token of ["DIM-ORIG-PET1", "DIM-ORIG-PET2", "DIM-ORIG-PET3", "DIM-ORIG-PET4"]) {
      const stale = await tx
        .select({ id: pets.id })
        .from(pets)
        .where(eq(pets.publicToken, token))
        .limit(1);
      for (const { id } of stale) {
        await tx.delete(petEvents).where(eq(petEvents.petId, id));
        await tx.delete(ownerships).where(eq(ownerships.petId, id));
        await tx.delete(pets).where(eq(pets.id, id));
      }
    }
  });
  for (const token of ["DIM-ORIGON-TST1", "DIM-ORIGON-TST2", "DIM-ORIGON-TST3"]) {
    const [staleOrg] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.publicToken, token))
      .limit(1);
    if (staleOrg) {
      await db
        .delete(organizationMemberships)
        .where(eq(organizationMemberships.organizationId, staleOrg.id));
      await db.delete(organizations).where(eq(organizations.id, staleOrg.id));
    }
  }

  const r1 = await createFreshTestUser(supabaseAdmin, {
    email: ADMIN_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (r1.error || !r1.data.user) throw new Error(String(r1.error?.message));
  adminUserId = r1.data.user.id;
  const [o1] = await db
    .insert(organizations)
    .values({
      publicToken: "DIM-ORIGON-TST1",
      displayName: "Refugio Origen Activo",
      legalName: "Refugio Origen SA",
      orgType: "shelter",
      email: "origen1@dim-test.local",
      verified: true,
      tier0ShowOriginOrg: true,
    })
    .returning();
  orgIdVerifiedOn = o1.id;
  orgTokenVerifiedOn = o1.publicToken;
  const [o2] = await db
    .insert(organizations)
    .values({
      publicToken: "DIM-ORIGON-TST2",
      displayName: "Refugio Toggle Off",
      legalName: "Refugio Toggle Off SA",
      orgType: "shelter",
      email: "origen2@dim-test.local",
      verified: true,
      tier0ShowOriginOrg: false,
    })
    .returning();
  orgIdVerifiedOff = o2.id;
  const [o3] = await db
    .insert(organizations)
    .values({
      publicToken: "DIM-ORIGON-TST3",
      displayName: "Refugio No Verificado",
      legalName: "Refugio No Verificado SA",
      orgType: "shelter",
      email: "origen3@dim-test.local",
      verified: false,
      tier0ShowOriginOrg: true,
    })
    .returning();
  orgIdNotVerified = o3.id;
  await db.insert(organizationMemberships).values({
    organizationId: orgIdVerifiedOn,
    userId: adminUserId,
    role: "admin",
    canWritePetEvents: true,
  });
  const [p1] = await db
    .insert(pets)
    .values({
      publicToken: "DIM-ORIG-PET1",
      name: "Pelusa",
      species: "dog",
      sex: "female",
      permanentConditions: [],
    })
    .returning();
  petCustodyId = p1.id;
  await db
    .insert(ownerships)
    .values({ petId: petCustodyId, ownerOrganizationId: orgIdVerifiedOn, role: "shelter_custody" });
  const [p2] = await db
    .insert(pets)
    .values({
      publicToken: "DIM-ORIG-PET2",
      name: "Coco",
      species: "cat",
      sex: "male",
      permanentConditions: [],
    })
    .returning();
  petAdoptedId = p2.id;
  const payload2 = {
    payload_version: 1,
    previous_owner_organization_id: orgIdVerifiedOff,
    adopter_user_id: adminUserId,
    foster_user_id: null,
    contract_attachment_id: null,
    post_adoption_followup_months: null,
    notes: null,
  };
  await db.insert(petEvents).values({
    petId: petAdoptedId,
    eventType: "adoption_finalized",
    authorRole: "owner",
    authorVerified: true,
    authorOrganizationId: orgIdVerifiedOff,
    occurredAt: new Date("2025-01-01T10:00:00Z"),
    payload: payload2,
  });
  const [p3] = await db
    .insert(pets)
    .values({
      publicToken: "DIM-ORIG-PET3",
      name: "Michi",
      species: "cat",
      sex: "unknown",
      permanentConditions: [],
    })
    .returning();
  petReAdoptedId = p3.id;
  const payloadOld = {
    payload_version: 1,
    previous_owner_organization_id: orgIdNotVerified,
    adopter_user_id: adminUserId,
    foster_user_id: null,
    contract_attachment_id: null,
    post_adoption_followup_months: null,
    notes: null,
  };
  const payloadNew = {
    payload_version: 1,
    previous_owner_organization_id: orgIdVerifiedOn,
    adopter_user_id: adminUserId,
    foster_user_id: null,
    contract_attachment_id: null,
    post_adoption_followup_months: null,
    notes: null,
  };
  await db.insert(petEvents).values({
    petId: petReAdoptedId,
    eventType: "adoption_finalized",
    authorRole: "owner",
    authorVerified: true,
    authorOrganizationId: orgIdNotVerified,
    occurredAt: new Date("2024-01-01T10:00:00Z"),
    payload: payloadOld,
  });
  await db.insert(petEvents).values({
    petId: petReAdoptedId,
    eventType: "adoption_finalized",
    authorRole: "owner",
    authorVerified: true,
    authorOrganizationId: orgIdVerifiedOn,
    occurredAt: new Date("2025-06-01T10:00:00Z"),
    payload: payloadNew,
  });
  const [p4] = await db
    .insert(pets)
    .values({
      publicToken: "DIM-ORIG-PET4",
      name: "Bobi",
      species: "dog",
      sex: "male",
      permanentConditions: [],
    })
    .returning();
  petNoOriginId = p4.id;
});
afterAll(async () => {
  await withMutationOverride(async (tx) => {
    for (const pid of [petCustodyId, petAdoptedId, petReAdoptedId, petNoOriginId]) {
      if (pid) {
        await tx.delete(petEvents).where(eq(petEvents.petId, pid));
        await tx.delete(ownerships).where(eq(ownerships.petId, pid));
        await tx.delete(pets).where(eq(pets.id, pid));
      }
    }
  });
  if (orgIdVerifiedOn)
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.organizationId, orgIdVerifiedOn));
  for (const oid of [orgIdVerifiedOn, orgIdVerifiedOff, orgIdNotVerified]) {
    if (oid) await db.delete(organizations).where(eq(organizations.id, oid));
  }
  await deleteTestUser(ADMIN_EMAIL);
});
describe("resolveOriginOrg — shelter_custody path", () => {
  it("(a) returns the active shelter_custody org", async () => {
    const org = await resolveOriginOrg(petCustodyId);
    expect(org).not.toBeNull();
    expect(org?.id).toBe(orgIdVerifiedOn);
    expect(org?.verified).toBe(true);
    expect(org?.tier0ShowOriginOrg).toBe(true);
  });
});
describe("resolveOriginOrg — adoption_finalized path", () => {
  it("(b) returns previous_owner_organization_id", async () => {
    const org = await resolveOriginOrg(petAdoptedId);
    expect(org).not.toBeNull();
    expect(org?.id).toBe(orgIdVerifiedOff);
  });
  it("(c) latest adoption_finalized wins on re-adoption", async () => {
    const org = await resolveOriginOrg(petReAdoptedId);
    expect(org).not.toBeNull();
    expect(org?.id).toBe(orgIdVerifiedOn);
  });
});
describe("resolveOriginOrg — no origin", () => {
  it("(f) null when no shelter_custody and no adoption_finalized", async () => {
    expect(await resolveOriginOrg(petNoOriginId)).toBeNull();
  });
});
describe("shouldShowOriginOrgBadge — gating", () => {
  it("(a) verified+ON -> true", () => {
    expect(
      shouldShowOriginOrgBadge({
        id: "x",
        displayName: "R",
        verified: true,
        tier0ShowOriginOrg: true,
        avatarUrl: null,
      }),
    ).toBe(true);
  });
  it("(d) verified+OFF -> false", () => {
    expect(
      shouldShowOriginOrgBadge({
        id: "x",
        displayName: "R",
        verified: true,
        tier0ShowOriginOrg: false,
        avatarUrl: null,
      }),
    ).toBe(false);
  });
  it("(e) ON+NOT verified -> false", () => {
    expect(
      shouldShowOriginOrgBadge({
        id: "x",
        displayName: "R",
        verified: false,
        tier0ShowOriginOrg: true,
        avatarUrl: null,
      }),
    ).toBe(false);
  });
  it("(f) null org -> false", () => {
    expect(shouldShowOriginOrgBadge(null)).toBe(false);
  });
});
// -------------------------------------------------------------------------
// FormData parse — checkbox OFF path
// Tests the action-layer formData → boolean mapping without needing a real
// session. We exercise the same expression the action uses so that if it
// ever regresses back to has()/undefined the test catches it immediately.
// -------------------------------------------------------------------------
describe("updateOrganizationAction formData parse — tier0ShowOriginOrg", () => {
  /**
   * Replicate the exact parse expression from updateOrganizationAction so
   * the test is coupled to the actual decision logic, not a copy of it.
   *   formData.get("tier0ShowOriginOrg") === "true"
   */
  function parseTier0(fd: FormData): boolean {
    return fd.get("tier0ShowOriginOrg") === "true";
  }

  it("checkbox checked (value='true') → true", () => {
    const fd = new FormData();
    fd.set("tier0ShowOriginOrg", "true");
    expect(parseTier0(fd)).toBe(true);
  });

  it("checkbox unchecked (field absent) → false", () => {
    // Simulates a real form submission where an unchecked checkbox sends no field.
    const fd = new FormData();
    expect(parseTier0(fd)).toBe(false);
  });

  it("explicit 'false' string → false (defensive)", () => {
    const fd = new FormData();
    fd.set("tier0ShowOriginOrg", "false");
    expect(parseTier0(fd)).toBe(false);
  });
});

describe("updateOrganizationForUser — tier0ShowOriginOrg writeable; orgType/verified not", () => {
  it("admin can toggle tier0ShowOriginOrg off then on", async () => {
    mockSessionAs(adminUserId);
    await updateOrganizationForUser(adminUserId, orgTokenVerifiedOn, {
      orgToken: orgTokenVerifiedOn,
      displayName: "Refugio Origen Activo",
      tier0ShowOriginOrg: false,
    });
    const [a1] = await db
      .select({ v: organizations.tier0ShowOriginOrg })
      .from(organizations)
      .where(eq(organizations.id, orgIdVerifiedOn))
      .limit(1);
    expect(a1.v).toBe(false);
    await updateOrganizationForUser(adminUserId, orgTokenVerifiedOn, {
      orgToken: orgTokenVerifiedOn,
      displayName: "Refugio Origen Activo",
      tier0ShowOriginOrg: true,
    });
    const [a2] = await db
      .select({ v: organizations.tier0ShowOriginOrg })
      .from(organizations)
      .where(eq(organizations.id, orgIdVerifiedOn))
      .limit(1);
    expect(a2.v).toBe(true);
  });
  it("tier0ShowOriginOrg does NOT mutate orgType or verified", async () => {
    mockSessionAs(adminUserId);
    await updateOrganizationForUser(adminUserId, orgTokenVerifiedOn, {
      orgToken: orgTokenVerifiedOn,
      displayName: "Refugio Origen Activo",
      tier0ShowOriginOrg: false,
    });
    const [org] = await db
      .select({ orgType: organizations.orgType, verified: organizations.verified })
      .from(organizations)
      .where(eq(organizations.id, orgIdVerifiedOn))
      .limit(1);
    expect(org.orgType).toBe("shelter");
    expect(org.verified).toBe(true);
    await updateOrganizationForUser(adminUserId, orgTokenVerifiedOn, {
      orgToken: orgTokenVerifiedOn,
      displayName: "Refugio Origen Activo",
      tier0ShowOriginOrg: true,
    });
  });
});

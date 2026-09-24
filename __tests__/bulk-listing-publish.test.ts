// Integration tests for bulkPublishListingAction (Sprint 8 PR3).
//
// Covers:
//   - happy path publish: eligible pets get adoptionListedAt set + paused cleared.
//   - per-pet guard failures:
//       · ineligible pet (adoptionEligible=false) → failed[] with eligibility message
//       · lost pet → failed[] with lost message
//       · deceased pets are excluded at the ownership-query level
//         (ne(pets.status, "deceased")) and are therefore not reachable by the
//         in-loop guard; no separate unit test covers that path through the loop.
//       · inCustodyDispute=true → failed[] with dispute message
//       · rabiesObservationStatus="in_progress" → failed[] with observation message
//     While an eligible pet in the same batch succeeds.
//   - partial failure: tokens not in custody → failed[], the rest succeed.
//   - unlist path: publish=false clears adoptionListedAt + adoptionListingPausedAt.
//   - auth: no adoption.listing.manage capability → all tokens rejected.
//   - invalid bulkActionId rejected.
//
// Auth is stubbed via vi.mock("@/lib/supabase/server") so requireCapability
// reads the mocked user. Ownership and pet updates use the real DB.

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { bulkPublishListingAction } from "@/app/actions/bulk-pet-events";
import {
  db,
  organizationCapabilityGrants,
  organizationMemberships,
  organizations,
  ownerships,
  petEvents,
  pets,
  profiles,
} from "@/db";
import { createClient } from "@/lib/supabase/server";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

// ─── Test env ─────────────────────────────────────────────────────────────────

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabaseAdmin = createSupabaseClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const COORD_EMAIL = "bulk-listing-coord@dim-test.local";
const NO_CAP_EMAIL = "bulk-listing-nocap@dim-test.local";
const PASS = "BulkListing_2026!";

let coordUserId: string;
let noCapUserId: string;
let orgId: string;
const orgToken = "blisting-test-org";

// Token groups
const PET_TOKENS_ELIGIBLE: string[] = Array.from(
  { length: 4 },
  (_, i) => `DIM-BLIST-E${String(i + 1).padStart(3, "0")}`,
);
const PET_TOKEN_INELIGIBLE = "DIM-BLIST-INELIG001";
const PET_TOKEN_LOST = "DIM-BLIST-LOST001";
const PET_TOKEN_DISPUTE = "DIM-BLIST-DISPUTE001";
const PET_TOKEN_RABIES = "DIM-BLIST-RABIES001";
// Partial: first 3 in custody, last 2 NOT.
const PET_TOKENS_PARTIAL_GOOD = ["DIM-BLIST-PG01", "DIM-BLIST-PG02", "DIM-BLIST-PG03"];
const PET_TOKENS_PARTIAL_BAD = ["DIM-BLIST-PB01", "DIM-BLIST-PB02"];

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

async function purgeUserByEmail(email: string) {
  const { data } = await supabaseAdmin.auth.admin.listUsers();
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
  await withMutationOverride(async (tx) => {
    for (const uid of ids) {
      await tx.delete(organizationMemberships).where(eq(organizationMemberships.userId, uid));
      await tx.delete(profiles).where(eq(profiles.id, uid));
    }
  });
  if (found) await supabaseAdmin.auth.admin.deleteUser(found.id);
}

async function purgeTestPetsByTokens(tokens: string[]) {
  if (tokens.length === 0) return;
  await withMutationOverride(async (tx) => {
    for (const token of tokens) {
      const rows = await tx.select({ id: pets.id }).from(pets).where(eq(pets.publicToken, token));
      for (const { id } of rows) {
        await tx.delete(petEvents).where(eq(petEvents.petId, id));
        await tx.delete(ownerships).where(eq(ownerships.petId, id));
        await tx.delete(pets).where(eq(pets.id, id));
      }
    }
  });
}

async function createTestPetInCustody(
  token: string,
  petOrgId: string,
  overrides?: Partial<typeof pets.$inferInsert>,
): Promise<string> {
  // adoptionEligible=true requires adoptionEligibilitySetAt per DB constraint.
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: token,
      species: "dog",
      name: `Test ${token}`,
      sex: "unknown",
      status: "active",
      adoptionEligible: true,
      adoptionEligibilitySetAt: new Date(),
      ...overrides,
    })
    .returning({ id: pets.id });
  await db.insert(ownerships).values({
    petId: pet!.id,
    ownerOrganizationId: petOrgId,
    role: "shelter_custody",
  });
  return pet!.id;
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

const ALL_TOKENS = [
  ...PET_TOKENS_ELIGIBLE,
  PET_TOKEN_INELIGIBLE,
  PET_TOKEN_LOST,
  PET_TOKEN_DISPUTE,
  PET_TOKEN_RABIES,
  ...PET_TOKENS_PARTIAL_GOOD,
  ...PET_TOKENS_PARTIAL_BAD,
];

beforeAll(async () => {
  await purgeTestPetsByTokens(ALL_TOKENS);
  await purgeUserByEmail(COORD_EMAIL);
  await purgeUserByEmail(NO_CAP_EMAIL);
  await db
    .delete(organizations)
    .where(eq(organizations.publicToken, orgToken))
    .catch(() => null);

  // Create coordinator user.
  const { data: coordData } = await createFreshTestUser(supabaseAdmin, {
    email: COORD_EMAIL,
    password: PASS,
    email_confirm: true,
    user_metadata: { displayName: "bulk-listing-coord" },
  });
  coordUserId = coordData.user!.id;

  // Create no-cap user.
  const { data: noCapData } = await createFreshTestUser(supabaseAdmin, {
    email: NO_CAP_EMAIL,
    password: PASS,
    email_confirm: true,
    user_metadata: { displayName: "bulk-listing-nocap" },
  });
  noCapUserId = noCapData.user!.id;

  // Ensure profile rows exist.
  for (const [uid, displayName] of [
    [coordUserId, "bulk-listing-coord"],
    [noCapUserId, "bulk-listing-nocap"],
  ] as [string, string][]) {
    const [existing] = await db
      .select({ id: profiles.id })
      .from(profiles)
      .where(eq(profiles.id, uid));
    if (!existing) {
      await db.insert(profiles).values({ id: uid, displayName });
    }
  }

  // Create org.
  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: orgToken,
      legalName: "Bulk Listing Test Org",
      displayName: "Bulk Listing Test Org",
      orgType: "shelter",
      email: "blisting@dim-test.local",
    })
    .returning({ id: organizations.id });
  orgId = org!.id;

  // Coordinator membership with adoption.listing.manage grant.
  const [coordMembership] = await db
    .insert(organizationMemberships)
    .values({ organizationId: orgId, userId: coordUserId, role: "coordinator" })
    .returning({ id: organizationMemberships.id });

  await db.insert(organizationCapabilityGrants).values({
    membershipId: coordMembership!.id,
    organizationId: orgId,
    capability: "adoption.listing.manage",
    status: "approved",
    decidedAt: new Date(),
    decidedByUserId: coordUserId,
  });

  // No-cap user membership (no adoption.listing.manage).
  await db.insert(organizationMemberships).values({
    organizationId: orgId,
    userId: noCapUserId,
    role: "member",
  });

  // Eligible pets — status=active, adoptionEligible=true.
  for (const token of PET_TOKENS_ELIGIBLE) {
    await createTestPetInCustody(token, orgId, { adoptionEligible: true });
  }
  // Ineligible pet — adoptionEligible=false (requires reason + set timestamp per DB constraint).
  await createTestPetInCustody(PET_TOKEN_INELIGIBLE, orgId, {
    adoptionEligible: false,
    adoptionIneligibleReason: "medical_treatment",
    adoptionEligibilitySetAt: new Date(),
  });
  // Lost pet — status=lost, adoptionEligible=true.
  await createTestPetInCustody(PET_TOKEN_LOST, orgId, {
    status: "lost",
    adoptionEligible: true,
  });
  // Custody dispute pet — inCustodyDispute=true, adoptionEligible=true.
  await createTestPetInCustody(PET_TOKEN_DISPUTE, orgId, {
    inCustodyDispute: true,
    adoptionEligible: true,
  });
  // Rabies observation pet — rabiesObservationStatus="in_progress", adoptionEligible=true.
  await createTestPetInCustody(PET_TOKEN_RABIES, orgId, {
    rabiesObservationStatus: "in_progress",
    adoptionEligible: true,
  });
  // Partial — good ones in custody, bad ones NOT inserted.
  for (const token of PET_TOKENS_PARTIAL_GOOD) {
    await createTestPetInCustody(token, orgId, { adoptionEligible: true });
  }
  // PET_TOKENS_PARTIAL_BAD intentionally NOT created.
}, 180_000);

afterAll(async () => {
  await purgeTestPetsByTokens(ALL_TOKENS);

  if (orgId) {
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.organizationId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
  }

  await purgeUserByEmail(COORD_EMAIL);
  await purgeUserByEmail(NO_CAP_EMAIL);
}, 120_000);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("bulkPublishListingAction", () => {
  it("happy path publish: eligible pets → adoptionListedAt set, adoptionListingPausedAt null", async () => {
    mockSessionAs(coordUserId);

    const result = await bulkPublishListingAction({
      orgToken,
      petPublicTokens: PET_TOKENS_ELIGIBLE,
      bulkActionId: "aabbccdd-aabb-4bcd-8cde-aabbccddeeff",
      publish: true,
    });

    expect(result.succeeded).toHaveLength(PET_TOKENS_ELIGIBLE.length);
    expect(result.failed).toHaveLength(0);
    expect(result.bulkActionId).toBeTruthy();

    // Verify DB state for first pet.
    const [firstPet] = await db
      .select()
      .from(pets)
      .where(eq(pets.publicToken, PET_TOKENS_ELIGIBLE[0]!));
    expect(firstPet).toBeTruthy();
    expect(firstPet!.adoptionListedAt).not.toBeNull();
    expect(firstPet!.adoptionListingPausedAt).toBeNull();
  }, 60_000);

  it("ineligible pet → failed[] with eligibility message, eligible ones succeed", async () => {
    mockSessionAs(coordUserId);

    const tokens = [PET_TOKENS_ELIGIBLE[0]!, PET_TOKEN_INELIGIBLE];
    const result = await bulkPublishListingAction({
      orgToken,
      petPublicTokens: tokens,
      bulkActionId: "bbccddee-bbcc-4cde-8def-bbccddeeff00",
      publish: true,
    });

    expect(result.succeeded).toContain(PET_TOKENS_ELIGIBLE[0]!);
    const failEntry = result.failed.find((f) => f.id === PET_TOKEN_INELIGIBLE);
    expect(failEntry).toBeTruthy();
    expect(failEntry!.reason).toContain("apta para adopción");

    // Ineligible pet must NOT have adoptionListedAt set.
    const [ineligPet] = await db
      .select()
      .from(pets)
      .where(eq(pets.publicToken, PET_TOKEN_INELIGIBLE));
    expect(ineligPet!.adoptionListedAt).toBeNull();
  }, 30_000);

  it("lost pet → failed[] with lost message, others succeed", async () => {
    mockSessionAs(coordUserId);

    const tokens = [PET_TOKENS_ELIGIBLE[1]!, PET_TOKEN_LOST];
    const result = await bulkPublishListingAction({
      orgToken,
      petPublicTokens: tokens,
      bulkActionId: "ccddee11-ccdd-4def-8ef0-ccddeeff0011",
      publish: true,
    });

    expect(result.succeeded).toContain(PET_TOKENS_ELIGIBLE[1]!);
    const failEntry = result.failed.find((f) => f.id === PET_TOKEN_LOST);
    expect(failEntry).toBeTruthy();
    expect(failEntry!.reason).toContain("perdida");
  }, 30_000);

  it("inCustodyDispute pet → failed[] with dispute message", async () => {
    mockSessionAs(coordUserId);

    const tokens = [PET_TOKENS_ELIGIBLE[2]!, PET_TOKEN_DISPUTE];
    const result = await bulkPublishListingAction({
      orgToken,
      petPublicTokens: tokens,
      bulkActionId: "ddeeff22-ddee-4ef0-8f01-ddeeff001122",
      publish: true,
    });

    expect(result.succeeded).toContain(PET_TOKENS_ELIGIBLE[2]!);
    const failEntry = result.failed.find((f) => f.id === PET_TOKEN_DISPUTE);
    expect(failEntry).toBeTruthy();
    expect(failEntry!.reason).toContain("disputa");
  }, 30_000);

  it("rabies observation pet → failed[] with sanitaria message", async () => {
    mockSessionAs(coordUserId);

    const tokens = [PET_TOKENS_ELIGIBLE[3]!, PET_TOKEN_RABIES];
    const result = await bulkPublishListingAction({
      orgToken,
      petPublicTokens: tokens,
      bulkActionId: "eeff0033-eeff-4f01-8012-eeff00112233",
      publish: true,
    });

    expect(result.succeeded).toContain(PET_TOKENS_ELIGIBLE[3]!);
    const failEntry = result.failed.find((f) => f.id === PET_TOKEN_RABIES);
    expect(failEntry).toBeTruthy();
    expect(failEntry!.reason).toContain("observación sanitaria");
  }, 30_000);

  it("partial failure: tokens not in custody → failed[], the rest succeed", async () => {
    mockSessionAs(coordUserId);

    const allTokens = [...PET_TOKENS_PARTIAL_GOOD, ...PET_TOKENS_PARTIAL_BAD];
    const result = await bulkPublishListingAction({
      orgToken,
      petPublicTokens: allTokens,
      bulkActionId: "ff001144-ff00-4012-8123-ff0011223344",
      publish: true,
    });

    expect(result.succeeded).toHaveLength(PET_TOKENS_PARTIAL_GOOD.length);
    expect(result.failed).toHaveLength(PET_TOKENS_PARTIAL_BAD.length);

    for (const token of PET_TOKENS_PARTIAL_BAD) {
      const entry = result.failed.find((f) => f.id === token);
      expect(entry).toBeTruthy();
      expect(entry!.reason).toContain("custodia");
    }
    for (const token of PET_TOKENS_PARTIAL_GOOD) {
      expect(result.succeeded).toContain(token);
    }
  }, 30_000);

  it("unlist path: publish=false clears adoptionListedAt + adoptionListingPausedAt", async () => {
    mockSessionAs(coordUserId);

    // First ensure the pet is listed.
    await db
      .update(pets)
      .set({ adoptionListedAt: new Date(), adoptionListingPausedAt: new Date() })
      .where(eq(pets.publicToken, PET_TOKENS_ELIGIBLE[0]!));

    const result = await bulkPublishListingAction({
      orgToken,
      petPublicTokens: [PET_TOKENS_ELIGIBLE[0]!],
      bulkActionId: "00112255-0011-4123-8234-001122334455",
      publish: false,
    });

    // The action must report the token in succeeded[] and zero failures.
    // This is the server-side source of truth that drives the UI: the client
    // maps publish=false results to the "listing-unlist" actionType, which
    // ResultPanel renders as "despublicada(s)". The noun mapping itself is
    // enforced by the TypeScript union (listing-publish | listing-unlist).
    expect(result.succeeded).toContain(PET_TOKENS_ELIGIBLE[0]!);
    expect(result.failed).toHaveLength(0);
    expect(result.bulkActionId).toBeTruthy();

    const [pet] = await db.select().from(pets).where(eq(pets.publicToken, PET_TOKENS_ELIGIBLE[0]!));
    expect(pet!.adoptionListedAt).toBeNull();
    expect(pet!.adoptionListingPausedAt).toBeNull();
  }, 30_000);

  it("auth: no adoption.listing.manage capability → all tokens rejected", async () => {
    mockSessionAs(noCapUserId);

    const result = await bulkPublishListingAction({
      orgToken,
      petPublicTokens: PET_TOKENS_ELIGIBLE.slice(0, 2),
      bulkActionId: "11223366-1122-4234-8345-112233445566",
      publish: true,
    });

    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toHaveLength(2);
    for (const f of result.failed) {
      expect(f.reason).toBeTruthy();
    }
  }, 10_000);

  it.each([
    { label: "empty string", id: "" },
    { label: "non-UUID string", id: "not-a-uuid" },
    { label: "UUID v1 (wrong version)", id: "6ba7b810-9dad-11d1-80b4-00c04fd430c8" },
  ])(
    "invalid bulkActionId ($label) → all tokens rejected before DB",
    async ({ id }) => {
      mockSessionAs(coordUserId);

      const tokens = PET_TOKENS_ELIGIBLE.slice(0, 2);
      const result = await bulkPublishListingAction({
        orgToken,
        petPublicTokens: tokens,
        bulkActionId: id as string,
        publish: true,
      });

      expect(result.succeeded).toHaveLength(0);
      expect(result.failed).toHaveLength(tokens.length);
      expect(result.failed[0]!.reason).toContain("bulkActionId");
    },
    10_000,
  );
});

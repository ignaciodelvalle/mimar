// Integration tests for bulkSetEligibilityAction (Sprint 8 PR2).
//
// Covers:
//   - happy path eligible: N pets marked eligible → adoptionEligible=true + events written.
//   - happy path ineligible: N pets marked not-eligible with reason → columns + event.
//   - validation: not-eligible without reason → rejected before DB.
//   - partial failure: tokens not in custody → failed[], the rest succeed.
//   - idempotency: same bulkActionId → no duplicate events, succeeded returned again.
//   - auth: no intake.create capability → all tokens rejected.
//
// Auth is stubbed via vi.mock("@/lib/supabase/server") so requireCapability
// reads the mocked user. Ownership and event inserts use the real DB.

import { createHash } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { bulkSetEligibilityAction } from "@/app/actions/bulk-pet-events";
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

const COORD_EMAIL = "bulk-elig-coord@dim-test.local";
const NO_CAP_EMAIL = "bulk-elig-nocap@dim-test.local";
const PASS = "BulkElig_2026!";

let coordUserId: string;
let noCapUserId: string;
let orgId: string;
const orgToken = "belig-test-org";

// Pet token groups.
const PET_TOKENS_ELIGIBLE: string[] = Array.from(
  { length: 5 },
  (_, i) => `DIM-BELIG-E${String(i + 1).padStart(3, "0")}`,
);
const PET_TOKENS_INELIGIBLE: string[] = Array.from(
  { length: 5 },
  (_, i) => `DIM-BELIG-N${String(i + 1).padStart(3, "0")}`,
);
// Partial: first 3 in custody, last 2 NOT.
const PET_TOKENS_PARTIAL_GOOD = ["DIM-BELIG-PG01", "DIM-BELIG-PG02", "DIM-BELIG-PG03"];
const PET_TOKENS_PARTIAL_BAD = ["DIM-BELIG-PB01", "DIM-BELIG-PB02"];

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

async function createTestPetInCustody(token: string, petOrgId: string): Promise<string> {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: token,
      species: "dog",
      name: `Test ${token}`,
      sex: "unknown",
      status: "active",
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

beforeAll(async () => {
  const allTokens = [
    ...PET_TOKENS_ELIGIBLE,
    ...PET_TOKENS_INELIGIBLE,
    ...PET_TOKENS_PARTIAL_GOOD,
    ...PET_TOKENS_PARTIAL_BAD,
  ];
  await purgeTestPetsByTokens(allTokens);
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
    user_metadata: { displayName: "bulk-elig-coord" },
  });
  coordUserId = coordData.user!.id;

  // Create no-cap user.
  const { data: noCapData } = await createFreshTestUser(supabaseAdmin, {
    email: NO_CAP_EMAIL,
    password: PASS,
    email_confirm: true,
    user_metadata: { displayName: "bulk-elig-nocap" },
  });
  noCapUserId = noCapData.user!.id;

  // Ensure profile rows exist.
  const [coordProfile] = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.id, coordUserId));
  if (!coordProfile) {
    await db.insert(profiles).values({ id: coordUserId, displayName: "bulk-elig-coord" });
  }
  const [noCapProfile] = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.id, noCapUserId));
  if (!noCapProfile) {
    await db.insert(profiles).values({ id: noCapUserId, displayName: "bulk-elig-nocap" });
  }

  // Create org.
  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: orgToken,
      legalName: "Bulk Elig Test Org",
      displayName: "Bulk Elig Test Org",
      orgType: "shelter",
      email: "belig@dim-test.local",
    })
    .returning({ id: organizations.id });
  orgId = org!.id;

  // Coordinator membership with intake.create grant.
  const [coordMembership] = await db
    .insert(organizationMemberships)
    .values({
      organizationId: orgId,
      userId: coordUserId,
      role: "coordinator",
    })
    .returning({ id: organizationMemberships.id });

  await db.insert(organizationCapabilityGrants).values({
    membershipId: coordMembership!.id,
    organizationId: orgId,
    capability: "intake.create",
    status: "approved",
    decidedAt: new Date(),
    decidedByUserId: coordUserId,
  });

  // No-cap user membership (no intake.create grant).
  await db.insert(organizationMemberships).values({
    organizationId: orgId,
    userId: noCapUserId,
    role: "member",
  });

  // Create test pets in custody.
  for (const token of PET_TOKENS_ELIGIBLE) {
    await createTestPetInCustody(token, orgId);
  }
  for (const token of PET_TOKENS_INELIGIBLE) {
    await createTestPetInCustody(token, orgId);
  }
  for (const token of PET_TOKENS_PARTIAL_GOOD) {
    await createTestPetInCustody(token, orgId);
  }
  // PET_TOKENS_PARTIAL_BAD are intentionally NOT created in custody.
}, 180_000);

afterAll(async () => {
  const allTokens = [
    ...PET_TOKENS_ELIGIBLE,
    ...PET_TOKENS_INELIGIBLE,
    ...PET_TOKENS_PARTIAL_GOOD,
    ...PET_TOKENS_PARTIAL_BAD,
  ];
  await purgeTestPetsByTokens(allTokens);

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

describe("bulkSetEligibilityAction", () => {
  it("happy path: mark N pets eligible → adoptionEligible=true + adoption_eligibility_set events", async () => {
    mockSessionAs(coordUserId);

    const result = await bulkSetEligibilityAction({
      orgToken,
      petPublicTokens: PET_TOKENS_ELIGIBLE,
      bulkActionId: "11334455-1133-4234-8455-112233445566",
      eligible: true,
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
    expect(firstPet!.adoptionEligible).toBe(true);
    expect(firstPet!.adoptionIneligibleReason).toBeNull();
    expect(firstPet!.adoptionEligibilitySetAt).not.toBeNull();
    expect(firstPet!.adoptionEligibilitySetByUserId).toBe(coordUserId);

    const evts = await db
      .select()
      .from(petEvents)
      .where(
        and(eq(petEvents.petId, firstPet!.id), eq(petEvents.eventType, "adoption_eligibility_set")),
      );
    expect(evts).toHaveLength(1);

    const payload = evts[0]!.payload as Record<string, unknown>;
    expect(payload.eligible).toBe(true);
    expect(payload.ineligible_reason).toBeNull();
    expect(evts[0]!.authorRole).toBe("shelter");
    expect(evts[0]!.authorOrganizationId).toBe(orgId);
    expect(evts[0]!.clientIdempotencyKey).toBeTruthy();
  }, 60_000);

  it("mark pets not-eligible with reason → columns + event", async () => {
    mockSessionAs(coordUserId);

    const result = await bulkSetEligibilityAction({
      orgToken,
      petPublicTokens: PET_TOKENS_INELIGIBLE,
      bulkActionId: "22445566-2244-4345-8566-223344556677",
      eligible: false,
      ineligibleReason: "medical_treatment",
      ineligibleReasonNotes: "Recuperándose de cirugía",
    });

    expect(result.succeeded).toHaveLength(PET_TOKENS_INELIGIBLE.length);
    expect(result.failed).toHaveLength(0);

    // Verify DB state for first ineligible pet.
    const [firstPet] = await db
      .select()
      .from(pets)
      .where(eq(pets.publicToken, PET_TOKENS_INELIGIBLE[0]!));
    expect(firstPet).toBeTruthy();
    expect(firstPet!.adoptionEligible).toBe(false);
    expect(firstPet!.adoptionIneligibleReason).toBe("medical_treatment");
    expect(firstPet!.adoptionIneligibleReasonNotes).toBe("Recuperándose de cirugía");

    const evts = await db
      .select()
      .from(petEvents)
      .where(
        and(eq(petEvents.petId, firstPet!.id), eq(petEvents.eventType, "adoption_eligibility_set")),
      );
    expect(evts).toHaveLength(1);

    const payload = evts[0]!.payload as Record<string, unknown>;
    expect(payload.eligible).toBe(false);
    expect(payload.ineligible_reason).toBe("medical_treatment");
    expect(payload.ineligible_reason_notes).toBe("Recuperándose de cirugía");
  }, 60_000);

  it("validation: not-eligible without reason → all tokens rejected before DB", async () => {
    mockSessionAs(coordUserId);

    const result = await bulkSetEligibilityAction({
      orgToken,
      petPublicTokens: PET_TOKENS_ELIGIBLE.slice(0, 2),
      bulkActionId: "33556677-3355-4456-8677-334455667788",
      eligible: false,
      // ineligibleReason intentionally omitted
    });

    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toHaveLength(2);
    expect(result.failed[0]!.reason).toContain("razón");
  }, 10_000);

  it("partial failure: tokens not in custody → failed[], the rest succeed", async () => {
    mockSessionAs(coordUserId);

    const allTokens = [...PET_TOKENS_PARTIAL_GOOD, ...PET_TOKENS_PARTIAL_BAD];
    const result = await bulkSetEligibilityAction({
      orgToken,
      petPublicTokens: allTokens,
      bulkActionId: "44667788-4466-4567-8788-445566778899",
      eligible: true,
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

  it("idempotent retry: same bulkActionId → no duplicate events, same succeeded set", async () => {
    mockSessionAs(coordUserId);

    const tokens = PET_TOKENS_ELIGIBLE.slice(0, 3);
    const bulkActionId = "55778899-5577-4678-8899-5566778899aa";

    const result1 = await bulkSetEligibilityAction({
      orgToken,
      petPublicTokens: tokens,
      bulkActionId,
      eligible: true,
    });

    const result2 = await bulkSetEligibilityAction({
      orgToken,
      petPublicTokens: tokens,
      bulkActionId,
      eligible: true,
    });

    expect([...result1.succeeded].sort()).toEqual([...result2.succeeded].sort());
    expect(result2.failed).toHaveLength(0);

    // No duplicate events: exactly 1 adoption_eligibility_set per pet for the
    // specific clientIdempotencyKey derived from this bulkActionId.
    // Derive key the same way the action does (SHA-256 of bulkActionId:petId → UUID v4).
    for (const token of tokens) {
      const [p] = await db.select({ id: pets.id }).from(pets).where(eq(pets.publicToken, token));
      expect(p).toBeTruthy();

      const hash = createHash("sha256").update(`${bulkActionId}:${p!.id}`).digest("hex");
      const variantNibble = (Number.parseInt(hash.charAt(16), 16) & 0x3) | 0x8;
      const expectedKey = [
        hash.slice(0, 8),
        hash.slice(8, 12),
        `4${hash.slice(13, 16)}`,
        `${variantNibble.toString(16)}${hash.slice(17, 20)}`,
        hash.slice(20, 32),
      ].join("-");

      const evts = await db
        .select()
        .from(petEvents)
        .where(
          and(
            eq(petEvents.petId, p!.id),
            eq(petEvents.eventType, "adoption_eligibility_set"),
            eq(petEvents.clientIdempotencyKey, expectedKey),
          ),
        );
      // Exactly 1 event for this specific idempotency key — the retry must be a no-op.
      expect(evts).toHaveLength(1);
    }
  }, 30_000);

  it("auth: no intake.create capability → all tokens rejected", async () => {
    mockSessionAs(noCapUserId);

    const result = await bulkSetEligibilityAction({
      orgToken,
      petPublicTokens: PET_TOKENS_ELIGIBLE.slice(0, 3),
      bulkActionId: "668899aa-6688-4789-89aa-6677889900bb",
      eligible: true,
    });

    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toHaveLength(3);
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
      const result = await bulkSetEligibilityAction({
        orgToken,
        petPublicTokens: tokens,
        // Cast to string to simulate a caller bypassing the type
        bulkActionId: id as string,
        eligible: true,
      });

      expect(result.succeeded).toHaveLength(0);
      expect(result.failed).toHaveLength(tokens.length);
      expect(result.failed[0]!.reason).toContain("bulkActionId");
    },
    10_000,
  );
});

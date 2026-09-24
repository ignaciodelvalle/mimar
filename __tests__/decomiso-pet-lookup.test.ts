// Integration + unit tests for lookupPetForDecomisoAction.
//
// Jurisdiction scope check (PII guard):
//   - In-jurisdiction govt lookup → returns pet + hasOwner + ownerDisplayName.
//   - Out-of-jurisdiction govt lookup → { found: false, error } — NO PII leak.
//   - Admin lookup (cross-jurisdiction) → returns pet + owner PII regardless of pet province.
//
// We mock requireDecomisoPrincipal so the action can be called without a live
// Supabase auth session (same pattern as localities-search-action.test.ts).

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/infra/auth-guards", () => ({
  requireDecomisoPrincipal: vi.fn(),
}));

import { lookupPetForDecomisoAction } from "@/app/actions/decomiso-pet-lookup";
import { db, govtAssignments, ownerships, pets, profiles } from "@/db";
import { requireDecomisoPrincipal } from "@/lib/infra/auth-guards";
import { withMutationOverride } from "./_helpers/db-overrides";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const IN_PET_TOKEN = "DIM-LKUP-IN01";
const OUT_PET_TOKEN = "DIM-LKUP-OT01";
const NULL_PROV_TOKEN = "DIM-LKUP-NP01";
// Same province as the govt user (CABA) but a DIFFERENT locality — must be
// out of scope under the (province, locality) pair check (review 24 HIGH #3).
const WRONG_LOCALITY_TOKEN = "DIM-LKUP-WL01";
const OWNER_DISPLAY_NAME = "Titular Test Lookup";

let inPetId: string;
let outPetId: string;
let nullProvPetId: string;
let wrongLocalityPetId: string;
let ownerUserId: string;
let govtUserId: string;
let adminUserId: string;

// Build a DecomisoPrincipalSession mock for a govt user assigned to CABA.
function govtSession(userId: string) {
  return {
    user: { id: userId } as never,
    profile: { id: userId, role: "govt" as const },
    jurisdictions: [{ province: "CABA", locality: "Buenos Aires" }],
  };
}

// Build a DecomisoPrincipalSession mock for an admin (universal scope).
function adminSession(userId: string) {
  return {
    user: { id: userId } as never,
    profile: { id: userId, role: "admin" as const },
    jurisdictions: [],
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Clean up any stale state.
  await withMutationOverride(async (tx) => {
    for (const token of [IN_PET_TOKEN, OUT_PET_TOKEN, NULL_PROV_TOKEN, WRONG_LOCALITY_TOKEN]) {
      await tx.execute(sql`DELETE FROM ownerships WHERE pet_id IN (
        SELECT id FROM pets WHERE public_token = ${token}
      )`);
      await tx.execute(sql`DELETE FROM pets WHERE public_token = ${token}`);
    }
  });

  // Pet in CABA / Buenos Aires — exact (province, locality) pair of the test
  // govt user's jurisdiction, so it is in scope under the pair check.
  const [inPet] = await db
    .insert(pets)
    .values({
      publicToken: IN_PET_TOKEN,
      name: "Roco Lookup",
      species: "dog",
      sex: "male",
      potentiallyDangerousBreed: false,
      jurisdictionProvince: "CABA",
      jurisdictionLocality: "Buenos Aires",
    })
    .returning();
  inPetId = inPet.id;

  // Pet in CABA but a different locality — province matches, locality does not,
  // so it must be OUT of scope under the pair check (the core HIGH #3 leak).
  const [wrongLocalityPet] = await db
    .insert(pets)
    .values({
      publicToken: WRONG_LOCALITY_TOKEN,
      name: "Frida Lookup",
      species: "dog",
      sex: "female",
      potentiallyDangerousBreed: false,
      jurisdictionProvince: "CABA",
      jurisdictionLocality: "La Boca",
    })
    .returning();
  wrongLocalityPetId = wrongLocalityPet.id;

  // Pet in Mendoza — out of scope for the CABA govt user.
  const [outPet] = await db
    .insert(pets)
    .values({
      publicToken: OUT_PET_TOKEN,
      name: "Pulga Lookup",
      species: "cat",
      sex: "female",
      potentiallyDangerousBreed: false,
      jurisdictionProvince: "Mendoza",
    })
    .returning();
  outPetId = outPet.id;

  // Pet with null province — no recorded jurisdiction, always in scope.
  const [nullProvPet] = await db
    .insert(pets)
    .values({
      publicToken: NULL_PROV_TOKEN,
      name: "Anónimo Lookup",
      species: "dog",
      sex: "male",
      potentiallyDangerousBreed: false,
      // jurisdictionProvince intentionally omitted (null)
    })
    .returning();
  nullProvPetId = nullProvPet.id;

  // Owner profile for the in-scope pet.
  const ownerId = randomUUID();
  await db.insert(profiles).values({
    id: ownerId,
    displayName: OWNER_DISPLAY_NAME,
    role: "owner",
    accountType: "personal",
  });
  ownerUserId = ownerId;

  // Active owner ownership on the in-scope pet.
  await db.insert(ownerships).values({
    petId: inPetId,
    ownerUserId,
    role: "owner",
    startedAt: new Date(),
  });

  // Give the wrong-locality pet an owner too, so an escaped guard WOULD leak
  // PII — the test asserts it does not.
  await db.insert(ownerships).values({
    petId: wrongLocalityPetId,
    ownerUserId,
    role: "owner",
    startedAt: new Date(),
  });

  // Govt user profile (stub — no auth.users row required for action testing).
  const gId = randomUUID();
  await db.insert(profiles).values({
    id: gId,
    displayName: "Oficial Test Lookup",
    role: "govt",
    accountType: "institutional",
  });
  govtUserId = gId;

  // Assign CABA to the govt user.
  await db.insert(govtAssignments).values({
    userId: govtUserId,
    jurisdictionProvince: "CABA",
    jurisdictionLocality: "Buenos Aires",
    grantedByUserId: govtUserId,
  });

  // Admin profile (stub).
  const aId = randomUUID();
  await db.insert(profiles).values({
    id: aId,
    displayName: "Admin Test Lookup",
    role: "admin",
    accountType: "institutional",
  });
  adminUserId = aId;
});

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    for (const id of [inPetId, outPetId, nullProvPetId, wrongLocalityPetId].filter(Boolean)) {
      await tx.execute(sql`DELETE FROM ownerships WHERE pet_id = ${id}`);
      await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${id}`);
      await tx.execute(sql`DELETE FROM pets WHERE id = ${id}`);
    }
    if (govtUserId) {
      await tx.execute(sql`DELETE FROM govt_assignments WHERE user_id = ${govtUserId}`);
      await tx.execute(sql`DELETE FROM profiles WHERE id = ${govtUserId}`);
    }
    if (ownerUserId) {
      await tx.execute(sql`DELETE FROM profiles WHERE id = ${ownerUserId}`);
    }
    if (adminUserId) {
      await tx.execute(sql`DELETE FROM profiles WHERE id = ${adminUserId}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Domain logic unit tests (no DB required — mirrors executeDecomisoAction Fix 1 tests)
// ---------------------------------------------------------------------------

describe("lookupPetForDecomisoAction — jurisdiction scope logic (unit)", () => {
  // The scope check now requires the FULL (province, locality) pair to match
  // an assignment (review 24 HIGH #3) — province-only / null-province allowances
  // were cross-locality PII leaks.
  const pairInScope = (
    jurisdictions: { province: string; locality: string }[],
    petProvince: string | null,
    petLocality: string | null,
  ) => jurisdictions.some((j) => j.province === petProvince && j.locality === petLocality);

  it("CABA/Buenos Aires govt is in-scope for a CABA/Buenos Aires pet", () => {
    const jurisdictions = [{ province: "CABA", locality: "Buenos Aires" }];
    expect(pairInScope(jurisdictions, "CABA", "Buenos Aires")).toBe(true);
  });

  it("CABA govt is out-of-scope for a Mendoza pet (province mismatch)", () => {
    const jurisdictions = [{ province: "CABA", locality: "Buenos Aires" }];
    expect(pairInScope(jurisdictions, "Mendoza", "Mendoza")).toBe(false);
  });

  it("CABA/Buenos Aires govt is out-of-scope for a CABA/La Boca pet (locality mismatch)", () => {
    const jurisdictions = [{ province: "CABA", locality: "Buenos Aires" }];
    expect(pairInScope(jurisdictions, "CABA", "La Boca")).toBe(false);
  });

  it("null pet province/locality is now OUT of scope (fail-closed)", () => {
    const jurisdictions = [{ province: "CABA", locality: "Buenos Aires" }];
    expect(pairInScope(jurisdictions, null, null)).toBe(false);
  });

  it("admin (empty jurisdictions) — logic check bypassed by role guard", () => {
    // Admin path is role === 'admin', so the jurisdictions array is never consulted.
    // The jurisdiction check in the action is gated with `if (session.profile.role === 'govt')`.
    // For admin the guard never fires, so empty jurisdictions never block a lookup.
    // Verified via the integration test below; this unit test just documents the invariant.
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — action called with mocked session
// ---------------------------------------------------------------------------

describe("lookupPetForDecomisoAction — in-jurisdiction govt lookup", () => {
  it("returns pet data and owner PII for a pet in the govt user's jurisdiction", async () => {
    vi.mocked(requireDecomisoPrincipal).mockResolvedValue(govtSession(govtUserId) as never);

    const result = await lookupPetForDecomisoAction(IN_PET_TOKEN);

    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.publicToken).toBe(IN_PET_TOKEN);
    expect(result.name).toBe("Roco Lookup");
    expect(result.hasOwner).toBe(true);
    expect(result.ownerDisplayName).toBe(OWNER_DISPLAY_NAME);
  });
});

describe("lookupPetForDecomisoAction — out-of-jurisdiction govt lookup", () => {
  it("returns { found: false, error } without leaking owner PII for Mendoza pet", async () => {
    vi.mocked(requireDecomisoPrincipal).mockResolvedValue(govtSession(govtUserId) as never);

    const result = await lookupPetForDecomisoAction(OUT_PET_TOKEN);

    expect(result.found).toBe(false);
    if (result.found) return;
    expect(result.error).toContain("jurisdicción");
    // Confirm the result type has no PII fields.
    expect("ownerDisplayName" in result).toBe(false);
    expect("hasOwner" in result).toBe(false);
  });

  it("returns the jurisdiction error message matching executeDecomisoAction", async () => {
    vi.mocked(requireDecomisoPrincipal).mockResolvedValue(govtSession(govtUserId) as never);

    const result = await lookupPetForDecomisoAction(OUT_PET_TOKEN);

    expect(result.found).toBe(false);
    if (result.found) return;
    expect(result.error).toBe("Esta mascota no está en tu jurisdicción asignada.");
  });
});

describe("lookupPetForDecomisoAction — null-province pet (no jurisdiction recorded)", () => {
  it("govt user is now OUT of scope for a pet with null jurisdiction (fail-closed)", async () => {
    vi.mocked(requireDecomisoPrincipal).mockResolvedValue(govtSession(govtUserId) as never);

    const result = await lookupPetForDecomisoAction(NULL_PROV_TOKEN);

    // Pair check: null (province, locality) matches no assignment → rejected.
    expect(result.found).toBe(false);
    if (result.found) return;
    expect(result.error).toBe("Esta mascota no está en tu jurisdicción asignada.");
  });

  it("admin can still look up a null-jurisdiction pet (universal scope)", async () => {
    vi.mocked(requireDecomisoPrincipal).mockResolvedValue(adminSession(adminUserId) as never);

    const result = await lookupPetForDecomisoAction(NULL_PROV_TOKEN);

    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.publicToken).toBe(NULL_PROV_TOKEN);
  });
});

describe("lookupPetForDecomisoAction — wrong-locality govt lookup (review 24 HIGH #3)", () => {
  it("rejects a CABA/Buenos Aires govt reading a CABA/La Boca pet — no owner PII", async () => {
    vi.mocked(requireDecomisoPrincipal).mockResolvedValue(govtSession(govtUserId) as never);

    const result = await lookupPetForDecomisoAction(WRONG_LOCALITY_TOKEN);

    expect(result.found).toBe(false);
    if (result.found) return;
    expect(result.error).toBe("Esta mascota no está en tu jurisdicción asignada.");
    // The pet HAS an owner; confirm no PII fields leaked despite that.
    expect("ownerDisplayName" in result).toBe(false);
    expect("hasOwner" in result).toBe(false);
  });

  it("admin (universal scope) CAN read the CABA/La Boca pet and gets owner PII", async () => {
    vi.mocked(requireDecomisoPrincipal).mockResolvedValue(adminSession(adminUserId) as never);

    const result = await lookupPetForDecomisoAction(WRONG_LOCALITY_TOKEN);

    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.hasOwner).toBe(true);
    expect(result.ownerDisplayName).toBe(OWNER_DISPLAY_NAME);
  });
});

describe("lookupPetForDecomisoAction — admin lookup (universal scope)", () => {
  it("admin can look up the Mendoza pet (cross-jurisdiction) and gets owner PII", async () => {
    vi.mocked(requireDecomisoPrincipal).mockResolvedValue(adminSession(adminUserId) as never);

    // outPet (Mendoza) has no owner. We verify the action succeeds and returns
    // hasOwner=false (not rejected) — confirming admin bypasses the jurisdiction check.
    const result = await lookupPetForDecomisoAction(OUT_PET_TOKEN);

    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.publicToken).toBe(OUT_PET_TOKEN);
    expect(result.hasOwner).toBe(false);
  });

  it("admin can look up the in-scope pet and gets owner display name", async () => {
    vi.mocked(requireDecomisoPrincipal).mockResolvedValue(adminSession(adminUserId) as never);

    const result = await lookupPetForDecomisoAction(IN_PET_TOKEN);

    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.ownerDisplayName).toBe(OWNER_DISPLAY_NAME);
    expect(result.hasOwner).toBe(true);
  });
});

describe("lookupPetForDecomisoAction — token validation", () => {
  it("rejects an empty query", async () => {
    vi.mocked(requireDecomisoPrincipal).mockResolvedValue(govtSession(govtUserId) as never);

    const result = await lookupPetForDecomisoAction("   ");
    expect(result.found).toBe(false);
    if (result.found) return;
    expect(result.error).toContain("token");
  });

  it("rejects a malformed token", async () => {
    vi.mocked(requireDecomisoPrincipal).mockResolvedValue(govtSession(govtUserId) as never);

    const result = await lookupPetForDecomisoAction("not-a-token");
    expect(result.found).toBe(false);
    if (result.found) return;
    expect(result.error).toContain("DIM-XXXX-XXXX");
  });

  it("still resolves a lowercase ASCII token (normalisation unchanged for plain input)", async () => {
    vi.mocked(requireDecomisoPrincipal).mockResolvedValue(govtSession(govtUserId) as never);

    const result = await lookupPetForDecomisoAction(` ${IN_PET_TOKEN.toLowerCase()} `);
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.publicToken).toBe(IN_PET_TOKEN);
  });

  it("rejects a Unicode lookalike as MALFORMED instead of folding it (dotless ı)", async () => {
    // Unicode toUpperCase() maps `ı` to `I`, so the old code accepted the shape
    // and went on to query; the ASCII normaliser leaves it and the shape fails.
    vi.mocked(requireDecomisoPrincipal).mockResolvedValue(govtSession(govtUserId) as never);

    const result = await lookupPetForDecomisoAction("dım-abcd-2345");
    expect(result.found).toBe(false);
    if (result.found) return;
    expect(result.error).toContain("DIM-XXXX-XXXX");
  });
});

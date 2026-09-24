// Regression test for lib/pet-identifiers.ts (ARCH-Q).
//
// fetchActiveIdentifications' single-pet query omits petId from the select
// (the WHERE already filters by it), so rows key under the single-pet
// sentinel. The original implementation indexed the result by the pet's UUID
// and therefore ALWAYS returned empty identifications — every migrated
// single-pet reader silently lost chip/tattoo data. These tests pin the
// helper against the real DB so that bug class cannot return.

import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, ownerships, petIdentifications, pets, profiles } from "@/db";
import { fetchComplianceStatesForPets } from "@/lib/analytics/owner-dashboard";
import {
  batchFetchActiveIdentifications,
  fetchActiveIdentifications,
} from "@/lib/infra/pet-identifiers";

const seedPetIds: string[] = [];

const CHIP_CODE = "858000099990001";
const TATTOO_CODE = "ARCHQ-REGRESSION";

// v4-shaped UUIDs (zod's uuid format wants the version/variant nibbles).
const OWNER_ID = "00000000-0000-4000-8000-00000000ad01";
const STRANGER_ID = "00000000-0000-4000-8000-00000000ad02";

beforeAll(async () => {
  const [chipPet] = await db
    .insert(pets)
    .values({
      publicToken: `TEST-IDH-${Date.now()}-A`,
      name: "Identifiers Helper Test A",
      species: "dog",
      sex: "male",
      status: "active",
    })
    .returning({ id: pets.id });
  const [barePet] = await db
    .insert(pets)
    .values({
      publicToken: `TEST-IDH-${Date.now()}-B`,
      name: "Identifiers Helper Test B",
      species: "cat",
      sex: "female",
      status: "active",
    })
    .returning({ id: pets.id });
  seedPetIds.push(chipPet.id, barePet.id);

  await db.insert(petIdentifications).values([
    {
      petId: chipPet.id,
      kind: "microchip_iso",
      code: CHIP_CODE,
      recordedAt: new Date().toISOString().slice(0, 10),
      isoCountryCode: CHIP_CODE.slice(0, 3),
      isoManufacturerCode: CHIP_CODE.slice(3, 7),
      isoNationalId: CHIP_CODE.slice(7, 15),
      isoCompliant: true,
    },
    {
      petId: chipPet.id,
      kind: "tattoo",
      code: TATTOO_CODE,
      recordedAt: new Date().toISOString().slice(0, 10),
      tattooLocation: "inner_ear_left",
    },
  ]);

  // Both seed pets belong to OWNER_ID. STRANGER_ID owns nothing — that
  // asymmetry is what the chip-scoping tests below assert on.
  await db
    .insert(profiles)
    .values([
      { id: OWNER_ID, displayName: "Owner ARCH-Q" },
      { id: STRANGER_ID, displayName: "Stranger ARCH-Q" },
    ])
    .onConflictDoNothing({ target: profiles.id });

  await db.insert(ownerships).values(
    seedPetIds.map((petId) => ({
      petId,
      ownerUserId: OWNER_ID,
      role: "owner" as const,
    })),
  );
});

afterAll(async () => {
  if (seedPetIds.length > 0) {
    await db.delete(petIdentifications).where(inArray(petIdentifications.petId, seedPetIds));
    await db.delete(ownerships).where(inArray(ownerships.petId, seedPetIds));
    await db.delete(pets).where(inArray(pets.id, seedPetIds));
  }
  await db.delete(profiles).where(inArray(profiles.id, [OWNER_ID, STRANGER_ID]));
});

describe("fetchActiveIdentifications (single pet)", () => {
  it("returns the active chip and tattoo for a pet that has them", async () => {
    const result = await fetchActiveIdentifications(seedPetIds[0]);
    expect(result.microchip?.code).toBe(CHIP_CODE);
    expect(result.microchip?.isoCountryCode).toBe("858");
    expect(result.tattoo?.code).toBe(TATTOO_CODE);
    expect(result.tattoo?.tattooLocation).toBe("inner_ear_left");
  });

  it("returns empty identifications for a pet without any", async () => {
    const result = await fetchActiveIdentifications(seedPetIds[1]);
    expect(result.microchip).toBeNull();
    expect(result.tattoo).toBeNull();
  });
});

describe("batchFetchActiveIdentifications", () => {
  it("keys results by petId and omits identifier-less pets", async () => {
    const map = await batchFetchActiveIdentifications(seedPetIds);
    expect(map.get(seedPetIds[0])?.microchip?.code).toBe(CHIP_CODE);
    expect(map.has(seedPetIds[1])).toBe(false);
  });
});

describe("fetchComplianceStatesForPets microchip sourcing", () => {
  // Regression for the list-vs-profile mismatch: the list surface used to pass
  // microchipCode: null, so a pet with a declared chip read "Sin registro" on
  // /mis-mascotas while the profile said "Declarado". The list
  // now sources the code from batchFetchActiveIdentifications — same source the
  // profile header uses.
  //
  // The chip read is ALSO ownership-bound (2026-08-01 chip-read audit). This
  // suite used to pass a throwaway UUID and assert the code came back, pinning
  // the hole as if it were the contract: `userId` scoped only the reminder
  // lookup, so the function answered "give me the chip of any pet id" for any
  // caller. That is the shape of both microchip disclosures fixed on
  // 2026-07-31 — a caller-chosen pet id plus a guard that only proves identity.
  // The pair below now pins the binding instead of the hole.

  it("feeds the pet's active chip code into the list compliance state for its owner", async () => {
    const states = await fetchComplianceStatesForPets(OWNER_ID, seedPetIds);
    const chipCard = states.get(seedPetIds[0])?.cards.find((c) => c.key === "microchip");
    // These pets carry NO jurisdiction and no rule row resolves, so since RG2
    // (ratified 2026-08-16) the microchip is not an obligation here — but a
    // chip ON RECORD is information the credential still surfaces, as an
    // informational (not_regulated) card.
    expect(chipCard).toBeDefined();
    // Code known from identifications, no professional implant event → declared.
    expect(chipCard?.state).toBe("Declarado");
    expect(chipCard?.detail).toBe(CHIP_CODE);
  });

  it("withholds the chip code from a caller who owns none of the pets", async () => {
    const states = await fetchComplianceStatesForPets(STRANGER_ID, seedPetIds);
    const chipCard = states.get(seedPetIds[0])?.cards.find((c) => c.key === "microchip");
    // The PII fence degrades the read to "no chip on record" rather than
    // printing 15 digits the caller has no relationship to — and with no chip
    // visible and no rule row claiming the obligation (RG2, ratified
    // 2026-08-16), there is no microchip card at all for this caller.
    expect(chipCard).toBeUndefined();
    // Belt-and-braces: the code is nowhere in the serialized state.
    expect(JSON.stringify([...states.values()])).not.toContain(CHIP_CODE);
  });

  it("omits the microchip card for an owned pet without identifications — no rule row claims the obligation (RG2)", async () => {
    // Pre-RG2 this read "Sin registro" (assumed-mandatory default). Since the
    // ratified flip (2026-08-16), a jurisdiction with no microchip_required
    // rule row does not surface the obligation at all — the honest default.
    const states = await fetchComplianceStatesForPets(OWNER_ID, [seedPetIds[1]]);
    const chipCard = states.get(seedPetIds[1])?.cards.find((c) => c.key === "microchip");
    expect(chipCard).toBeUndefined();
  });
});

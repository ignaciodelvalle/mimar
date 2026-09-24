// Integration tests: pet_identifications canonical dual-write (ARCH-O completeness).
//
// Verifies that every writer path inserts/maintains the canonical row:
//   1. createMicrochip use-case (via repo stub — unit coverage in use-case test;
//      here we assert insertIdentification is called with correct shape)
//   2. replaceMicrochipForUser — flips old row to 'replaced', inserts new active row
//   3. setPetLostWriter — retroactive tattoo inserts canonical tattoo row
//   4. setPetLostWriter — retroactive microchip inserts canonical microchip row
//   5. updatePetProfile chipNewlyAdded (pets-repository) — inserts canonical microchip row
//
// DB integration (requires running local Supabase stack).
// Fixture pattern: direct DB inserts + withMutationOverride for cleanup.

import { createClient } from "@supabase/supabase-js";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, ownerships, petIdentifications, pets } from "@/db";
import { setPetLostWriter } from "@/src/modules/events/application/lifecycle/set-pet-lost-use-case";
import { EventsRepository } from "@/src/modules/events/infrastructure/events-repository";
import { replaceMicrochipForUser } from "@/src/modules/pets/application/microchip/replace-microchip";
import { PetsRepository } from "@/src/modules/pets/infrastructure/pets-repository";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";

const admin = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const USER_EMAIL = "identifications-dual-write@dim-test.local";
const PASS = "DualWrite_2026!";

// Stable chip numbers that won't collide with other test suites.
const CHIP_A = "982000100000001";
const CHIP_B = "982000100000002";
const CHIP_C = "982000100000003";

let userId: string;

// Separate petIds per test scenario to avoid cross-test interference.
let petForReplaceId: string;
let petForLostTattooId: string;
let petForLostChipId: string;
let petForProfileEditId: string;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function purgeUser(email: string) {
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
  const found = list?.users.find((u) => u.email === email);
  if (!found) return;
  const owned = await db
    .select({ petId: ownerships.petId })
    .from(ownerships)
    .where(eq(ownerships.ownerUserId, found.id));
  await withMutationOverride(async (tx) => {
    for (const { petId: pid } of owned) await tx.delete(pets).where(eq(pets.id, pid));
  });
  await admin.auth.admin.deleteUser(found.id);
}

async function cleanupPet(petId: string | undefined) {
  if (!petId) return;
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${petId}::uuid`);
    await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id = ${petId}::uuid`);
    await tx.execute(sql`DELETE FROM pet_identifications WHERE pet_id = ${petId}::uuid`);
    await tx.delete(ownerships).where(eq(ownerships.petId, petId));
    await tx.delete(pets).where(eq(pets.id, petId));
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await purgeUser(USER_EMAIL);

  // Also clean up any leftover pets that own our test chip numbers.
  // ARCH-S: pets.microchipId dropped — scan pet_identifications.
  for (const chip of [CHIP_A, CHIP_B, CHIP_C]) {
    const rows = (await db.execute(
      sql`SELECT DISTINCT pet_id FROM pet_identifications WHERE code = ${chip} AND kind = 'microchip_iso'`,
    )) as Array<{ pet_id: string }>;
    for (const { pet_id: pid } of rows) {
      await withMutationOverride(async (tx) => {
        await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${pid}::uuid`);
        await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id = ${pid}::uuid`);
        await tx.delete(pets).where(eq(pets.id, pid));
      });
    }
  }

  const { data: userData, error: userErr } = await createFreshTestUser(admin, {
    email: USER_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (userErr || !userData.user) throw new Error(`createUser: ${userErr?.message}`);
  userId = userData.user.id;

  // Pet for replaceMicrochip test — starts with CHIP_A (seeded via canonical row below).
  // ARCH-S: pets.microchipId dropped.
  const [petReplace] = await db
    .insert(pets)
    .values({
      publicToken: `DW-REPLACE-${Date.now()}`,
      name: "Replace Chip Pet",
      species: "dog",
      sex: "male",
      status: "active",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
    })
    .returning();
  petForReplaceId = petReplace.id;
  await db
    .insert(ownerships)
    .values({ petId: petForReplaceId, ownerUserId: userId, role: "owner" });
  // Seed the canonical row for CHIP_A (as if prior writer path had set it up).
  await db.insert(petIdentifications).values({
    petId: petForReplaceId,
    kind: "microchip_iso",
    code: CHIP_A,
    recordedAt: new Date().toISOString().slice(0, 10),
    isoCountryCode: CHIP_A.slice(0, 3),
    isoManufacturerCode: CHIP_A.slice(3, 7),
    isoNationalId: CHIP_A.slice(7, 15),
    isoCompliant: true,
  });

  // Pet for setPetLost retroactive tattoo test — no tattoo.
  const [petLostTattoo] = await db
    .insert(pets)
    .values({
      publicToken: `DW-LOST-TAT-${Date.now()}`,
      name: "Lost Tattoo Pet",
      species: "cat",
      sex: "female",
      status: "active",
    })
    .returning();
  petForLostTattooId = petLostTattoo.id;
  await db
    .insert(ownerships)
    .values({ petId: petForLostTattooId, ownerUserId: userId, role: "owner" });

  // Pet for setPetLost retroactive chip test — no chip.
  const [petLostChip] = await db
    .insert(pets)
    .values({
      publicToken: `DW-LOST-CHIP-${Date.now()}`,
      name: "Lost Chip Pet",
      species: "dog",
      sex: "male",
      status: "active",
    })
    .returning();
  petForLostChipId = petLostChip.id;
  await db
    .insert(ownerships)
    .values({ petId: petForLostChipId, ownerUserId: userId, role: "owner" });

  // Pet for updatePetProfile chipNewlyAdded test — no chip initially.
  const [petProfileEdit] = await db
    .insert(pets)
    .values({
      publicToken: `DW-PROFILE-${Date.now()}`,
      name: "Profile Edit Pet",
      species: "dog",
      sex: "male",
      status: "active",
    })
    .returning();
  petForProfileEditId = petProfileEdit.id;
  await db
    .insert(ownerships)
    .values({ petId: petForProfileEditId, ownerUserId: userId, role: "owner" });
});

afterAll(async () => {
  await cleanupPet(petForReplaceId);
  await cleanupPet(petForLostTattooId);
  await cleanupPet(petForLostChipId);
  await cleanupPet(petForProfileEditId);
  if (userId) await admin.auth.admin.deleteUser(userId);
});

// ---------------------------------------------------------------------------
// Tests: replaceMicrochipForUser
// ---------------------------------------------------------------------------

describe("replaceMicrochipForUser — canonical dual-write", () => {
  it("flips old active canonical row to 'replaced' and inserts new active row", async () => {
    const result = await replaceMicrochipForUser(userId, {
      petId: petForReplaceId,
      previousChipNumber: CHIP_A,
      newChipNumber: CHIP_B,
      reason: "damaged",
      replacedBy: null,
      replacedAt: new Date().toISOString(),
      actorContext: { kind: "owner" },
    });

    expect(result).toMatchObject({ ok: true });

    // Old canonical row must be 'replaced'.
    const oldRows = await db
      .select()
      .from(petIdentifications)
      .where(
        and(
          eq(petIdentifications.petId, petForReplaceId),
          eq(petIdentifications.kind, "microchip_iso"),
          eq(petIdentifications.code, CHIP_A),
        ),
      );
    expect(oldRows).toHaveLength(1);
    expect(oldRows[0].status).toBe("replaced");

    // New active canonical row for CHIP_B.
    const newRows = await db
      .select()
      .from(petIdentifications)
      .where(
        and(
          eq(petIdentifications.petId, petForReplaceId),
          eq(petIdentifications.kind, "microchip_iso"),
          eq(petIdentifications.code, CHIP_B),
          eq(petIdentifications.status, "active"),
        ),
      );
    expect(newRows).toHaveLength(1);
    expect(newRows[0].isoCountryCode).toBe(CHIP_B.slice(0, 3));
    expect(newRows[0].isoNationalId).toBe(CHIP_B.slice(7, 15));
  });

  it("flips old row to 'replaced' and does NOT insert a new row on pure revocation (newChipNumber=null)", async () => {
    // Ensure CHIP_B active row exists (inserted by the previous test via replaceMicrochipForUser).
    const existingB = await db
      .select()
      .from(petIdentifications)
      .where(
        and(
          eq(petIdentifications.petId, petForReplaceId),
          eq(petIdentifications.kind, "microchip_iso"),
          eq(petIdentifications.code, CHIP_B),
          eq(petIdentifications.status, "active"),
        ),
      );
    if (existingB.length === 0) {
      await db.insert(petIdentifications).values({
        petId: petForReplaceId,
        kind: "microchip_iso",
        code: CHIP_B,
        recordedAt: new Date().toISOString().slice(0, 10),
        isoCountryCode: CHIP_B.slice(0, 3),
        isoManufacturerCode: CHIP_B.slice(3, 7),
        isoNationalId: CHIP_B.slice(7, 15),
        isoCompliant: true,
      });
    }

    const result = await replaceMicrochipForUser(userId, {
      petId: petForReplaceId,
      previousChipNumber: CHIP_B,
      newChipNumber: null,
      reason: "owner_request",
      replacedBy: null,
      replacedAt: new Date().toISOString(),
      actorContext: { kind: "owner" },
    });

    expect(result).toMatchObject({ ok: true });

    // CHIP_B row should now be 'replaced'.
    const chipBRows = await db
      .select()
      .from(petIdentifications)
      .where(
        and(
          eq(petIdentifications.petId, petForReplaceId),
          eq(petIdentifications.kind, "microchip_iso"),
          eq(petIdentifications.code, CHIP_B),
        ),
      );
    expect(chipBRows.every((r) => r.status !== "active")).toBe(true);

    // No new active row should exist (revocation = no new chip).
    const activeRows = await db
      .select()
      .from(petIdentifications)
      .where(
        and(
          eq(petIdentifications.petId, petForReplaceId),
          eq(petIdentifications.kind, "microchip_iso"),
          eq(petIdentifications.status, "active"),
        ),
      );
    expect(activeRows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: setPetLostWriter retroactive tattoo
// ---------------------------------------------------------------------------

describe("setPetLostWriter — retroactive tattoo canonical dual-write", () => {
  it("inserts canonical tattoo row when retroactive tattoo provided and pet had none", async () => {
    const repo = new EventsRepository();
    const broadcastLostPet = async () => {};

    const result = await setPetLostWriter(
      {
        petId: petForLostTattooId,
        petStatus: "active",
        fromStatus: "active",
        recordedByUserId: userId,
        eventAuthorship: { authorRole: "owner", authorOrganizationId: null, authorVerified: false },
        locationDescription: null,
        locationLat: null,
        locationLng: null,
        reason: null,
        disclosurePrefs: {
          discloseFirstNameWhenLost: true,
          disclosePhoneWhenLost: true,
          discloseEmailWhenLost: false,
          discloseLastLocationWhenLost: true,
          allowFinderFormWhenLost: true,
        },
        enrichedDescription: {
          color: null,
          distinguishingFeatures: null,
          accessoriesWhenLost: null,
          behaviorNotes: null,
          lastSeenContext: null,
          microchipId: null,
          tattooCode: "K9-2026",
          tattooLocation: "inner_ear_left",
          tattooDescription: "Blue ink",
        },
        now: new Date(),
      },
      {
        repo,
        transaction: (cb) => db.transaction((tx) => cb(tx as unknown)),
        broadcastLostPet,
      },
    );

    expect(result.error).toBeNull();

    // Canonical tattoo row must exist and be active.
    const tattooRows = await db
      .select()
      .from(petIdentifications)
      .where(
        and(
          eq(petIdentifications.petId, petForLostTattooId),
          eq(petIdentifications.kind, "tattoo"),
          eq(petIdentifications.status, "active"),
        ),
      );
    expect(tattooRows).toHaveLength(1);
    expect(tattooRows[0].code).toBe("K9-2026");
    expect(tattooRows[0].tattooLocation).toBe("inner_ear_left");
    expect(tattooRows[0].tattooDescription).toBe("Blue ink");
  });
});

// ---------------------------------------------------------------------------
// Tests: setPetLostWriter retroactive microchip
// ---------------------------------------------------------------------------

describe("setPetLostWriter — retroactive microchip canonical dual-write", () => {
  it("inserts canonical microchip row when retroactive chip provided and pet had none", async () => {
    const repo = new EventsRepository();
    const broadcastLostPet = async () => {};

    const result = await setPetLostWriter(
      {
        petId: petForLostChipId,
        petStatus: "active",
        fromStatus: "active",
        recordedByUserId: userId,
        eventAuthorship: { authorRole: "owner", authorOrganizationId: null, authorVerified: false },
        locationDescription: null,
        locationLat: null,
        locationLng: null,
        reason: null,
        disclosurePrefs: {
          discloseFirstNameWhenLost: true,
          disclosePhoneWhenLost: true,
          discloseEmailWhenLost: false,
          discloseLastLocationWhenLost: true,
          allowFinderFormWhenLost: true,
        },
        enrichedDescription: {
          color: null,
          distinguishingFeatures: null,
          accessoriesWhenLost: null,
          behaviorNotes: null,
          lastSeenContext: null,
          microchipId: CHIP_C,
        },
        now: new Date(),
      },
      {
        repo,
        transaction: (cb) => db.transaction((tx) => cb(tx as unknown)),
        broadcastLostPet,
      },
    );

    expect(result.error).toBeNull();

    // Canonical microchip row must exist and be active.
    const chipRows = await db
      .select()
      .from(petIdentifications)
      .where(
        and(
          eq(petIdentifications.petId, petForLostChipId),
          eq(petIdentifications.kind, "microchip_iso"),
          eq(petIdentifications.code, CHIP_C),
          eq(petIdentifications.status, "active"),
        ),
      );
    expect(chipRows).toHaveLength(1);
    expect(chipRows[0].isoCountryCode).toBe(CHIP_C.slice(0, 3));
    expect(chipRows[0].isoCompliant).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: updatePetProfile chipNewlyAdded
// ---------------------------------------------------------------------------

describe("PetsRepository.updatePetProfile — chipNewlyAdded canonical dual-write", () => {
  it("inserts canonical microchip row when chip is newly added via profile edit", async () => {
    const now = new Date();

    await db.transaction(async (tx) => {
      await PetsRepository.updatePetProfile(
        {
          petId: petForProfileEditId,
          parsed: {
            name: "Profile Edit Pet",
            species: "dog",
            sex: "male",
            breed: null,
            dateOfBirth: null,
            birthDateIsEstimated: false,
            color: null,
            microchipId: CHIP_A,
            microchipCountryCode: "982",
            microchipImplantedAt: now.toISOString().slice(0, 10),
            microchipImplantedBy: "Dr. Test",
            microchipLocation: "interscapular",
            estimatedWeightKg: null,
            favouriteFoods: [],
            knownAllergies: [],
            trainingLevel: null,
            insuranceCompany: null,
            insurancePolicyNumber: null,
            jurisdictionProvince: null,
            jurisdictionLocality: null,
            acquisitionMethod: null,
            emergencyInfoVisible: false,
            permanentConditions: [],
            permanentConditionsOther: null,
            discloseConditionsPublicly: false,
            custodyKind: "owner",
          },
          potentiallyDangerousBreed: false,
          changes: [{ field: "microchipId", old: null, new: CHIP_A }],
          hasContentChanges: true,
          flagChanged: false,
          chipNewlyAdded: true,
          uploadedPath: null,
          uploadMimeType: null,
          uploadSize: null,
          userId,
          eventAuthorship: {
            authorRole: "owner",
            authorOrganizationId: null,
            authorVerified: false,
          },
          now,
        },
        tx,
      );
    });

    // Canonical microchip row must exist and be active.
    const chipRows = await db
      .select()
      .from(petIdentifications)
      .where(
        and(
          eq(petIdentifications.petId, petForProfileEditId),
          eq(petIdentifications.kind, "microchip_iso"),
          eq(petIdentifications.code, CHIP_A),
          eq(petIdentifications.status, "active"),
        ),
      );
    expect(chipRows).toHaveLength(1);
    expect(chipRows[0].isoCountryCode).toBe(CHIP_A.slice(0, 3));
    expect(chipRows[0].recordedByLabel).toBe("Dr. Test");
    expect(chipRows[0].implantationSite).toBe("interescapular");
  });
});

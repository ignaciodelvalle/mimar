// Integration tests for PetsRepository.
// Written FIRST (RED phase, task 2.1) before creating pets-repository.ts.
//
// These tests run against a local Postgres instance (vitest.config.ts → setup.ts
// forces the connection to 127.0.0.1:54322). They follow the same fixture
// pattern used by adoption-repository.test.ts.
//
// Tests cover:
//   - insertPetRegistered: composite write (pet+ownership+event+chip event+petIdentifications)
//   - insertPetRegistered: rollback on failure (atomicity)
//   - updatePetProfile: row+event on content change
//   - updatePetProfile: flag-only (no event emitted)
//   - updatePetProfile: chipNewlyAdded (microchip_implanted event)
//   - generatePublicToken: returns a DIM-XXXX-XXXX shaped token

import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hashDni } from "@/lib/utils/dni-hash";

import { attachments, db, ownerships, petEvents, petIdentifications, pets, profiles } from "@/db";
import { withMutationOverride } from "../../../../../__tests__/_helpers/db-overrides";

// Module under test — will be created in GREEN phase (task 2.2).
import { PetsRepository } from "../pets-repository";

// ---------------------------------------------------------------------------
// Fixture constants
// ---------------------------------------------------------------------------

const USER_TOKEN = "DIMTEST-PETS-REPO-USER";
const PET_TOKEN_1 = "DIMTEST-PETS-REPO-P1";
const PET_TOKEN_2 = "DIMTEST-PETS-REPO-P2";

let userId: string;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParsedBase(overrides: Record<string, unknown> = {}) {
  return {
    name: "TestPet",
    species: "dog",
    sex: "male" as const,
    breed: "labrador",
    dateOfBirth: "2021-06-01",
    birthDateIsEstimated: false,
    color: "yellow",
    microchipId: null,
    microchipCountryCode: null,
    microchipImplantedAt: null,
    microchipImplantedBy: null,
    microchipLocation: null,
    estimatedWeightKg: "25",
    favouriteFoods: ["chicken"],
    knownAllergies: [],
    trainingLevel: null,
    insuranceCompany: null,
    insurancePolicyNumber: null,
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "La Plata",
    acquisitionMethod: "adopted" as const,
    emergencyInfoVisible: false,
    permanentConditions: [],
    permanentConditionsOther: null,
    discloseConditionsPublicly: false,
    custodyKind: "owner" as const,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Insert a stub profile for the test user.
  const existingProfile = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.displayName, USER_TOKEN))
    .limit(1);

  if (existingProfile[0]) {
    userId = existingProfile[0].id;
  } else {
    userId = crypto.randomUUID();
    await db.insert(profiles).values({
      id: userId,
      displayName: USER_TOKEN,
      dniHash: hashDni(`9${Math.floor(Math.random() * 9000000 + 1000000)}`),
      dniVerified: false,
      role: "owner",
    });
  }

  // Clean up any stale fixture pets.
  await withMutationOverride(async (tx) => {
    for (const token of [PET_TOKEN_1, PET_TOKEN_2]) {
      const stale = await tx.select({ id: pets.id }).from(pets).where(eq(pets.publicToken, token));
      for (const { id } of stale) {
        await tx.delete(pets).where(eq(pets.id, id));
      }
    }
  });
});

afterAll(async () => {
  // Clean up all pets created by this suite (cascades into events, ownerships, etc.).
  await withMutationOverride(async (tx) => {
    for (const token of [PET_TOKEN_1, PET_TOKEN_2]) {
      const rows = await tx.select({ id: pets.id }).from(pets).where(eq(pets.publicToken, token));
      for (const { id } of rows) {
        await tx.delete(pets).where(eq(pets.id, id));
      }
    }
  });
  // Clean up stub profile.
  await db.delete(profiles).where(eq(profiles.displayName, USER_TOKEN));
});

// ---------------------------------------------------------------------------
// generatePublicToken
// ---------------------------------------------------------------------------

describe("PetsRepository.generatePublicToken", () => {
  it("returns a DIM-XXXX-XXXX shaped token", async () => {
    const token = await PetsRepository.generatePublicToken();
    expect(token).toMatch(/^DIM-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it("returns different tokens on consecutive calls", async () => {
    const a = await PetsRepository.generatePublicToken();
    const b = await PetsRepository.generatePublicToken();
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// insertPetRegistered — composite write
// ---------------------------------------------------------------------------

describe("PetsRepository.insertPetRegistered — no chip", () => {
  let petId: string;
  let eventId: string;

  it("inserts pet row, ownership, and pet_registered event in one tx", async () => {
    const parsed = makeParsedBase();
    const now = new Date();

    const result = await db.transaction(async (tx) => {
      return PetsRepository.insertPetRegistered(
        {
          publicToken: PET_TOKEN_1,
          parsed,
          potentiallyDangerousBreed: false,
          uploadedPath: null,
          uploadMimeType: null,
          uploadSize: null,
          userId,
          now,
        },
        tx,
      );
    });

    petId = result.petId;
    eventId = result.eventId;

    expect(petId).toBeTruthy();
    expect(eventId).toBeTruthy();

    // Verify pet row exists.
    const [pet] = await db.select().from(pets).where(eq(pets.id, petId));
    expect(pet).toBeDefined();
    expect(pet.name).toBe("TestPet");
    expect(pet.publicToken).toBe(PET_TOKEN_1);

    // Verify ownership row.
    const [ownership] = await db
      .select()
      .from(ownerships)
      .where(and(eq(ownerships.petId, petId), isNull(ownerships.endedAt)));
    expect(ownership).toBeDefined();
    expect(ownership.role).toBe("owner");
    expect(ownership.ownerUserId).toBe(userId);

    // Verify pet_registered event.
    const [event] = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "pet_registered")));
    expect(event).toBeDefined();
    expect(event.id).toBe(eventId);
  });

  it("sets ownership role to shelter_custody for foster_in_transit custody", async () => {
    const parsed = makeParsedBase({ custodyKind: "foster_in_transit" });
    const now = new Date();

    // Use PET_TOKEN_2 for this sub-test variant.
    const result = await db.transaction(async (tx) => {
      return PetsRepository.insertPetRegistered(
        {
          publicToken: PET_TOKEN_2,
          parsed,
          potentiallyDangerousBreed: false,
          uploadedPath: null,
          uploadMimeType: null,
          uploadSize: null,
          userId,
          now,
        },
        tx,
      );
    });

    const [ownership] = await db
      .select()
      .from(ownerships)
      .where(and(eq(ownerships.petId, result.petId), isNull(ownerships.endedAt)));
    expect(ownership.role).toBe("shelter_custody");

    // Clean up PET_TOKEN_2 pet right away to avoid collision in later tests.
    await withMutationOverride(async (tx) => {
      await tx.delete(pets).where(eq(pets.id, result.petId));
    });
  });

  it("inserts microchip_implanted event and petIdentifications row when chip is set", async () => {
    // Re-use the first pet (clean it first, then re-insert with chip).
    await withMutationOverride(async (tx) => {
      await tx.delete(pets).where(eq(pets.id, petId));
    });

    const parsed = makeParsedBase({
      microchipId: "982000411234567",
      microchipCountryCode: "076",
      microchipLocation: "interscapular_left",
    });
    const now = new Date();

    const result = await db.transaction(async (tx) => {
      return PetsRepository.insertPetRegistered(
        {
          publicToken: PET_TOKEN_1,
          parsed,
          potentiallyDangerousBreed: false,
          uploadedPath: null,
          uploadMimeType: null,
          uploadSize: null,
          userId,
          now,
        },
        tx,
      );
    });
    petId = result.petId;

    // microchip_implanted event.
    const chipEvents = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "microchip_implanted")));
    expect(chipEvents.length).toBe(1);

    // petIdentifications double-write.
    const [ident] = await db
      .select()
      .from(petIdentifications)
      .where(eq(petIdentifications.petId, petId));
    expect(ident).toBeDefined();
    expect(ident.code).toBe("982000411234567");
    expect(ident.kind).toBe("microchip_iso");
    expect(ident.implantationSite).toBe("interescapular"); // mapped by chipImplantSiteFromLocation
  });

  it("inserts attachment and updates primaryPhotoId when uploadedPath is set", async () => {
    await withMutationOverride(async (tx) => {
      await tx.delete(pets).where(eq(pets.id, petId));
    });

    const parsed = makeParsedBase();
    const now = new Date();

    const result = await db.transaction(async (tx) => {
      return PetsRepository.insertPetRegistered(
        {
          publicToken: PET_TOKEN_1,
          parsed,
          potentiallyDangerousBreed: false,
          uploadedPath: "pet-photos/test-photo.jpg",
          uploadMimeType: "image/jpeg",
          uploadSize: 12345,
          userId,
          now,
        },
        tx,
      );
    });
    petId = result.petId;

    const [pet] = await db.select().from(pets).where(eq(pets.id, petId));
    expect(pet.primaryPhotoId).not.toBeNull();

    const [att] = await db.select().from(attachments).where(eq(attachments.petId, petId));
    expect(att).toBeDefined();
    expect(att.storagePath).toBe("pet-photos/test-photo.jpg");
  });
});

describe("PetsRepository.insertPetRegistered — atomicity", () => {
  it("rolls back the entire insert when the tx is aborted", async () => {
    const parsed = makeParsedBase({ name: "RollbackPet" });
    const now = new Date();
    const rollbackToken = "DIMTEST-ROLLBACK-TEST";

    let threwError = false;
    try {
      await db.transaction(async (tx) => {
        await PetsRepository.insertPetRegistered(
          {
            publicToken: rollbackToken,
            parsed,
            potentiallyDangerousBreed: false,
            uploadedPath: null,
            uploadMimeType: null,
            uploadSize: null,
            userId,
            now,
          },
          tx,
        );
        // Force tx rollback.
        throw new Error("forced rollback");
      });
    } catch {
      threwError = true;
    }

    expect(threwError).toBe(true);

    // Pet must NOT exist.
    const rows = await db.select().from(pets).where(eq(pets.publicToken, rollbackToken));
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// updatePetProfile
// ---------------------------------------------------------------------------

describe("PetsRepository.updatePetProfile", () => {
  let updatePetId: string;

  beforeAll(async () => {
    // Insert a base pet for update tests.
    const parsed = makeParsedBase({ name: "UpdateTestPet" });
    const now = new Date();

    // Clean up any stale fixture.
    await withMutationOverride(async (tx) => {
      const stale = await tx
        .select({ id: pets.id })
        .from(pets)
        .where(eq(pets.publicToken, PET_TOKEN_2));
      for (const { id } of stale) await tx.delete(pets).where(eq(pets.id, id));
    });

    const result = await db.transaction(async (tx) => {
      return PetsRepository.insertPetRegistered(
        {
          publicToken: PET_TOKEN_2,
          parsed,
          potentiallyDangerousBreed: false,
          uploadedPath: null,
          uploadMimeType: null,
          uploadSize: null,
          userId,
          now,
        },
        tx,
      );
    });
    updatePetId = result.petId;
  });

  afterAll(async () => {
    if (updatePetId) {
      await withMutationOverride(async (tx) => {
        await tx.delete(pets).where(eq(pets.id, updatePetId));
      });
    }
  });

  it("updates the pet row and emits pet_profile_updated when content changes", async () => {
    const parsed = makeParsedBase({ name: "UpdatedName" });
    const now = new Date();

    const result = await db.transaction(async (tx) => {
      return PetsRepository.updatePetProfile(
        {
          petId: updatePetId,
          parsed,
          potentiallyDangerousBreed: false,
          changes: [{ field: "name", old: "UpdateTestPet", new: "UpdatedName" }],
          hasContentChanges: true,
          flagChanged: false,
          chipNewlyAdded: false,
          uploadedPath: null,
          uploadMimeType: null,
          uploadSize: null,
          userId,
          eventAuthorship: {
            authorRole: "owner" as const,
            authorOrganizationId: null,
            authorVerified: false,
          },
          now,
        },
        tx,
      );
    });

    expect(result.eventId).not.toBeNull();

    // Verify pet row updated.
    const [pet] = await db.select().from(pets).where(eq(pets.id, updatePetId));
    expect(pet.name).toBe("UpdatedName");

    // Verify pet_profile_updated event.
    const events = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, updatePetId), eq(petEvents.eventType, "pet_profile_updated")));
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT emit pet_profile_updated on flag-only change", async () => {
    const parsed = makeParsedBase({ name: "UpdatedName", emergencyInfoVisible: true });
    const now = new Date();

    const countBefore = (
      await db
        .select()
        .from(petEvents)
        .where(
          and(eq(petEvents.petId, updatePetId), eq(petEvents.eventType, "pet_profile_updated")),
        )
    ).length;

    await db.transaction(async (tx) => {
      return PetsRepository.updatePetProfile(
        {
          petId: updatePetId,
          parsed,
          potentiallyDangerousBreed: false,
          changes: [],
          hasContentChanges: false,
          flagChanged: true,
          chipNewlyAdded: false,
          uploadedPath: null,
          uploadMimeType: null,
          uploadSize: null,
          userId,
          eventAuthorship: {
            authorRole: "owner" as const,
            authorOrganizationId: null,
            authorVerified: false,
          },
          now,
        },
        tx,
      );
    });

    const countAfter = (
      await db
        .select()
        .from(petEvents)
        .where(
          and(eq(petEvents.petId, updatePetId), eq(petEvents.eventType, "pet_profile_updated")),
        )
    ).length;

    // No new event should have been emitted.
    expect(countAfter).toBe(countBefore);
  });

  it("FULL-LOCK: never mutates species / jurisdiction even when parsed differs", async () => {
    // Snapshot the locked columns before the update.
    const [before] = await db
      .select({
        species: pets.species,
        province: pets.jurisdictionProvince,
        locality: pets.jurisdictionLocality,
      })
      .from(pets)
      .where(eq(pets.id, updatePetId));

    // parsed carries a DIFFERENT species + jurisdiction — the writer must ignore
    // them (profile-edit path can never change locked fields, PO decision #40).
    const parsed = makeParsedBase({
      name: "LockProbe",
      species: "cat",
      jurisdictionProvince: "CABA",
      jurisdictionLocality: "Palermo",
    });
    const now = new Date();

    await db.transaction(async (tx) => {
      return PetsRepository.updatePetProfile(
        {
          petId: updatePetId,
          parsed,
          potentiallyDangerousBreed: false,
          changes: [{ field: "name", old: "UpdatedName", new: "LockProbe" }],
          hasContentChanges: true,
          flagChanged: false,
          chipNewlyAdded: false,
          uploadedPath: null,
          uploadMimeType: null,
          uploadSize: null,
          userId,
          eventAuthorship: {
            authorRole: "owner" as const,
            authorOrganizationId: null,
            authorVerified: false,
          },
          now,
        },
        tx,
      );
    });

    const [after] = await db
      .select({
        name: pets.name,
        species: pets.species,
        province: pets.jurisdictionProvince,
        locality: pets.jurisdictionLocality,
      })
      .from(pets)
      .where(eq(pets.id, updatePetId));

    // Name (a mutable field) changed; the locked fields did NOT.
    expect(after.name).toBe("LockProbe");
    expect(after.species).toBe(before.species);
    expect(after.province).toBe(before.province);
    expect(after.locality).toBe(before.locality);
  });

  it("correctSpecies: emits pet_profile_updated with the species change and updates the column", async () => {
    const [before] = await db
      .select({ species: pets.species, breed: pets.breed })
      .from(pets)
      .where(eq(pets.id, updatePetId));
    const newSpecies = before.species === "cat" ? "dog" : "cat";
    const now = new Date();

    const result = await db.transaction(async (tx) => {
      return PetsRepository.correctSpecies(
        {
          petId: updatePetId,
          oldSpecies: before.species,
          newSpecies,
          oldBreed: before.breed,
          newBreed: before.breed,
          potentiallyDangerousBreed: false,
          userId,
          eventAuthorship: {
            authorRole: "owner" as const,
            authorOrganizationId: null,
            authorVerified: false,
          },
          now,
        },
        tx,
      );
    });

    expect(result.eventId).toBeTruthy();

    // Column updated.
    const [after] = await db
      .select({ species: pets.species })
      .from(pets)
      .where(eq(pets.id, updatePetId));
    expect(after.species).toBe(newSpecies);

    // Event emitted carrying the single species change (audit trail).
    const [event] = await db.select().from(petEvents).where(eq(petEvents.id, result.eventId));
    expect(event.eventType).toBe("pet_profile_updated");
    const changes = (event.payload as { changes: { field: string; old: unknown; new: unknown }[] })
      .changes;
    expect(changes).toEqual([{ field: "species", old: before.species, new: newSpecies }]);
  });

  it("correctSpecies: carries the potentially_dangerous_breed change when the flag flips", async () => {
    // Baseline: this pet's PPP flag is false. A species correction that also
    // flips PPP to true must record BOTH changes so the correction is fully
    // event-derivable (F5 — the dual-written flag needs its paired fact).
    const [before] = await db
      .select({ species: pets.species, breed: pets.breed, ppp: pets.potentiallyDangerousBreed })
      .from(pets)
      .where(eq(pets.id, updatePetId));
    const newSpecies = before.species === "cat" ? "dog" : "cat";
    const now = new Date();

    const result = await db.transaction(async (tx) => {
      return PetsRepository.correctSpecies(
        {
          petId: updatePetId,
          oldSpecies: before.species,
          newSpecies,
          oldBreed: before.breed,
          newBreed: before.breed,
          potentiallyDangerousBreed: true,
          userId,
          eventAuthorship: {
            authorRole: "owner" as const,
            authorOrganizationId: null,
            authorVerified: false,
          },
          now,
        },
        tx,
      );
    });

    const [event] = await db.select().from(petEvents).where(eq(petEvents.id, result.eventId));
    const changes = (event.payload as { changes: { field: string; old: unknown; new: unknown }[] })
      .changes;
    expect(changes).toEqual([
      { field: "species", old: before.species, new: newSpecies },
      { field: "potentially_dangerous_breed", old: before.ppp ?? false, new: true },
    ]);

    // Column dual-written to match.
    const [after] = await db
      .select({ ppp: pets.potentiallyDangerousBreed })
      .from(pets)
      .where(eq(pets.id, updatePetId));
    expect(after.ppp).toBe(true);
  });

  it("correctSpecies: clears a breed that does not resolve in the NEW species' catalog and records the change", async () => {
    // Arrange: a dog with a dog-only breed. actions.ts resolves the breed
    // against the NEW catalog and passes newBreed: null when it doesn't
    // survive; the repository must dual-write the clear AND carry it in the
    // event (adversarial review 2026-08-14 — the grandfather rule otherwise
    // preserved the cross-species label forever).
    await db
      .update(pets)
      .set({ species: "dog", breed: "Labrador", potentiallyDangerousBreed: false })
      .where(eq(pets.id, updatePetId));
    const now = new Date();

    const result = await db.transaction(async (tx) => {
      return PetsRepository.correctSpecies(
        {
          petId: updatePetId,
          oldSpecies: "dog",
          newSpecies: "cat",
          oldBreed: "Labrador",
          newBreed: null, // "Labrador" does not resolve in the cat catalog
          potentiallyDangerousBreed: false,
          userId,
          eventAuthorship: {
            authorRole: "owner" as const,
            authorOrganizationId: null,
            authorVerified: false,
          },
          now,
        },
        tx,
      );
    });

    const [after] = await db
      .select({ species: pets.species, breed: pets.breed })
      .from(pets)
      .where(eq(pets.id, updatePetId));
    expect(after.species).toBe("cat");
    expect(after.breed).toBeNull();

    const [event] = await db.select().from(petEvents).where(eq(petEvents.id, result.eventId));
    const changes = (event.payload as { changes: { field: string; old: unknown; new: unknown }[] })
      .changes;
    expect(changes).toEqual([
      { field: "species", old: "dog", new: "cat" },
      { field: "breed", old: "Labrador", new: null },
    ]);
  });

  it("emits microchip_implanted event when chipNewlyAdded=true", async () => {
    const parsed = makeParsedBase({
      name: "UpdatedName",
      microchipId: "982000411234568",
      microchipCountryCode: "076",
    });
    const now = new Date();

    const result = await db.transaction(async (tx) => {
      return PetsRepository.updatePetProfile(
        {
          petId: updatePetId,
          parsed,
          potentiallyDangerousBreed: false,
          changes: [{ field: "microchip_id", old: null, new: "982000411234568" }],
          hasContentChanges: true,
          flagChanged: false,
          chipNewlyAdded: true,
          uploadedPath: null,
          uploadMimeType: null,
          uploadSize: null,
          userId,
          eventAuthorship: {
            authorRole: "owner" as const,
            authorOrganizationId: null,
            authorVerified: false,
          },
          now,
        },
        tx,
      );
    });

    expect(result.eventId).not.toBeNull();

    // Verify microchip_implanted event was emitted.
    const chipEvents = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, updatePetId), eq(petEvents.eventType, "microchip_implanted")));
    expect(chipEvents.length).toBeGreaterThanOrEqual(1);
  });
});

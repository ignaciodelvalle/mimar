// Integration tests for AdoptionRepository.
// Written FIRST (RED phase, task 2.10) before creating adoption-repository.ts.
//
// These tests run against a local Postgres instance (vitest.config.ts → setup.ts
// forces the connection to 127.0.0.1:54322). They follow the same fixture
// pattern used by __tests__/adoption-listing.test.ts and similar suites.

import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hashDni } from "@/lib/utils/dni-hash";

import {
  attachments,
  cases,
  db,
  organizations,
  ownerships,
  petEvents,
  pets,
  profiles,
  reminders,
} from "@/db";
import { withMutationOverride } from "../../../../../__tests__/_helpers/db-overrides";
import { expectDbError } from "../../../../../__tests__/_helpers/expect-db-error";

// Module under test — will be created in GREEN phase (task 2.11).
import { AdoptionRepository } from "../adoption-repository";

// ---------------------------------------------------------------------------
// Fixture constants
// ---------------------------------------------------------------------------

const ORG_TOKEN = "DIM-ADOPTREP-TEST";
const PET_TOKEN_1 = "DIM-ADOPTREP-P1";
const PET_TOKEN_2 = "DIM-ADOPTREP-P2";

let orgId: string;
let petId1: string;
let petId2: string;
let custodyOwnershipId1: string;
let actorUserId: string;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Insert a test-owned actor profile so FK columns don't depend on any seeded user.
  actorUserId = crypto.randomUUID();
  await db.insert(profiles).values({
    id: actorUserId,
    displayName: "AdoptionRepo Actor",
    dniHash: hashDni(`${Math.floor(Math.random() * 90000000 + 10000000)}`),
    dniVerified: false,
    role: "owner",
  });

  // Ensure clean slate (handles crashed previous runs).
  await withMutationOverride(async (tx) => {
    const stalePets = await tx
      .select({ id: pets.id })
      .from(pets)
      .where(eq(pets.publicToken, PET_TOKEN_1));
    for (const { id } of stalePets) {
      await tx.delete(pets).where(eq(pets.id, id));
    }
    const stalePets2 = await tx
      .select({ id: pets.id })
      .from(pets)
      .where(eq(pets.publicToken, PET_TOKEN_2));
    for (const { id } of stalePets2) {
      await tx.delete(pets).where(eq(pets.id, id));
    }
    const staleOrgs = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.publicToken, ORG_TOKEN));
    for (const { id } of staleOrgs) {
      await tx.delete(organizations).where(eq(organizations.id, id));
    }
  });

  // Insert org.
  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: ORG_TOKEN,
      legalName: "Adoption Repo Test Refugio SRL",
      displayName: "Repo Test Refugio",
      orgType: "shelter",
      email: "adoptrep-test@dim-test.local",
      verified: true,
    })
    .returning();
  orgId = org.id;

  // Insert pet 1 (eligible, in shelter custody).
  const [pet1] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN_1,
      name: "RepoTestPet1",
      species: "dog",
      sex: "male",
      potentiallyDangerousBreed: false,
      status: "active",
      adoptionEligible: true,
      adoptionEligibilitySetAt: new Date(),
    })
    .returning();
  petId1 = pet1.id;

  const [custody1] = await db
    .insert(ownerships)
    .values({
      petId: petId1,
      ownerOrganizationId: orgId,
      role: "shelter_custody",
    })
    .returning();
  custodyOwnershipId1 = custody1.id;

  // Insert pet 2 (no ownership row — not in any org).
  const [pet2] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN_2,
      name: "RepoTestPet2",
      species: "cat",
      sex: "female",
      potentiallyDangerousBreed: false,
      status: "active",
    })
    .returning();
  petId2 = pet2.id;
});

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    for (const id of [petId1, petId2].filter(Boolean)) {
      await tx.delete(pets).where(eq(pets.id, id));
    }
    if (orgId) await tx.delete(organizations).where(eq(organizations.id, orgId));
    if (actorUserId) await tx.delete(profiles).where(eq(profiles.id, actorUserId));
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AdoptionRepository.findShelterPet", () => {
  it("returns the pet row when it exists in the org's shelter_custody", async () => {
    const result = await AdoptionRepository.findShelterPet(PET_TOKEN_1, orgId);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(petId1);
  });

  it("returns null when the pet exists but is not under this org's custody", async () => {
    // Use a syntactically valid UUID that doesn't exist in the orgs table.
    const result = await AdoptionRepository.findShelterPet(
      PET_TOKEN_1,
      "00000000-0000-0000-0000-000000000000",
    );
    expect(result).toBeNull();
  });

  it("returns null when the token does not exist at all", async () => {
    const result = await AdoptionRepository.findShelterPet("NO-SUCH-TOKEN", orgId);
    expect(result).toBeNull();
  });

  it("also returns the custodyOwnershipId alongside the pet", async () => {
    const result = await AdoptionRepository.findShelterPet(PET_TOKEN_1, orgId);
    expect(result?.custodyOwnershipId).toBe(custodyOwnershipId1);
  });
});

describe("AdoptionRepository.findActiveFoster", () => {
  it("returns null when the pet has no active foster", async () => {
    const result = await AdoptionRepository.findActiveFoster(petId1);
    expect(result).toBeNull();
  });

  it("returns the foster row when one exists", async () => {
    // Insert a stub adopter profile for the foster
    const fosterProfileId = crypto.randomUUID();
    await db.insert(profiles).values({
      id: fosterProfileId,
      displayName: "FosterTestUser",
      dniHash: hashDni(`9${Math.floor(Math.random() * 9000000 + 1000000)}`),
      dniVerified: false,
      role: "owner",
    });

    const [fosterOwnership] = await db
      .insert(ownerships)
      .values({
        petId: petId1,
        ownerUserId: fosterProfileId,
        role: "foster",
      })
      .returning();

    const result = await AdoptionRepository.findActiveFoster(petId1);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(fosterOwnership.id);
    expect(result?.ownerUserId).toBe(fosterProfileId);

    // Cleanup
    await db.delete(ownerships).where(eq(ownerships.id, fosterOwnership.id));
    await db.delete(profiles).where(eq(profiles.id, fosterProfileId));
  });
});

describe("AdoptionRepository.setEligibility (with tx)", () => {
  it("updates the pet eligibility inside a transaction and rolls back on error", async () => {
    // Verify initial state.
    const [before] = await db
      .select({ adoptionEligible: pets.adoptionEligible })
      .from(pets)
      .where(eq(pets.id, petId1));
    expect(before.adoptionEligible).toBe(true);

    // Attempt an update inside a transaction that we intentionally roll back.
    await expect(
      db.transaction(async (tx) => {
        await AdoptionRepository.setEligibility(
          {
            petId: petId1,
            eligible: false,
            ineligibleReason: "medical_treatment",
            ineligibleReasonNotes: null,
            ineligibleUntil: null,
            now: new Date(),
            userId: actorUserId,
            orgId,
            orgVerified: true,
            previousState: null,
          },
          tx,
        );
        // Force rollback.
        throw new Error("intentional rollback");
      }),
    ).rejects.toThrow("intentional rollback");

    // Pet should still be eligible after rollback.
    const [after] = await db
      .select({ adoptionEligible: pets.adoptionEligible })
      .from(pets)
      .where(eq(pets.id, petId1));
    expect(after.adoptionEligible).toBe(true);
  });

  it("persists when the transaction commits", async () => {
    const now = new Date();

    await db.transaction(async (tx) => {
      await AdoptionRepository.setEligibility(
        {
          petId: petId1,
          eligible: false,
          ineligibleReason: "quarantine",
          ineligibleReasonNotes: null,
          ineligibleUntil: null,
          now,
          userId: actorUserId,
          orgId,
          orgVerified: true,
          previousState: null,
        },
        tx,
      );
    });

    const [updated] = await db
      .select({ adoptionEligible: pets.adoptionEligible, reason: pets.adoptionIneligibleReason })
      .from(pets)
      .where(eq(pets.id, petId1));
    expect(updated.adoptionEligible).toBe(false);
    expect(updated.reason).toBe("quarantine");

    // Restore to eligible so later tests aren't affected.
    await db
      .update(pets)
      .set({
        adoptionEligible: true,
        adoptionIneligibleReason: null,
        adoptionIneligibleReasonNotes: null,
        adoptionIneligibleUntil: null,
        adoptionEligibilitySetAt: new Date(),
      })
      .where(eq(pets.id, petId1));
  });
});

describe("AdoptionRepository.insertAdoptionFinalized — composite write atomicity", () => {
  it("rolls back all writes when an error occurs mid-transaction", async () => {
    const adopterProfileId = crypto.randomUUID();

    // Count events before.
    const [{ count: before }] = await db.execute<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM pet_events WHERE pet_id = '${petId1}'`,
    );

    await expect(
      db.transaction(async (tx) => {
        // Partially perform the finalization write, then error.
        await tx
          .update(ownerships)
          .set({ endedAt: new Date() })
          .where(eq(ownerships.id, custodyOwnershipId1));

        // Throw before the event is inserted — tx should roll back.
        throw new Error("simulated mid-tx failure");
      }),
    ).rejects.toThrow("simulated mid-tx failure");

    // The ownership row must still be open.
    const [ownership] = await db
      .select({ endedAt: ownerships.endedAt })
      .from(ownerships)
      .where(eq(ownerships.id, custodyOwnershipId1));
    expect(ownership.endedAt).toBeNull();

    // No extra events inserted.
    const [{ count: after }] = await db.execute<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM pet_events WHERE pet_id = '${petId1}'`,
    );
    expect(Number(after)).toBe(Number(before));
  });
});

// ---------------------------------------------------------------------------
// Parity regression tests (WU-5: W-1 attachment insert, W-2 reminder copy)
// ---------------------------------------------------------------------------
// These tests are WRITTEN FIRST (RED phase) to capture the two behavior regressions
// found by sdd-verify. They will fail until the implementation is corrected.
//
// IMPORTANT: Each test runs insertAdoptionFinalized inside a transaction it rolls
// back at the end, so petId1/custodyOwnershipId1 remain usable across tests.
// ---------------------------------------------------------------------------

// Seeded org display name matches the org inserted in beforeAll above.
const ORG_DISPLAY_NAME = "Repo Test Refugio";
// Pet name as inserted in beforeAll.
const PET_NAME = "RepoTestPet1";

type FinalizeTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Seeds the adopter's profile row.
 *
 * The repo does NOT create it: the stub-profile insert was removed once
 * finalize-adoption started refusing anything but a REGISTERED account, so the
 * new owner row's FK needs a profile that already exists. Callers seed it in
 * the SAME transaction, so a rolled-back fixture leaves nothing behind.
 */
async function seedAdopterProfile(tx: FinalizeTx, adopterUserId: string): Promise<void> {
  await tx.insert(profiles).values({
    id: adopterUserId,
    displayName: "Test Adoptante",
    dniHash: hashDni(`${Math.floor(Math.random() * 90000000 + 10000000)}`),
    dniVerified: false,
    role: "owner",
  });
}

/**
 * Builds a minimal valid InsertAdoptionFinalizedArgs for parity tests.
 * The caller passes the adopter id it has already seeded (seedAdopterProfile).
 */
function makeFinalizeArgs(
  adopterUserId: string,
  overrides: Record<string, unknown> = {},
): Parameters<typeof AdoptionRepository.insertAdoptionFinalized>[0] {
  return {
    petId: petId1,
    userId: actorUserId,
    orgId,
    orgVerified: true,
    custodyOwnershipId: custodyOwnershipId1,
    adopterUserId,
    fosterRow: null,
    fosterUserId: null,
    custodyCaseId: null,
    contractAttachmentId: null,
    contractStoragePath: null,
    contractMimeType: null,
    contractFileSize: null,
    followupMonths: null,
    notes: null,
    orgDisplayName: ORG_DISPLAY_NAME,
    petName: PET_NAME,
    now: new Date(),
    ...overrides,
  } as Parameters<typeof AdoptionRepository.insertAdoptionFinalized>[0];
}

describe("W-1 parity: insertAdoptionFinalized inserts attachments row inside tx", () => {
  it("inserts an attachments row with correct columns when contractAttachmentId is provided", async () => {
    // Arrange
    const contractAttachmentId = crypto.randomUUID();
    const storagePath = "event-attachments/test-contract.jpg";
    const mimeType = "image/jpeg";
    const fileSize = 102400;

    let insertedEventId: string | undefined;

    await db
      .transaction(async (tx) => {
        const adopterUserId = crypto.randomUUID();
        await seedAdopterProfile(tx, adopterUserId);
        const { eventId } = await AdoptionRepository.insertAdoptionFinalized(
          makeFinalizeArgs(adopterUserId, {
            contractAttachmentId,
            contractStoragePath: storagePath,
            contractMimeType: mimeType,
            contractFileSize: fileSize,
          }),
          tx,
        );
        insertedEventId = eventId;

        // Assert: the attachments row must exist INSIDE the tx.
        const rows = await tx
          .select({
            id: attachments.id,
            petId: attachments.petId,
            eventId: attachments.eventId,
            storagePath: attachments.storagePath,
            mimeType: attachments.mimeType,
            fileSize: attachments.fileSize,
          })
          .from(attachments)
          .where(eq(attachments.id, contractAttachmentId));

        expect(rows).toHaveLength(1);
        const row = rows[0];
        expect(row.id).toBe(contractAttachmentId);
        expect(row.petId).toBe(petId1);
        expect(row.eventId).toBe(insertedEventId);
        expect(row.storagePath).toBe(storagePath);
        expect(row.mimeType).toBe(mimeType);
        expect(row.fileSize).toBe(fileSize);

        // Roll back so petId1/custodyOwnershipId1 remain open for other tests.
        throw new Error("intentional rollback after assertion");
      })
      .catch((e) => {
        if ((e as Error).message !== "intentional rollback after assertion") throw e;
      });
  });

  it("does NOT insert an attachments row when contractAttachmentId is null", async () => {
    // Count attachments for pet before.
    const [{ count: before }] = await db.execute<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM attachments WHERE pet_id = '${petId1}'`,
    );

    await db
      .transaction(async (tx) => {
        const adopterUserId = crypto.randomUUID();
        await seedAdopterProfile(tx, adopterUserId);
        await AdoptionRepository.insertAdoptionFinalized(
          makeFinalizeArgs(adopterUserId, { contractAttachmentId: null }),
          tx,
        );
        throw new Error("intentional rollback");
      })
      .catch((e) => {
        if ((e as Error).message !== "intentional rollback") throw e;
      });

    const [{ count: after }] = await db.execute<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM attachments WHERE pet_id = '${petId1}'`,
    );
    expect(Number(after)).toBe(Number(before));
  });
});

describe("W-2 parity: reminder description uses org displayName and pet name", () => {
  it("formats reminder description as '{orgDisplayName} pidió un check-in sobre {petName}...'", async () => {
    let capturedDescription: string | undefined;

    // Use a fresh personal profile as adopter so the owner row FK is satisfied
    // and the account-type trigger doesn't block the insert. The profile is
    // created inside the transaction and rolled back at the end.
    const adopterUserId = crypto.randomUUID();

    await db
      .transaction(async (tx) => {
        await seedAdopterProfile(tx, adopterUserId);

        await AdoptionRepository.insertAdoptionFinalized(
          // Followup months set so the reminder rows are inserted.
          makeFinalizeArgs(adopterUserId, { followupMonths: 1 }),
          tx,
        );

        // Read reminder description INSIDE the tx.
        const rows = await tx
          .select({ description: reminders.description })
          .from(reminders)
          .where(and(eq(reminders.petId, petId1), eq(reminders.userId, adopterUserId)))
          .limit(1);

        expect(rows).toHaveLength(1);
        capturedDescription = rows[0]?.description ?? "";

        throw new Error("intentional rollback after assertion");
      })
      .catch((e) => {
        if ((e as Error).message !== "intentional rollback after assertion") throw e;
      });

    // Assert the exact parity copy.
    expect(capturedDescription).toBe(
      `${ORG_DISPLAY_NAME} pidió un check-in sobre ${PET_NAME}. Subí fotos y contanos cómo está.`,
    );
  });
});

// ---------------------------------------------------------------------------
// Bugfix regression: case records were never opened for adoption events.
//
// setEligibility() and insertApplication() insert pet_events rows without
// ever calling openCase(), despite CASE_ATTACHMENT_RULES declaring
// opensKind: "adoption_listing" / "adoption_application" for these event
// kinds. case_id is append-only on pet_events (DB trigger), so the
// open-or-attach decision has to be made atomically with the insert — these
// tests cover that wiring directly against Postgres (not mocks).
// ---------------------------------------------------------------------------

describe("AdoptionRepository — case-opening wiring (bugfix)", () => {
  describe("setEligibility", () => {
    it("opens an adoption_listing case and attaches its id to the pet_event when eligible=true", async () => {
      const now = new Date();

      await db.transaction(async (tx) => {
        await AdoptionRepository.setEligibility(
          {
            petId: petId2,
            eligible: true,
            ineligibleReason: null,
            ineligibleReasonNotes: null,
            ineligibleUntil: null,
            now,
            userId: actorUserId,
            orgId,
            orgVerified: true,
            previousState: null,
          },
          tx,
        );
      });

      const [event] = await db
        .select({ caseId: petEvents.caseId })
        .from(petEvents)
        .where(
          and(eq(petEvents.petId, petId2), eq(petEvents.eventType, "adoption_eligibility_set")),
        )
        .limit(1);

      expect(event?.caseId).not.toBeNull();

      const [caseRow] = await db
        .select()
        .from(cases)
        .where(eq(cases.id, event?.caseId as string));

      expect(caseRow).toBeTruthy();
      expect(caseRow.caseKind).toBe("adoption_listing");
      expect(caseRow.status).toBe("open");
      expect(caseRow.primaryPetId).toBe(petId2);
      expect(caseRow.openedByOrganizationId).toBe(orgId);
    });
  });

  describe("insertApplication", () => {
    let applicantAId: string;
    let applicantBId: string;

    beforeAll(async () => {
      applicantAId = crypto.randomUUID();
      applicantBId = crypto.randomUUID();
      await db.insert(profiles).values([
        {
          id: applicantAId,
          displayName: "Applicant A",
          dniHash: hashDni(`${Math.floor(Math.random() * 90000000 + 10000000)}`),
          dniVerified: false,
          role: "owner",
        },
        {
          id: applicantBId,
          displayName: "Applicant B",
          dniHash: hashDni(`${Math.floor(Math.random() * 90000000 + 10000000)}`),
          dniVerified: false,
          role: "owner",
        },
      ]);
    });

    afterAll(async () => {
      // Deleting these profiles cascades to SET NULL on
      // pet_events.recorded_by_user_id, which is an UPDATE on pet_events —
      // the append-only trigger blocks that without the escape hatch.
      await withMutationOverride(async (tx) => {
        await tx.delete(profiles).where(eq(profiles.id, applicantAId));
        await tx.delete(profiles).where(eq(profiles.id, applicantBId));
      });
    });

    it("opens an adoption_application case on the first application and attaches its id to the pet_event", async () => {
      let eventId = "";

      await db.transaction(async (tx) => {
        const result = await AdoptionRepository.insertApplication(
          {
            petId: petId2,
            userId: applicantAId,
            orgId,
            housingType: "casa_con_patio",
            otherPets: null,
            dailyRoutine: null,
            notes: null,
            motivation: "Quiero darle un hogar seguro.",
            priorPets: "no",
            now: new Date(),
          },
          tx,
        );
        eventId = result.eventId;
      });

      const [event] = await db
        .select({ caseId: petEvents.caseId })
        .from(petEvents)
        .where(eq(petEvents.id, eventId));

      expect(event?.caseId).not.toBeNull();

      const [caseRow] = await db
        .select()
        .from(cases)
        .where(eq(cases.id, event?.caseId as string));

      expect(caseRow).toBeTruthy();
      expect(caseRow.caseKind).toBe("adoption_application");
      expect(caseRow.status).toBe("open");
      expect(caseRow.primaryPetId).toBe(petId2);
      expect(caseRow.applicantUserId).toBe(applicantAId);
    });

    it("opens a SECOND, distinct adoption_application case for a second application from a DIFFERENT applicant", async () => {
      // CASE_ATTACHMENT_RULES.adoption_application_submitted is mode "opens",
      // but the production lookup (findOpenAdoptionApplicationCase) is scoped
      // by (petId, applicantUserId) — matching the partial unique index
      // `cases_open_adoption_app_per_applicant_idx`, which allows multiple
      // applicants to each hold their own concurrent open
      // adoption_application case for the same pet. So a second applicant's
      // submission must NOT attach to the first applicant's still-open case
      // — it opens its own.
      let firstEventId = "";
      await db.transaction(async (tx) => {
        const result = await AdoptionRepository.insertApplication(
          {
            petId: petId2,
            userId: applicantAId,
            orgId,
            housingType: "casa_con_patio",
            otherPets: null,
            dailyRoutine: null,
            notes: null,
            motivation: "Quiero darle un hogar seguro.",
            priorPets: "no",
            now: new Date(),
          },
          tx,
        );
        firstEventId = result.eventId;
      });

      let secondEventId = "";
      await db.transaction(async (tx) => {
        const result = await AdoptionRepository.insertApplication(
          {
            petId: petId2,
            userId: applicantBId,
            orgId,
            housingType: "departamento",
            otherPets: null,
            dailyRoutine: null,
            notes: null,
            motivation: "Quiero darle un hogar seguro.",
            priorPets: "no",
            now: new Date(),
          },
          tx,
        );
        secondEventId = result.eventId;
      });

      const [firstEvent] = await db
        .select({ caseId: petEvents.caseId })
        .from(petEvents)
        .where(eq(petEvents.id, firstEventId));
      const [secondEvent] = await db
        .select({ caseId: petEvents.caseId })
        .from(petEvents)
        .where(eq(petEvents.id, secondEventId));

      expect(firstEvent?.caseId).not.toBeNull();
      expect(secondEvent?.caseId).not.toBeNull();
      // Distinct cases — the second applicant does NOT attach to the first's.
      expect(secondEvent?.caseId).not.toBe(firstEvent?.caseId);

      const openCases = await db
        .select()
        .from(cases)
        .where(and(eq(cases.primaryPetId, petId2), eq(cases.caseKind, "adoption_application")));

      expect(openCases).toHaveLength(2);
      expect(openCases.every((c) => c.status === "open")).toBe(true);
      expect(new Set(openCases.map((c) => c.applicantUserId))).toEqual(
        new Set([applicantAId, applicantBId]),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Adoption reversal (adoption-reversal facade harvest, 2026-07-21)
//
// PO-locked semantics: reversing a finalized adoption returns custody to the
// finalizing org's shelter_custody and forces the pet UN-LISTED — the org
// must explicitly re-publish. Fixture: a genuinely-finalized adoption
// (via the real insertAdoptionFinalized, committed — not a rolled-back tx)
// so findReversibleAdoption/insertAdoptionReversed exercise real Postgres
// state, not a fake.
// ---------------------------------------------------------------------------

describe("AdoptionRepository — reversal (findReversibleAdoption / insertAdoptionReversed)", () => {
  const PET_TOKEN_REV = "DIM-ADOPTREP-REV";
  const PET_NAME_REV = "RepoTestPetRev";
  let petIdRev: string;
  let custodyOwnershipIdRev: string;
  let adopterUserIdRev: string;
  let finalizeEventIdRev: string;

  beforeAll(async () => {
    // Fresh pet, in shelter_custody for `orgId`, adoption-eligible AND listed
    // (adoptionListedAt set) — this is exactly the stale-listing risk
    // insertAdoptionReversed must defend against: finalize never clears
    // adoptionListedAt, so a naive reversal that only restores shelter_custody
    // would silently resurrect this pet on /adoptar.
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: PET_TOKEN_REV,
        name: PET_NAME_REV,
        species: "dog",
        sex: "female",
        potentiallyDangerousBreed: false,
        status: "active",
        adoptionEligible: true,
        adoptionEligibilitySetAt: new Date(),
        adoptionListedAt: new Date(),
      })
      .returning();
    petIdRev = pet.id;

    const [custody] = await db
      .insert(ownerships)
      .values({ petId: petIdRev, ownerOrganizationId: orgId, role: "shelter_custody" })
      .returning();
    custodyOwnershipIdRev = custody.id;

    adopterUserIdRev = crypto.randomUUID();

    // Genuine finalize (committed, via the real repo method) — the fixture
    // the reversal tests need: a real adoption_finalized event + owner row.
    await db.transaction(async (tx) => {
      // The adopter profile is seeded here, not by the repo: the stub-insert
      // branch is gone (adopters are always registered accounts).
      await seedAdopterProfile(tx, adopterUserIdRev);
      const { eventId } = await AdoptionRepository.insertAdoptionFinalized(
        {
          petId: petIdRev,
          userId: actorUserId,
          orgId,
          orgVerified: true,
          custodyOwnershipId: custodyOwnershipIdRev,
          adopterUserId: adopterUserIdRev,
          fosterRow: null,
          fosterUserId: null,
          custodyCaseId: null,
          contractAttachmentId: null,
          contractStoragePath: null,
          contractMimeType: null,
          contractFileSize: null,
          followupMonths: null,
          notes: null,
          orgDisplayName: ORG_DISPLAY_NAME,
          petName: PET_NAME_REV,
          now: new Date(),
        },
        tx,
      );
      finalizeEventIdRev = eventId;
    });
  });

  afterAll(async () => {
    // Deleting the pet cascades to ownerships/pet_events (append-only trigger
    // needs the mutation override, same as petId1/petId2's cleanup above).
    await withMutationOverride(async (tx) => {
      await tx.delete(pets).where(eq(pets.id, petIdRev));
      await tx.delete(profiles).where(eq(profiles.id, adopterUserIdRev));
    });
  });

  it("rejects reversal for an org that did not finalize this adoption", async () => {
    const result = await AdoptionRepository.findReversibleAdoption(
      petIdRev,
      "00000000-0000-0000-0000-000000000000",
    );
    expect(result.ok).toBe(false);
  });

  it("finds the reversible adoption for the finalizing org", async () => {
    const result = await AdoptionRepository.findReversibleAdoption(petIdRev, orgId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.finalizeEventId).toBe(finalizeEventIdRev);
      expect(result.adopterUserId).toBe(adopterUserIdRev);
      expect(result.petName).toBe(PET_NAME_REV);
    }
  });

  it("refuses the reversal while ANOTHER org holds live custody, and the raw insert is caught by the 0195 index", async () => {
    // After the adoption the animal went missing and a second refugio took it
    // in. Restoring THIS org's shelter_custody would be a second live org
    // custody row: the gate says so in es-AR, and the index is the last line.
    const OTHER_ORG_TOKEN = "DIM-ADOPTREP-OTH";
    // Leftovers from a crashed previous run — the token is hardcoded.
    await db.delete(organizations).where(eq(organizations.publicToken, OTHER_ORG_TOKEN));
    const [otherOrg] = await db
      .insert(organizations)
      .values({
        publicToken: OTHER_ORG_TOKEN,
        legalName: "Repo Test Otro Refugio SRL",
        displayName: "Repo Test Otro Refugio",
        orgType: "shelter",
        email: "adoptrep-other@dim-test.local",
        verified: true,
      })
      .returning({ id: organizations.id });
    try {
      await db
        .insert(ownerships)
        .values({ petId: petIdRev, ownerOrganizationId: otherOrg.id, role: "shelter_custody" });

      const gate = await AdoptionRepository.findReversibleAdoption(petIdRev, orgId);
      expect(gate.ok).toBe(false);
      if (!gate.ok) expect(gate.error).toMatch(/custodia de una organización/);

      // Armed-fence control: the write the gate protects really would collide.
      const adopterRow = await db
        .select({ id: ownerships.id })
        .from(ownerships)
        .where(
          and(
            eq(ownerships.petId, petIdRev),
            eq(ownerships.role, "owner"),
            isNull(ownerships.endedAt),
          ),
        );
      await expectDbError(
        db.transaction(async (tx) => {
          await AdoptionRepository.insertAdoptionReversed(
            {
              petId: petIdRev,
              userId: actorUserId,
              orgId,
              orgVerified: true,
              adopterOwnershipId: adopterRow[0].id,
              finalizeEventId: finalizeEventIdRev,
              reason: "Test: collision",
              now: new Date(),
            },
            tx,
          );
        }),
        { code: "23505", constraint: "ownerships_one_active_org_shelter_custody_per_pet" },
      );
      // The transaction rolled back: the adopter's owner row is still live.
      const [stillOwner] = await db
        .select({ endedAt: ownerships.endedAt })
        .from(ownerships)
        .where(eq(ownerships.id, adopterRow[0].id));
      expect(stillOwner.endedAt).toBeNull();
    } finally {
      // organizations → ownerships is ON DELETE CASCADE; the org delete takes
      // the custody row with it.
      await db.delete(organizations).where(eq(organizations.id, otherOrg.id));
    }
  });

  it("reverses: closes the owner row, restores shelter_custody for the org, " +
    "un-lists the pet, appends adoption_reversed, leaves adoption_finalized untouched", async () => {
    const reversible = await AdoptionRepository.findReversibleAdoption(petIdRev, orgId);
    expect(reversible.ok).toBe(true);
    if (!reversible.ok) return;

    let reversedEventId = "";
    await db.transaction(async (tx) => {
      const { eventId } = await AdoptionRepository.insertAdoptionReversed(
        {
          petId: petIdRev,
          userId: actorUserId,
          orgId,
          orgVerified: true,
          adopterOwnershipId: reversible.adopterOwnershipId,
          finalizeEventId: reversible.finalizeEventId,
          reason: "Test: unit reversal",
          now: new Date(),
        },
        tx,
      );
      reversedEventId = eventId;
    });

    // The adopter's owner row is closed.
    const [ownerRow] = await db
      .select({ endedAt: ownerships.endedAt })
      .from(ownerships)
      .where(eq(ownerships.id, reversible.adopterOwnershipId));
    expect(ownerRow.endedAt).not.toBeNull();

    // Custody returned to the finalizing org: a fresh active shelter_custody row.
    const [custodyRow] = await db
      .select({ id: ownerships.id })
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petIdRev),
          eq(ownerships.ownerOrganizationId, orgId),
          eq(ownerships.role, "shelter_custody"),
          isNull(ownerships.endedAt),
        ),
      );
    expect(custodyRow).toBeTruthy();

    // The pet is UN-LISTED (it was listed going in) — org must re-publish.
    const [petRow] = await db
      .select({
        adoptionListedAt: pets.adoptionListedAt,
        adoptionListingPausedAt: pets.adoptionListingPausedAt,
      })
      .from(pets)
      .where(eq(pets.id, petIdRev));
    expect(petRow.adoptionListedAt).toBeNull();
    expect(petRow.adoptionListingPausedAt).toBeNull();

    // adoption_finalized is append-only — untouched, still there.
    const [finalizeEvent] = await db
      .select({ id: petEvents.id, eventType: petEvents.eventType })
      .from(petEvents)
      .where(eq(petEvents.id, finalizeEventIdRev));
    expect(finalizeEvent).toBeTruthy();
    expect(finalizeEvent.eventType).toBe("adoption_finalized");

    // adoption_reversed is a NEW event, referencing the finalize event.
    const [reversedEvent] = await db
      .select({ eventType: petEvents.eventType, payload: petEvents.payload })
      .from(petEvents)
      .where(eq(petEvents.id, reversedEventId));
    expect(reversedEvent).toBeTruthy();
    expect(reversedEvent.eventType).toBe("adoption_reversed");
    const payload = reversedEvent.payload as Record<string, unknown>;
    expect(payload.reverted_finalization_event_id).toBe(finalizeEventIdRev);
    expect(payload.actor).toBe("shelter");
  });

  it("rejects a double-reverse — the same adoption cannot be reversed twice", async () => {
    // The previous test already committed a reversal for this pet/org pair.
    const result = await AdoptionRepository.findReversibleAdoption(petIdRev, orgId);
    expect(result.ok).toBe(false);
  });
});

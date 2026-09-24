// Integration tests for FosterRepository.
// Written FIRST (RED phase, tasks 2.1-2.4) before creating foster-repository.ts.
//
// These tests run against a local Postgres instance. They follow the same
// fixture pattern used by adoption-repository.test.ts.
//
// Known pre-existing flaky tests (NOT in this file):
//   outbreak-investigation, import-indec-localities, caba-barrios,
//   ar-localidades, admin-decisions/admin-revocations/role-upgrade

import { and, desc, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hashDni } from "@/lib/utils/dni-hash";

import {
  db,
  fosterProposals,
  fosterVolunteers,
  organizations,
  ownerships,
  petEvents,
  pets,
  profiles,
} from "@/db";
import { withMutationOverride } from "../../../../../__tests__/_helpers/db-overrides";

// Module under test — will be created in GREEN phase.
import { FosterRepository } from "../foster-repository";

// ---------------------------------------------------------------------------
// Fixture constants
// ---------------------------------------------------------------------------

const ORG_TOKEN = "DIM-FOSTERREP-TEST";
const PET_TOKEN = "DIM-FOSTERREP-P1";

let orgId: string;
let petId: string;
let custodyOwnershipId: string;
let volunteerUserId: string;
let volunteerId: string;
let proposerUserId: string;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Insert a test-owned proposer profile so FK columns don't depend on any seeded user.
  proposerUserId = crypto.randomUUID();
  await db.insert(profiles).values({
    id: proposerUserId,
    displayName: "FosterRepo Proposer",
    dniHash: hashDni(`${Math.floor(Math.random() * 90000000 + 10000000)}`),
    dniVerified: false,
    role: "owner",
  });

  // Clean slate for crashed previous runs.
  await withMutationOverride(async (tx) => {
    const stalePets = await tx
      .select({ id: pets.id })
      .from(pets)
      .where(eq(pets.publicToken, PET_TOKEN));
    for (const { id } of stalePets) await tx.delete(pets).where(eq(pets.id, id));
    const staleOrgs = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.publicToken, ORG_TOKEN));
    for (const { id } of staleOrgs) await tx.delete(organizations).where(eq(organizations.id, id));
  });

  // Insert org.
  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: ORG_TOKEN,
      legalName: "Foster Repo Test SRL",
      displayName: "Foster Repo Org",
      orgType: "shelter",
      email: "fosterrep@dim-test.local",
      verified: true,
    })
    .returning();
  orgId = org.id;

  // Insert volunteer profile.
  volunteerUserId = crypto.randomUUID();
  await db.insert(profiles).values({
    id: volunteerUserId,
    displayName: "Test Volunteer",
    dniHash: hashDni(`${Math.floor(Math.random() * 90000000 + 10000000)}`),
    dniVerified: true,
    role: "owner",
    phone: "1112345678",
  });

  // Insert volunteer row.
  const [vol] = await db
    .insert(fosterVolunteers)
    .values({
      userId: volunteerUserId,
      status: "active",
      availableSlots: 2,
      acceptsDogs: true,
      acceptsCats: true,
      acceptsOtherSpecies: false,
      acceptsSizeSmall: true,
      acceptsSizeMedium: true,
      acceptsSizeLarge: false,
      acceptsPuppies: false,
      acceptsSeniors: true,
      acceptsChronicConditions: false,
      acceptsDangerousBreeds: false,
    })
    .returning();
  volunteerId = vol.id;

  // Insert pet.
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN,
      name: "FosterRepoTestPet",
      species: "dog",
      sex: "male",
      potentiallyDangerousBreed: false,
      status: "active",
    })
    .returning();
  petId = pet.id;

  // Insert shelter_custody ownership.
  const [custody] = await db
    .insert(ownerships)
    .values({
      petId,
      ownerOrganizationId: orgId,
      role: "shelter_custody",
    })
    .returning();
  custodyOwnershipId = custody.id;
});

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    if (petId) await tx.delete(pets).where(eq(pets.id, petId));
    if (orgId) await tx.delete(organizations).where(eq(organizations.id, orgId));
    if (volunteerUserId) await tx.delete(profiles).where(eq(profiles.id, volunteerUserId));
    if (proposerUserId) await tx.delete(profiles).where(eq(profiles.id, proposerUserId));
  });
});

// ---------------------------------------------------------------------------
// findShelterPetByToken
// ---------------------------------------------------------------------------

describe("FosterRepository.findShelterPetByToken", () => {
  it("returns the pet when it exists in the org's shelter_custody", async () => {
    const result = await FosterRepository.findShelterPetByToken(PET_TOKEN, orgId);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(petId);
  });

  it("returns null when the pet exists but not under this org's custody", async () => {
    const result = await FosterRepository.findShelterPetByToken(
      PET_TOKEN,
      "00000000-0000-0000-0000-000000000000",
    );
    expect(result).toBeNull();
  });

  it("returns null for an unknown token", async () => {
    const result = await FosterRepository.findShelterPetByToken("NO-SUCH-TOKEN", orgId);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findActiveMembership
// ---------------------------------------------------------------------------

describe("FosterRepository.findActiveMembership", () => {
  it("returns null when no membership exists", async () => {
    const result = await FosterRepository.findActiveMembership(
      "00000000-0000-0000-0000-000000000001",
      orgId,
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findActiveFosterRows
// ---------------------------------------------------------------------------

describe("FosterRepository.findActiveFosterRows", () => {
  it("returns empty array when no active foster row exists", async () => {
    const result = await FosterRepository.findActiveFosterRows(petId);
    expect(result).toEqual([]);
  });

  it("returns foster rows when they exist", async () => {
    const [fosterOwnership] = await db
      .insert(ownerships)
      .values({ petId, ownerUserId: volunteerUserId, role: "foster" })
      .returning();

    const result = await FosterRepository.findActiveFosterRows(petId);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].id).toBe(fosterOwnership.id);

    // Cleanup.
    await db.delete(ownerships).where(eq(ownerships.id, fosterOwnership.id));
  });
});

// ---------------------------------------------------------------------------
// insertFosterOwnership + endFosterOwnership (atomicity / rollback)
// ---------------------------------------------------------------------------

describe("FosterRepository.insertFosterOwnership — atomicity", () => {
  it("rolls back insertFosterOwnership when the tx is aborted", async () => {
    const countBefore = (
      await db
        .select()
        .from(ownerships)
        .where(
          and(
            eq(ownerships.petId, petId),
            eq(ownerships.role, "foster"),
            isNull(ownerships.endedAt),
          ),
        )
    ).length;

    await expect(
      db.transaction(async (tx) => {
        await FosterRepository.insertFosterOwnership(
          {
            petId,
            ownerUserId: volunteerUserId,
            allowCoFoster: false,
          },
          tx,
        );
        throw new Error("intentional rollback");
      }),
    ).rejects.toThrow("intentional rollback");

    const countAfter = (
      await db
        .select()
        .from(ownerships)
        .where(
          and(
            eq(ownerships.petId, petId),
            eq(ownerships.role, "foster"),
            isNull(ownerships.endedAt),
          ),
        )
    ).length;

    expect(countAfter).toBe(countBefore);
  });

  it("persists the foster row when tx commits", async () => {
    let fosterOwnershipId: string | undefined;

    await db.transaction(async (tx) => {
      const { id } = await FosterRepository.insertFosterOwnership(
        { petId, ownerUserId: volunteerUserId, allowCoFoster: false },
        tx,
      );
      fosterOwnershipId = id;
    });

    const rows = await db
      .select({ id: ownerships.id })
      .from(ownerships)
      .where(eq(ownerships.id, fosterOwnershipId!));
    expect(rows).toHaveLength(1);

    // Cleanup.
    await db.delete(ownerships).where(eq(ownerships.id, fosterOwnershipId!));
  });
});

// ---------------------------------------------------------------------------
// Task 2.2: accept inserts ownership BEFORE single proposal update (CHECK constraint)
// ---------------------------------------------------------------------------

describe("Task 2.2 — CHECK foster_proposals_response_consistent: accept ordering", () => {
  it("inserting ownership before updating proposal satisfies the CHECK constraint", async () => {
    // Create a pending proposal row.
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const [proposal] = await db
      .insert(fosterProposals)
      .values({
        publicToken: `FP-REPTEST-${Date.now()}`,
        organizationId: orgId,
        volunteerUserId,
        petId,
        proposedByUserId: proposerUserId,
        proposedAt: now,
        expiresAt,
        status: "pending",
        matchWarnings: [],
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    try {
      await db.transaction(async (tx) => {
        // Step 1: insert foster ownership.
        const { id: fosterOwnershipId } = await FosterRepository.insertFosterOwnership(
          { petId, ownerUserId: volunteerUserId, allowCoFoster: false },
          tx,
        );

        // Step 2: single proposal UPDATE with resolvedOwnershipId + respondedAt.
        // This must NOT be split across two statements (CHECK constraint requires both
        // respondedAt IS NOT NULL AND resolvedOwnershipId IS NOT NULL when status='accepted').
        await tx
          .update(fosterProposals)
          .set({
            status: "accepted",
            respondedAt: now,
            resolvedOwnershipId: fosterOwnershipId,
            updatedAt: now,
          })
          .where(eq(fosterProposals.id, proposal.id));
        // If the CHECK fires, the tx throws and this test fails with a constraint violation.
      });

      // Verify the proposal is now accepted.
      const [updated] = await db
        .select({ status: fosterProposals.status })
        .from(fosterProposals)
        .where(eq(fosterProposals.id, proposal.id));
      expect(updated.status).toBe("accepted");
    } finally {
      // Cleanup: remove foster ownership + proposal.
      await db.delete(fosterProposals).where(eq(fosterProposals.id, proposal.id));
      await db
        .delete(ownerships)
        .where(
          and(
            eq(ownerships.petId, petId),
            eq(ownerships.ownerUserId, volunteerUserId),
            eq(ownerships.role, "foster"),
          ),
        );
    }
  });

  it("updating proposal to accepted WITHOUT resolvedOwnershipId violates the CHECK constraint", async () => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const [proposal] = await db
      .insert(fosterProposals)
      .values({
        publicToken: `FP-REPTEST2-${Date.now()}`,
        organizationId: orgId,
        volunteerUserId,
        petId,
        proposedByUserId: proposerUserId,
        proposedAt: now,
        expiresAt,
        status: "pending",
        matchWarnings: [],
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    try {
      await expect(
        db.transaction(async (tx) => {
          // Attempt accepted WITHOUT resolvedOwnershipId → CHECK must fail.
          await tx
            .update(fosterProposals)
            .set({ status: "accepted", respondedAt: now, updatedAt: now })
            .where(eq(fosterProposals.id, proposal.id));
        }),
      ).rejects.toThrow();
    } finally {
      await db.delete(fosterProposals).where(eq(fosterProposals.id, proposal.id));
    }
  });
});

// ---------------------------------------------------------------------------
// Task 2.3: withdrawVolunteer cascade — emits events WITHOUT caseId
// ---------------------------------------------------------------------------

describe("Task 2.3 — withdrawVolunteer cascade: events emitted WITHOUT caseId (parity quirk)", () => {
  it("cancel-cascade during withdraw emits foster_proposal_resolved WITHOUT caseId", async () => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Create a pending proposal for the volunteer.
    const [proposal] = await db
      .insert(fosterProposals)
      .values({
        publicToken: `FP-WITHDRAW-${Date.now()}`,
        organizationId: orgId,
        volunteerUserId,
        petId,
        proposedByUserId: proposerUserId,
        proposedAt: now,
        expiresAt,
        status: "pending",
        matchWarnings: [],
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    try {
      await db.transaction(async (tx) => {
        await FosterRepository.withdrawVolunteer({ userId: volunteerUserId, now }, tx);
      });

      // Verify the proposal was cancelled.
      const [updated] = await db
        .select({
          status: fosterProposals.status,
          cancellationReason: fosterProposals.cancellationReason,
        })
        .from(fosterProposals)
        .where(eq(fosterProposals.id, proposal.id));
      expect(updated.status).toBe("cancelled");
      expect(updated.cancellationReason).toBe("volunteer_withdrew");

      // PARITY QUIRK: the emitted event must NOT have a caseId.
      const events = await db
        .select({ caseId: petEvents.caseId })
        .from(petEvents)
        .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "foster_proposal_resolved")))
        .orderBy(petEvents.occurredAt);

      // Find the event for this proposal.
      const withdrawEvent = events.find((e) => e.caseId === null);
      expect(withdrawEvent).toBeDefined();
      expect(withdrawEvent?.caseId).toBeNull();
    } finally {
      await withMutationOverride(async (tx) => {
        await tx.delete(fosterProposals).where(eq(fosterProposals.id, proposal.id));
        // Reset volunteer status.
        await tx
          .update(fosterVolunteers)
          .set({ status: "active", availableSlots: 2, updatedAt: now })
          .where(eq(fosterVolunteers.id, volunteerId));
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Task 2.4: expirer per-row tx + status recheck
// ---------------------------------------------------------------------------

describe("Task 2.4 — expirePendingProposals: per-row tx, status recheck, null actor", () => {
  it("expires a pending proposal that is past its expiresAt and emits event with null recordedByUserId", async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000); // yesterday
    const expiresAt = new Date(Date.now() - 60 * 1000); // 1 minute ago

    const [proposal] = await db
      .insert(fosterProposals)
      .values({
        publicToken: `FP-EXPIRE-${Date.now()}`,
        organizationId: orgId,
        volunteerUserId,
        petId,
        proposedByUserId: proposerUserId,
        proposedAt: past,
        expiresAt,
        status: "pending",
        matchWarnings: [],
        createdAt: past,
        updatedAt: past,
      })
      .returning();

    try {
      const stats = await FosterRepository.expirePendingProposals(new Date());

      expect(stats.candidates).toBeGreaterThanOrEqual(1);
      expect(stats.expired).toBeGreaterThanOrEqual(1);
      expect(stats.errors).toBe(0);

      // Verify proposal is now expired.
      const [updated] = await db
        .select({ status: fosterProposals.status })
        .from(fosterProposals)
        .where(eq(fosterProposals.id, proposal.id));
      expect(updated.status).toBe("expired");

      // Verify the event has null recordedByUserId (system actor).
      const events = await db
        .select({ recordedByUserId: petEvents.recordedByUserId, authorRole: petEvents.authorRole })
        .from(petEvents)
        .where(
          and(eq(petEvents.petId, petId), eq(petEvents.eventType, "foster_proposal_resolved")),
        );
      const expireEvent = events.find((e) => e.authorRole === "system");
      expect(expireEvent).toBeDefined();
      expect(expireEvent?.recordedByUserId).toBeNull();
    } finally {
      await withMutationOverride(async (tx) => {
        await tx.delete(fosterProposals).where(eq(fosterProposals.id, proposal.id));
      });
    }
  });

  it("skips a proposal that was accepted between candidate scan and per-row tx (status recheck)", async () => {
    // We can't easily simulate the race in a unit test, but we can verify
    // that a non-pending proposal is skipped (status recheck = effective guard).
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const expiresAt = new Date(Date.now() - 60 * 1000);

    // Insert an already-cancelled proposal (status already changed before expire).
    const now = new Date();
    const [proposal] = await db
      .insert(fosterProposals)
      .values({
        publicToken: `FP-SKIP-${Date.now()}`,
        organizationId: orgId,
        volunteerUserId,
        petId,
        proposedByUserId: proposerUserId,
        proposedAt: past,
        expiresAt,
        status: "cancelled",
        cancelledAt: past,
        cancelledByUserId: proposerUserId,
        cancellationReason: "org_cancelled",
        matchWarnings: [],
        createdAt: past,
        updatedAt: now,
      })
      .returning();

    try {
      const statsBefore = await FosterRepository.expirePendingProposals(new Date());
      // The cancelled proposal should NOT be in candidates (it's not 'pending').
      // We just verify the proposal's status hasn't been changed to 'expired'.
      const [check] = await db
        .select({ status: fosterProposals.status })
        .from(fosterProposals)
        .where(eq(fosterProposals.id, proposal.id));
      expect(check.status).toBe("cancelled"); // untouched
    } finally {
      await db.delete(fosterProposals).where(eq(fosterProposals.id, proposal.id));
    }
  });
});

// ---------------------------------------------------------------------------
// findVolunteerByUserId
// ---------------------------------------------------------------------------

describe("FosterRepository.findVolunteerByUserId", () => {
  it("returns the volunteer row when it exists", async () => {
    const result = await FosterRepository.findVolunteerByUserId(volunteerUserId);
    expect(result).not.toBeNull();
    expect(result?.userId).toBe(volunteerUserId);
    expect(result?.availableSlots).toBeGreaterThanOrEqual(0);
  });

  it("returns null when no volunteer row exists for the user", async () => {
    const result = await FosterRepository.findVolunteerByUserId(
      "00000000-0000-0000-0000-000000000099",
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AF-C1 (CRITICAL): convertFosterToOwner must close the org's shelter_custody.
// A foster always coexists with an active shelter_custody row (the org holds
// custody, the volunteer holds foster). If convert only ends the foster + owner
// rows, the org keeps an ACTIVE shelter_custody → permanent double custody (the
// org can still re-foster / list / finalize the pet elsewhere; metrics double
// count). This mirrors insertAdoptionFinalized, which closes BOTH rows.
// ---------------------------------------------------------------------------

describe("AF-C1 — insertConvertFosterToOwner: closes the org's shelter_custody", () => {
  it("leaves exactly ONE active ownership (the new owner) and NO active shelter_custody", async () => {
    // Precondition: the pet has an active shelter_custody row (from beforeAll).
    // Add the coexisting active foster row for the volunteer.
    const [fosterOwnership] = await db
      .insert(ownerships)
      .values({ petId, ownerUserId: volunteerUserId, role: "foster" })
      .returning();

    // Sanity: two active ownerships before convert (shelter_custody + foster).
    const activeBefore = await db
      .select({ role: ownerships.role })
      .from(ownerships)
      .where(and(eq(ownerships.petId, petId), isNull(ownerships.endedAt)));
    expect(activeBefore.map((r) => r.role).sort()).toEqual(["foster", "shelter_custody"]);

    try {
      await db.transaction(async (tx) => {
        await FosterRepository.insertConvertFosterToOwner(
          {
            petId,
            petName: "FosterRepoTestPet",
            fosterOwnershipId: fosterOwnership.id,
            fosterUserId: volunteerUserId,
            fosterEndedEventId: crypto.randomUUID(),
            actorUserId: volunteerUserId,
            now: new Date(),
          },
          tx,
        );
      });

      const activeAfter = await db
        .select({ role: ownerships.role, ownerUserId: ownerships.ownerUserId })
        .from(ownerships)
        .where(and(eq(ownerships.petId, petId), isNull(ownerships.endedAt)));

      // Exactly one active ownership: the new owner (the ex-foster user).
      expect(activeAfter).toHaveLength(1);
      expect(activeAfter[0].role).toBe("owner");
      expect(activeAfter[0].ownerUserId).toBe(volunteerUserId);
      // No active shelter_custody remains.
      expect(activeAfter.some((r) => r.role === "shelter_custody")).toBe(false);
    } finally {
      // Cleanup: drop all ownerships + emitted events for this pet, then
      // restore the shelter_custody row so later runs start clean.
      await withMutationOverride(async (tx) => {
        await tx.delete(petEvents).where(eq(petEvents.petId, petId));
        await tx.delete(ownerships).where(eq(ownerships.petId, petId));
        const [custody] = await tx
          .insert(ownerships)
          .values({ petId, ownerOrganizationId: orgId, role: "shelter_custody" })
          .returning();
        custodyOwnershipId = custody.id;
      });
    }
  });
});

// ---------------------------------------------------------------------------
// M-8 (custody-ledger races, 2026-08-23) — the two writers that CLOSE a foster
// ---------------------------------------------------------------------------
//
// Both closed the foster row BY ID, with no `WHERE ended_at IS NULL`, no lock,
// and the UPDATE's row count discarded — so neither could tell it had done
// nothing. A shelter finalising an adoption (or accepting a cross-org transfer)
// at the same instant closes that same row; the ex-foster's conversion then
// lands its `owner` row on top of a fact already written and confirmed, and the
// spine is append-only.
//
// The same file, 74 lines above `insertEndFoster`, ALREADY has the pattern:
// `insertAssignFoster` — which OPENS a foster — takes the pet advisory lock and
// re-verifies inside the tx, naming the double-submit as its threat. The module
// set the pattern for opening and never applied it to the two that close.
//
// The skeptic's two corrections over the original finding:
//   - The lock has to be taken by BOTH sides. An advisory lock only excludes
//     other TAKERS, so locking the convert alone leaves it unserialised against
//     endFoster.
//   - The in-tx re-read has to be CHECKED, not left as a WHERE clause whose row
//     count nobody reads — `finalize-adoption.ts` is the shape to copy
//     (`if (!lockedRow) return` / refuse), not a silent no-op UPDATE.
describe("M-8 — the foster-closing writers refuse a row that is already closed", () => {
  it("insertConvertFosterToOwner throws and writes nothing when the foster row was closed by a racing writer", async () => {
    const [fosterOwnership] = await db
      .insert(ownerships)
      .values({ petId, ownerUserId: volunteerUserId, role: "foster" })
      .returning();

    // The race, made deterministic: the winner (an adoption finalize, a
    // cross-org accept) already closed this row and committed.
    await withMutationOverride(async (tx) => {
      await tx
        .update(ownerships)
        .set({ endedAt: new Date() })
        .where(eq(ownerships.id, fosterOwnership.id));
    });

    try {
      await expect(
        db.transaction(async (tx) => {
          await FosterRepository.insertConvertFosterToOwner(
            {
              petId,
              petName: "FosterRepoTestPet",
              fosterOwnershipId: fosterOwnership.id,
              fosterUserId: volunteerUserId,
              fosterEndedEventId: crypto.randomUUID(),
              actorUserId: volunteerUserId,
              now: new Date(),
            },
            tx,
          );
        }),
      ).rejects.toThrow(/tránsito/i);

      // Nothing written: no new owner row, no foster_ended, no
      // custody_transferred. The shelter_custody row from beforeAll survives.
      const active = await db
        .select({ role: ownerships.role })
        .from(ownerships)
        .where(and(eq(ownerships.petId, petId), isNull(ownerships.endedAt)));
      expect(active.map((r) => r.role).sort()).toEqual(["shelter_custody"]);
      const events = await db
        .select({ eventType: petEvents.eventType })
        .from(petEvents)
        .where(eq(petEvents.petId, petId));
      expect(events.map((e) => e.eventType)).not.toContain("foster_ended");
      expect(events.map((e) => e.eventType)).not.toContain("custody_transferred");
    } finally {
      await withMutationOverride(async (tx) => {
        await tx.delete(petEvents).where(eq(petEvents.petId, petId));
        await tx.delete(ownerships).where(eq(ownerships.petId, petId));
        const [custody] = await tx
          .insert(ownerships)
          .values({ petId, ownerOrganizationId: orgId, role: "shelter_custody" })
          .returning();
        custodyOwnershipId = custody.id;
      });
    }
  });

  it("insertEndFoster throws and writes nothing when the foster row was closed by a racing writer", async () => {
    const [fosterOwnership] = await db
      .insert(ownerships)
      .values({ petId, ownerUserId: volunteerUserId, role: "foster" })
      .returning();

    await withMutationOverride(async (tx) => {
      await tx
        .update(ownerships)
        .set({ endedAt: new Date() })
        .where(eq(ownerships.id, fosterOwnership.id));
    });

    try {
      await expect(
        db.transaction(async (tx) => {
          await FosterRepository.insertEndFoster(
            {
              petId,
              petName: "FosterRepoTestPet",
              fosterOwnershipId: fosterOwnership.id,
              fosterUserId: volunteerUserId,
              reason: "returned",
              closedReason: "resolved",
              notes: null,
              actorUserId: proposerUserId,
              actorOrgId: orgId,
              actorOrgVerified: true,
              now: new Date(),
            },
            tx,
          );
        }),
      ).rejects.toThrow(/tránsito/i);

      const events = await db
        .select({ eventType: petEvents.eventType })
        .from(petEvents)
        .where(eq(petEvents.petId, petId));
      expect(events.map((e) => e.eventType)).not.toContain("foster_ended");
    } finally {
      await withMutationOverride(async (tx) => {
        await tx.delete(petEvents).where(eq(petEvents.petId, petId));
        await tx.delete(ownerships).where(eq(ownerships.petId, petId));
        const [custody] = await tx
          .insert(ownerships)
          .values({ petId, ownerOrganizationId: orgId, role: "shelter_custody" })
          .returning();
        custodyOwnershipId = custody.id;
      });
    }
  });

  // The lock itself is not observable from a single transaction, so it is
  // pinned at the source — and on BOTH sides, which is the whole correction:
  // an advisory lock excludes only other takers.
  it("both closing writers take the pet advisory lock, and take it FIRST", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const INFRA = join(__dirname, "..");
    const LOCK = "pg_advisory_xact_lock(hashtext(";

    const convertSrc = readFileSync(join(INFRA, "foster-convert-to-owner-writer.ts"), "utf8");
    const convertLockAt = convertSrc.indexOf(LOCK);
    expect(convertLockAt, "the pet advisory lock in the convert writer").toBeGreaterThanOrEqual(0);
    expect(convertLockAt).toBeLessThan(convertSrc.indexOf("endAllLiveOwnerships("));

    // `insertEndFoster` left foster-repository.ts for its own writer when this
    // fix grew it past the file's size ratchet — the repository still exports
    // it as a delegating member, so no caller and no test double moved.
    const endSrc = readFileSync(join(INFRA, "foster-end-writer.ts"), "utf8");
    const endLockAt = endSrc.indexOf(LOCK);
    expect(endLockAt, "the pet advisory lock in the end-foster writer").toBeGreaterThanOrEqual(0);
    expect(endLockAt).toBeLessThan(endSrc.indexOf("tx.insert(petEvents)"));
    expect(
      readFileSync(join(INFRA, "foster-repository.ts"), "utf8"),
      "the repository still exposes insertEndFoster",
    ).toContain("insertEndFoster,");
  });
});

// ---------------------------------------------------------------------------
// Authorship honesty on accept (cowork audit finding #7 / AF-L3, 2026-08-12)
// ---------------------------------------------------------------------------
//
// foster_assigned used to be emitted with authorVerified hardcoded `true`,
// regardless of whether the proposing organization had passed personería
// review. The libreta renders that flag as "verified by an organization", so an
// unverified org's assignment claimed a vouching that never happened — a lie in
// the one log whose whole job is to record who vouched for what.
//
// WHAT WOULD HAVE TO BREAK FOR THIS TO FAIL: reverting to a constant. The test
// flips organizations.verified and asserts the emitted event follows it.
describe("insertAcceptFosterProposal — foster_assigned authorship follows the org", () => {
  async function acceptWithOrgVerified(verified: boolean): Promise<boolean> {
    await db.update(organizations).set({ verified }).where(eq(organizations.id, orgId));

    const now = new Date();
    const [proposal] = await db
      .insert(fosterProposals)
      .values({
        publicToken: `FP-VERIF-${verified ? "V" : "U"}-${Date.now()}`,
        organizationId: orgId,
        volunteerUserId,
        petId,
        proposedByUserId: proposerUserId,
        proposedAt: now,
        expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
        status: "pending",
        matchWarnings: [],
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    await db.transaction(async (tx) => {
      await FosterRepository.insertAcceptFosterProposal(
        {
          proposal,
          petId,
          petName: "FosterRepTestPet",
          volunteerUserId,
          volunteerId,
          volunteerCurrentSlots: 1,
          allowCoFoster: false,
          responseNotes: null,
          actorUserId: proposerUserId,
          actorOrgId: orgId,
          now,
        },
        tx,
      );
    });

    const [assigned] = await db
      .select({ authorVerified: petEvents.authorVerified })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "foster_assigned")))
      .orderBy(desc(petEvents.recordedAt))
      .limit(1);

    return assigned.authorVerified;
  }

  afterAll(async () => {
    // Leave the shared fixture as the rest of the suite expects it.
    await db.update(organizations).set({ verified: true }).where(eq(organizations.id, orgId));
    await withMutationOverride(async (tx) => {
      await tx.delete(petEvents).where(eq(petEvents.petId, petId));
    }).catch(() => {});
  });

  it("stamps authorVerified=false when the assigning org is NOT verified", async () => {
    expect(await acceptWithOrgVerified(false)).toBe(false);
  });

  it("stamps authorVerified=true when the assigning org IS verified", async () => {
    expect(await acceptWithOrgVerified(true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A10-6: the UPDATE branch stores the canonical province, like INSERT does.
// Before the fix it wrote `input.jurisdictionProvince` raw, so an unaccented
// "Cordoba" hit 0055's foster_volunteers_jurisdiction_province_canonical CHECK
// on a volunteer who had enrolled fine. Runs inside a transaction that is
// always rolled back, with its own profile, so it leaves nothing behind.
// ---------------------------------------------------------------------------

describe("A10-6 — upsertVolunteer UPDATE branch stores the canonical province", () => {
  it("re-saving with an unaccented province stores the canonical name", async () => {
    const ROLLBACK = new Error("a10-6 rollback");
    const input = {
      mode: "enroll" as const,
      status: "active" as const,
      jurisdictionProvince: "Cordoba",
      jurisdictionLocality: null,
      acceptsDogs: true,
      acceptsCats: false,
      acceptsOtherSpecies: false,
      acceptsSizeSmall: true,
      acceptsSizeMedium: false,
      acceptsSizeLarge: false,
      acceptsPuppies: false,
      acceptsSeniors: false,
      acceptsChronicConditions: false,
      acceptsDangerousBreeds: false,
    };
    let storedAfterUpdate: string | null | undefined;

    await expect(
      db.transaction(async (tx) => {
        const userId = crypto.randomUUID();
        await tx.insert(profiles).values({
          id: userId,
          displayName: "A10-6 Volunteer",
          dniHash: hashDni(`${Math.floor(Math.random() * 90000000 + 10000000)}`),
          dniVerified: true,
          role: "owner",
          phone: "1112345678",
        });
        const args = { userId, input, newSlots: 1, now: new Date(), canonicalProvince: "Córdoba" };
        // First call takes the INSERT branch, second the UPDATE branch.
        await FosterRepository.upsertVolunteer(args, tx);
        await FosterRepository.upsertVolunteer(args, tx);
        const [row] = await tx
          .select({ province: fosterVolunteers.jurisdictionProvince })
          .from(fosterVolunteers)
          .where(eq(fosterVolunteers.userId, userId));
        storedAfterUpdate = row?.province;
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);

    expect(storedAfterUpdate).toBe("Córdoba");
  });
});

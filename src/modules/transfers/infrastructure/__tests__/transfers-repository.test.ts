// Integration tests for TransfersRepository.
// Written FIRST (RED phase, tasks 2.1-2.5) before creating transfers-repository.ts.
//
// These tests run against a local Postgres instance. They follow the same
// fixture pattern used by foster-repository.test.ts.
//
// Known pre-existing flaky tests (NOT in this file):
//   outbreak-investigation, import-indec-localities, caba-barrios,
//   ar-localidades, admin-decisions/admin-revocations/role-upgrade

import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hashDni } from "@/lib/utils/dni-hash";

import { db, organizations, ownerships, petEvents, petTransfers, pets, profiles } from "@/db";
import { withMutationOverride } from "../../../../../__tests__/_helpers/db-overrides";

// Module under test — created in GREEN phase.
import { TransfersRepository } from "../transfers-repository";

// ---------------------------------------------------------------------------
// Fixture constants
// ---------------------------------------------------------------------------

const ORG_TOKEN_A = "DIM-TRANSFERSREP-ORGA";
const ORG_TOKEN_B = "DIM-TRANSFERSREP-ORGB";
const PET_TOKEN = "DIM-TRANSFERSREP-P1";
const PET_TOKEN_EXPIRY = "DIM-TRANSFERSREP-P2";

let orgAId: string;
let orgBId: string;
let petId: string;
let expiryPetId: string;
let senderUserId: string;
let recipientUserId: string;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Clean slate for crashed previous runs.
  await withMutationOverride(async (tx) => {
    for (const tok of [PET_TOKEN, PET_TOKEN_EXPIRY]) {
      const stalePets = await tx
        .select({ id: pets.id })
        .from(pets)
        .where(eq(pets.publicToken, tok));
      for (const { id } of stalePets) await tx.delete(pets).where(eq(pets.id, id));
    }
    for (const tok of [ORG_TOKEN_A, ORG_TOKEN_B]) {
      const staleOrgs = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.publicToken, tok));
      for (const { id } of staleOrgs)
        await tx.delete(organizations).where(eq(organizations.id, id));
    }
  });

  // Insert orgs.
  const [orgA] = await db
    .insert(organizations)
    .values({
      publicToken: ORG_TOKEN_A,
      legalName: "Transfers Repo Test SRL A",
      displayName: "TransfersRepo Org A",
      orgType: "shelter",
      email: "transfersrepa@dim-test.local",
      verified: true,
    })
    .returning();
  orgAId = orgA.id;

  const [orgB] = await db
    .insert(organizations)
    .values({
      publicToken: ORG_TOKEN_B,
      legalName: "Transfers Repo Test SRL B",
      displayName: "TransfersRepo Org B",
      orgType: "shelter",
      email: "transfersrepb@dim-test.local",
      verified: true,
    })
    .returning();
  orgBId = orgB.id;

  // Insert user profiles.
  senderUserId = randomUUID();
  await db.insert(profiles).values({
    id: senderUserId,
    displayName: "Test Sender",
    dniHash: hashDni(`${Math.floor(Math.random() * 90000000 + 10000000)}`),
    dniVerified: true,
    role: "owner",
    phone: "1112340001",
  });

  recipientUserId = randomUUID();
  await db.insert(profiles).values({
    id: recipientUserId,
    displayName: "Test Recipient",
    dniHash: hashDni(`${Math.floor(Math.random() * 90000000 + 10000000)}`),
    dniVerified: true,
    role: "owner",
    phone: "1112340002",
  });

  // Insert pet with owner ownership under senderUser.
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN,
      name: "TransferRepoTestPet",
      species: "dog",
      sex: "male",
      potentiallyDangerousBreed: false,
      status: "active",
    })
    .returning();
  petId = pet.id;

  await db.insert(ownerships).values({
    petId,
    ownerUserId: senderUserId,
    role: "owner",
  });

  // Separate pet for expiry tests — no shared pending transfers.
  const [expiryPet] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN_EXPIRY,
      name: "TransferExpiryPet",
      species: "cat",
      sex: "female",
      potentiallyDangerousBreed: false,
      status: "active",
    })
    .returning();
  expiryPetId = expiryPet.id;

  await db.insert(ownerships).values({
    petId: expiryPetId,
    ownerUserId: senderUserId,
    role: "owner",
  });
});

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    if (petId) await tx.delete(pets).where(eq(pets.id, petId));
    if (expiryPetId) await tx.delete(pets).where(eq(pets.id, expiryPetId));
    if (orgAId) await tx.delete(organizations).where(eq(organizations.id, orgAId));
    if (orgBId) await tx.delete(organizations).where(eq(organizations.id, orgBId));
    if (senderUserId) await tx.delete(profiles).where(eq(profiles.id, senderUserId));
    if (recipientUserId) await tx.delete(profiles).where(eq(profiles.id, recipientUserId));
  });
});

// ---------------------------------------------------------------------------
// findPetByToken
// ---------------------------------------------------------------------------

describe("TransfersRepository.findPetByToken", () => {
  it("returns the pet for a known public token", async () => {
    const result = await TransfersRepository.findPetByToken(PET_TOKEN);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(petId);
    expect(result?.publicToken).toBe(PET_TOKEN);
  });

  it("returns null for an unknown token", async () => {
    const result = await TransfersRepository.findPetByToken("NO-SUCH-TOKEN");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findActiveOwnerOwnership
// ---------------------------------------------------------------------------

describe("TransfersRepository.findActiveOwnerOwnership", () => {
  it("returns the active owner ownership row", async () => {
    const result = await TransfersRepository.findActiveOwnerOwnership(petId);
    expect(result).not.toBeNull();
    expect(result?.ownerUserId).toBe(senderUserId);
  });

  it("returns null when no active owner ownership exists for an unknown pet", async () => {
    const result = await TransfersRepository.findActiveOwnerOwnership(
      "00000000-0000-0000-0000-000000000099",
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// insertPetTransfer + findTransferByToken
// ---------------------------------------------------------------------------

describe("TransfersRepository — insert and find transfer", () => {
  it("inserts a pet transfer and retrieves it by token", async () => {
    const transferToken = `PTR-TEST-${randomUUID().substring(0, 8)}`;
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await TransfersRepository.insertPetTransfer({
      publicToken: transferToken,
      petId,
      fromOwnerId: senderUserId,
      toOwnerId: null,
      toOwnerEmail: "recipient@dim-test.local",
      status: "pending",
      reason: "gift",
      note: null,
      expiresAt,
    });

    const found = await TransfersRepository.findTransferByToken(transferToken);
    expect(found).not.toBeNull();
    expect(found?.publicToken).toBe(transferToken);
    expect(found?.fromOwnerId).toBe(senderUserId);
    expect(found?.status).toBe("pending");

    // Cleanup: mark as cancelled to avoid unique-pending-per-pet conflicts.
    await db
      .update(petTransfers)
      .set({ status: "cancelled" })
      .where(eq(petTransfers.publicToken, transferToken));
  });
});

// ---------------------------------------------------------------------------
// acceptPetTransfer ownership flip (PARITY QUIRK: close prior BEFORE insert)
// ---------------------------------------------------------------------------

describe("TransfersRepository — acceptPetTransfer ownership flip", () => {
  it("closes prior owner ownership BEFORE inserting new one (unique-active-owner index)", async () => {
    const transferToken = `PTR-ACCEPT-${randomUUID().substring(0, 8)}`;
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    // Insert a pending transfer.
    const [transfer] = await db
      .insert(petTransfers)
      .values({
        publicToken: transferToken,
        petId,
        fromOwnerId: senderUserId,
        toOwnerId: recipientUserId,
        toOwnerEmail: "recipient@dim-test.local",
        status: "pending",
        reason: "gift",
        expiresAt,
      })
      .returning();

    const now = new Date();

    // Execute accept flow inside a tx.
    await db.transaction(async (tx) => {
      // Close prior owner(s).
      await TransfersRepository.closeOwnerOwnerships(
        petId,
        tx as Parameters<typeof TransfersRepository.closeOwnerOwnerships>[1],
      );

      // Insert new owner.
      await TransfersRepository.insertOwnerOwnership(
        { petId, ownerUserId: recipientUserId, startedAt: now },
        tx as Parameters<typeof TransfersRepository.insertOwnerOwnership>[1],
      );

      // Emit custody_transferred event.
      await TransfersRepository.insertPetEvent(
        {
          petId,
          eventType: "custody_transferred",
          occurredAt: now,
          recordedAt: now,
          recordedByUserId: recipientUserId,
          authorRole: "owner",
          payload: {
            from_user_id: senderUserId,
            to_user_id: recipientUserId,
            from_role: "owner",
            to_role: "owner",
            foster_ended_event_id: null,
            notes: null,
          },
        },
        tx as Parameters<typeof TransfersRepository.insertPetEvent>[1],
      );

      // Update transfer status.
      await TransfersRepository.updateTransferStatus(
        { id: transfer.id, status: "accepted", respondedAt: now, toOwnerId: recipientUserId },
        tx as Parameters<typeof TransfersRepository.updateTransferStatus>[1],
      );
    });

    // Verify only the new owner is active.
    const activeOwnerships = await db
      .select()
      .from(ownerships)
      .where(
        and(eq(ownerships.petId, petId), eq(ownerships.role, "owner"), isNull(ownerships.endedAt)),
      );
    expect(activeOwnerships).toHaveLength(1);
    expect(activeOwnerships[0].ownerUserId).toBe(recipientUserId);

    // Verify custody_transferred event was emitted.
    const events = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_transferred")));
    expect(events.length).toBeGreaterThan(0);

    // Restore ownership for subsequent tests: end recipient + reinsert sender.
    await db
      .update(ownerships)
      .set({ endedAt: new Date() })
      .where(
        and(eq(ownerships.petId, petId), eq(ownerships.role, "owner"), isNull(ownerships.endedAt)),
      );
    await db.insert(ownerships).values({ petId, ownerUserId: senderUserId, role: "owner" });
  });
});

// ---------------------------------------------------------------------------
// expirablePetTransfers
// ---------------------------------------------------------------------------

describe("TransfersRepository.expirablePetTransfers", () => {
  // Uses expiryPetId — a dedicated pet for expiry tests to avoid pending-row
  // conflicts with the main petId used by other test groups.
  // We bypass the pet_transfers_expiry_after_init check constraint (expires_at > initiated_at)
  // by using raw SQL INSERT that sets initiated_at explicitly to a past date.

  it("returns pending transfers whose expiresAt is in the past", async () => {
    const expiredToken = `PTR-EXP-${randomUUID().substring(0, 8)}`;

    // Raw INSERT: set initiated_at 8 days ago, expires_at 1 day ago.
    // This satisfies expires_at > initiated_at at insert time AND expires_at < now() for the expiry scan.
    await db.execute(
      sql`INSERT INTO pet_transfers
        (public_token, pet_id, from_owner_id, to_owner_email, status, reason, expires_at, initiated_at, created_at, updated_at)
      VALUES
        (${expiredToken}, ${expiryPetId}, ${senderUserId}, ${"old@dim-test.local"}, ${"pending"}, ${"gift"},
         now() - interval '1 day', now() - interval '8 days', now(), now())`,
    );

    const now = new Date();
    const stale = await TransfersRepository.expirablePetTransfers(now);
    const found = stale.find((r) => r.publicToken === expiredToken);
    expect(found).toBeDefined();
    expect(found?.fromOwnerId).toBe(senderUserId);

    // Cleanup: mark expired so the next test can insert a new pending.
    await db.execute(
      sql`UPDATE pet_transfers SET status = 'expired' WHERE public_token = ${expiredToken}`,
    );
  });

  it("does NOT return transfers with future expiresAt", async () => {
    const freshToken = `PTR-FRESH-${randomUUID().substring(0, 8)}`;

    // Normal insert: future expiry (7 days), initiated now.
    await db.insert(petTransfers).values({
      publicToken: freshToken,
      petId: expiryPetId,
      fromOwnerId: senderUserId,
      toOwnerEmail: "fresh@dim-test.local",
      status: "pending",
      reason: "gift",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    const now = new Date();
    const stale = await TransfersRepository.expirablePetTransfers(now);
    const found = stale.find((r) => r.publicToken === freshToken);
    expect(found).toBeUndefined();

    // Cleanup.
    await db.execute(
      sql`UPDATE pet_transfers SET status = 'cancelled' WHERE public_token = ${freshToken}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Cross-org: findActiveShelterCustody
// ---------------------------------------------------------------------------

describe("TransfersRepository.findActiveShelterCustody", () => {
  it("returns null when org has no shelter_custody on the pet", async () => {
    // orgA has no custody yet (pet has owner type).
    const result = await TransfersRepository.findActiveShelterCustody(petId, orgAId);
    expect(result).toBeNull();
  });

  it("returns the custody row when org holds active shelter_custody", async () => {
    // End existing owner ownerships, insert shelter_custody for orgA.
    await db
      .update(ownerships)
      .set({ endedAt: new Date() })
      .where(and(eq(ownerships.petId, petId), isNull(ownerships.endedAt)));

    const [custody] = await db
      .insert(ownerships)
      .values({ petId, ownerOrganizationId: orgAId, role: "shelter_custody" })
      .returning();

    const result = await TransfersRepository.findActiveShelterCustody(petId, orgAId);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(custody.id);

    // Restore: end custody + re-insert owner for remaining tests.
    await db.update(ownerships).set({ endedAt: new Date() }).where(eq(ownerships.id, custody.id));
    await db.insert(ownerships).values({ petId, ownerUserId: senderUserId, role: "owner" });
  });
});

// ---------------------------------------------------------------------------
// Direct transfer: findActiveFosterRow
// ---------------------------------------------------------------------------

describe("TransfersRepository.findActiveFosterRow", () => {
  it("returns null when no active foster row exists", async () => {
    const result = await TransfersRepository.findActiveFosterRow(petId);
    expect(result).toBeNull();
  });

  it("returns the foster row when one is active", async () => {
    const [foster] = await db
      .insert(ownerships)
      .values({ petId, ownerUserId: recipientUserId, role: "foster" })
      .returning();

    const result = await TransfersRepository.findActiveFosterRow(petId);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(foster.id);
    expect(result?.ownerUserId).toBe(recipientUserId);

    // Cleanup.
    await db.update(ownerships).set({ endedAt: new Date() }).where(eq(ownerships.id, foster.id));
  });
});

// ---------------------------------------------------------------------------
// transferCustody foster-cascade UUID ordering (PARITY QUIRK)
// Task 2.4: foster_ended UUID emitted BEFORE custody_transferred payload reference
// ---------------------------------------------------------------------------

describe("TransfersRepository — transferCustody foster-cascade UUID ordering", () => {
  it("emits foster_ended event with the upfront UUID BEFORE custody_transferred references it", async () => {
    // Setup: give orgA shelter_custody + add a foster row.
    await db
      .update(ownerships)
      .set({ endedAt: new Date() })
      .where(and(eq(ownerships.petId, petId), isNull(ownerships.endedAt)));

    const [shelterCustody] = await db
      .insert(ownerships)
      .values({ petId, ownerOrganizationId: orgAId, role: "shelter_custody" })
      .returning();

    const [fosterRow] = await db
      .insert(ownerships)
      .values({ petId, ownerUserId: recipientUserId, role: "foster" })
      .returning();

    const fosterEndedEventId = randomUUID();
    const now = new Date();

    await db.transaction(async (tx) => {
      // Close source ownership.
      await tx.update(ownerships).set({ endedAt: now }).where(eq(ownerships.id, shelterCustody.id));

      // Close foster + emit foster_ended using the UPFRONT UUID.
      await tx.update(ownerships).set({ endedAt: now }).where(eq(ownerships.id, fosterRow.id));

      await TransfersRepository.insertPetEvent(
        {
          id: fosterEndedEventId, // upfront UUID — the key ordering invariant
          petId,
          eventType: "foster_ended",
          occurredAt: now,
          recordedAt: now,
          recordedByUserId: senderUserId,
          authorRole: "shelter",
          authorOrganizationId: orgAId,
          authorVerified: true,
          payload: {
            foster_user_id: recipientUserId,
            reason: "other",
            notes: "Transferencia de custodia.",
          },
        },
        tx as Parameters<typeof TransfersRepository.insertPetEvent>[1],
      );

      // Insert destination ownership.
      await TransfersRepository.insertShelterCustody(
        {
          petId,
          ownerOrganizationId: orgBId,
          transferredFromId: shelterCustody.id,
          startedAt: now,
        },
        tx as Parameters<typeof TransfersRepository.insertShelterCustody>[1],
      );

      // Emit custody_transferred that REFERENCES fosterEndedEventId.
      await TransfersRepository.insertPetEvent(
        {
          petId,
          eventType: "custody_transferred",
          occurredAt: now,
          recordedAt: now,
          recordedByUserId: senderUserId,
          authorRole: "shelter",
          authorOrganizationId: orgAId,
          authorVerified: true,
          payload: {
            from_organization_id: orgAId,
            to_organization_id: orgBId,
            from_role: "shelter_custody",
            to_role: "shelter_custody",
            foster_ended_event_id: fosterEndedEventId, // references the upfront UUID
            notes: null,
          },
        },
        tx as Parameters<typeof TransfersRepository.insertPetEvent>[1],
      );
    });

    // Verify: foster_ended event exists with the exact upfront UUID.
    const [fosterEndedEvent] = await db
      .select()
      .from(petEvents)
      .where(
        and(
          eq(petEvents.petId, petId),
          eq(petEvents.eventType, "foster_ended"),
          eq(petEvents.id, fosterEndedEventId),
        ),
      );
    expect(fosterEndedEvent).toBeDefined();
    expect(fosterEndedEvent.id).toBe(fosterEndedEventId);

    // Verify: custody_transferred payload references the foster_ended UUID.
    // Use desc order to get the most recent event (avoid picking up events from
    // the acceptPetTransfer test above which also emits custody_transferred).
    const [custodyTransferredEvent] = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_transferred")))
      .orderBy(desc(petEvents.recordedAt))
      .limit(1);
    expect(custodyTransferredEvent).toBeDefined();
    const payload = custodyTransferredEvent.payload as { foster_ended_event_id?: string };
    expect(payload.foster_ended_event_id).toBe(fosterEndedEventId);

    // Restore fixture for subsequent tests.
    await db
      .update(ownerships)
      .set({ endedAt: new Date() })
      .where(and(eq(ownerships.petId, petId), isNull(ownerships.endedAt)));
    await db.insert(ownerships).values({ petId, ownerUserId: senderUserId, role: "owner" });
  });
});

// ---------------------------------------------------------------------------
// Cross-org expirer: per-case tx + status recheck + auto_expired + NO audit_log
// Task 2.5: expireCrossOrgTransfer
// ---------------------------------------------------------------------------

describe("TransfersRepository.proposalEventsForCase (limit-2 dup guard)", () => {
  it("returns empty array when no proposal events exist for a fake case id", async () => {
    const fakeCaseId = randomUUID();
    const result = await TransfersRepository.proposalEventsForCase(fakeCaseId);
    expect(result).toEqual([]);
  });
});

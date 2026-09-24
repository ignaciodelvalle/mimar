// Integration tests for the outgoing transfers query (UX 3.1 dead-ends).
//
// Verifies that the sender-side query:
//   1. Returns transfers where fromOwnerId = current user.
//   2. Returns the correct status (pending, accepted, rejected, expired, cancelled).
//   3. Does NOT return transfers where the current user is the RECIPIENT.
//   4. Does NOT return transfers initiated by a different sender.
//
// Mirrors the pattern from transferencias-inbox.test.ts — direct DB inserts,
// no server-action or auth mock needed (we're testing the query predicate).

import { eq, or } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, ownerships, petTransfers, pets, profiles } from "@/db";
import { withMutationOverride } from "./_helpers/db-overrides";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SENDER_ID = "00000000-0000-0000-0000-0000000b0001";
const RECEIVER_ID = "00000000-0000-0000-0000-0000000b0002";
const OTHER_SENDER_ID = "00000000-0000-0000-0000-0000000b0003";

const PET_TOKEN_OUT1 = "DIM-TRX-OUT-PET1";
const PET_TOKEN_OUT2 = "DIM-TRX-OUT-PET2";
const PET_TOKEN_IN = "DIM-TRX-OUT-PETIN";

const TOKEN_PENDING = "PTR-out-test-pending-001";
const TOKEN_ACCEPTED = "PTR-out-test-accepted-002";
// Transfer from a different sender — must NOT appear in SENDER's outgoing list.
const TOKEN_OTHER_SENDER = "PTR-out-test-other-003";
// Transfer received by SENDER (SENDER is recipient) — must NOT appear in outgoing.
const TOKEN_INCOMING = "PTR-out-test-incoming-004";

let petId1: string;
let petId2: string;
let petIdIn: string;

const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

// Outgoing query: transfers where fromOwnerId = callerId
function queryOutgoing(callerId: string) {
  return db
    .select({
      publicToken: petTransfers.publicToken,
      status: petTransfers.status,
      fromOwnerId: petTransfers.fromOwnerId,
    })
    .from(petTransfers)
    .where(eq(petTransfers.fromOwnerId, callerId));
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Clean up stale fixtures from prior runs.
  await withMutationOverride(async (tx) => {
    await tx
      .delete(petTransfers)
      .where(
        or(
          eq(petTransfers.publicToken, TOKEN_PENDING),
          eq(petTransfers.publicToken, TOKEN_ACCEPTED),
          eq(petTransfers.publicToken, TOKEN_OTHER_SENDER),
          eq(petTransfers.publicToken, TOKEN_INCOMING),
        ),
      );

    for (const token of [PET_TOKEN_OUT1, PET_TOKEN_OUT2, PET_TOKEN_IN]) {
      const stale = await tx.select({ id: pets.id }).from(pets).where(eq(pets.publicToken, token));
      for (const { id } of stale) {
        await tx.delete(ownerships).where(eq(ownerships.petId, id));
        await tx.delete(pets).where(eq(pets.id, id));
      }
    }

    await tx
      .delete(profiles)
      .where(
        or(
          eq(profiles.id, SENDER_ID),
          eq(profiles.id, RECEIVER_ID),
          eq(profiles.id, OTHER_SENDER_ID),
        ),
      );
  });

  // Insert bare profiles.
  for (const [id, name] of [
    [SENDER_ID, "TRX-OUT-SND1"],
    [RECEIVER_ID, "TRX-OUT-RCV1"],
    [OTHER_SENDER_ID, "TRX-OUT-SND2"],
  ] as const) {
    await db
      .insert(profiles)
      .values({ id, displayName: name })
      .onConflictDoNothing({ target: profiles.id });
  }

  // Pet 1 — owned by SENDER, used for pending + accepted outgoing transfers.
  const [p1] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN_OUT1,
      name: "Outgoing Test Pet 1",
      species: "dog",
      sex: "unknown",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petId1 = p1.id;
  await db.insert(ownerships).values({ petId: petId1, ownerUserId: SENDER_ID, role: "owner" });

  // Pet 2 — owned by OTHER_SENDER, used for the other-sender fixture.
  const [p2] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN_OUT2,
      name: "Outgoing Test Pet 2",
      species: "cat",
      sex: "unknown",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petId2 = p2.id;
  await db
    .insert(ownerships)
    .values({ petId: petId2, ownerUserId: OTHER_SENDER_ID, role: "owner" });

  // Pet 3 — owned by OTHER_SENDER, used for incoming transfer (SENDER is recipient).
  const [pIn] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN_IN,
      name: "Incoming Test Pet",
      species: "dog",
      sex: "unknown",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petIdIn = pIn.id;
  await db
    .insert(ownerships)
    .values({ petId: petIdIn, ownerUserId: OTHER_SENDER_ID, role: "owner" });

  // Row 1: SENDER → RECEIVER, pending.
  await db.insert(petTransfers).values({
    publicToken: TOKEN_PENDING,
    petId: petId1,
    fromOwnerId: SENDER_ID,
    toOwnerId: RECEIVER_ID,
    toOwnerEmail: "receiver-out@dim-test.local",
    status: "pending",
    expiresAt,
  });

  // Row 2: SENDER → RECEIVER, accepted (resolved/history).
  // Uses petId1 but status = 'accepted' so it doesn't violate the one-pending-per-pet constraint.
  await db.insert(petTransfers).values({
    publicToken: TOKEN_ACCEPTED,
    petId: petId1,
    fromOwnerId: SENDER_ID,
    toOwnerId: RECEIVER_ID,
    toOwnerEmail: "receiver-out@dim-test.local",
    status: "accepted",
    expiresAt,
    respondedAt: new Date(),
  });

  // Row 3: OTHER_SENDER → RECEIVER, pending (must NOT appear in SENDER's outgoing).
  await db.insert(petTransfers).values({
    publicToken: TOKEN_OTHER_SENDER,
    petId: petId2,
    fromOwnerId: OTHER_SENDER_ID,
    toOwnerId: RECEIVER_ID,
    toOwnerEmail: "receiver-out@dim-test.local",
    status: "pending",
    expiresAt,
  });

  // Row 4: OTHER_SENDER → SENDER (SENDER is the recipient, not the initiator).
  // Must NOT appear in SENDER's outgoing query.
  await db.insert(petTransfers).values({
    publicToken: TOKEN_INCOMING,
    petId: petIdIn,
    fromOwnerId: OTHER_SENDER_ID,
    toOwnerId: SENDER_ID,
    toOwnerEmail: "sender-out@dim-test.local",
    status: "pending",
    expiresAt,
  });
});

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    await tx
      .delete(petTransfers)
      .where(
        or(
          eq(petTransfers.publicToken, TOKEN_PENDING),
          eq(petTransfers.publicToken, TOKEN_ACCEPTED),
          eq(petTransfers.publicToken, TOKEN_OTHER_SENDER),
          eq(petTransfers.publicToken, TOKEN_INCOMING),
        ),
      );
    for (const id of [petId1, petId2, petIdIn].filter(Boolean)) {
      await tx.delete(ownerships).where(eq(ownerships.petId, id));
      await tx.delete(pets).where(eq(pets.id, id));
    }
    await tx
      .delete(profiles)
      .where(
        or(
          eq(profiles.id, SENDER_ID),
          eq(profiles.id, RECEIVER_ID),
          eq(profiles.id, OTHER_SENDER_ID),
        ),
      );
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("outgoing transfers query", () => {
  it("returns the SENDER's pending outgoing transfer", async () => {
    const rows = await queryOutgoing(SENDER_ID);
    const tokens = rows.map((r) => r.publicToken);
    expect(tokens).toContain(TOKEN_PENDING);
  });

  it("returns the SENDER's accepted outgoing transfer", async () => {
    const rows = await queryOutgoing(SENDER_ID);
    const tokens = rows.map((r) => r.publicToken);
    expect(tokens).toContain(TOKEN_ACCEPTED);
  });

  it("does NOT include transfers initiated by a different sender", async () => {
    const rows = await queryOutgoing(SENDER_ID);
    const tokens = rows.map((r) => r.publicToken);
    expect(tokens).not.toContain(TOKEN_OTHER_SENDER);
  });

  it("does NOT include transfers where SENDER is the recipient (not the initiator)", async () => {
    const rows = await queryOutgoing(SENDER_ID);
    const tokens = rows.map((r) => r.publicToken);
    expect(tokens).not.toContain(TOKEN_INCOMING);
  });

  it("all returned rows have fromOwnerId equal to the caller's ID", async () => {
    const rows = await queryOutgoing(SENDER_ID);
    for (const row of rows) {
      expect(row.fromOwnerId).toBe(SENDER_ID);
    }
  });

  it("returns correct status values for each transfer", async () => {
    const rows = await queryOutgoing(SENDER_ID);
    const byToken = Object.fromEntries(rows.map((r) => [r.publicToken, r.status]));
    expect(byToken[TOKEN_PENDING]).toBe("pending");
    expect(byToken[TOKEN_ACCEPTED]).toBe("accepted");
  });
});

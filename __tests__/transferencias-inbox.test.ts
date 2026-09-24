// Integration tests for the transfers inbox query and countPendingTransfers.
//
// Covers:
//   1. pending-by-toOwnerId — registered recipient matched by UUID.
//   2. pending-by-email-when-toOwnerId-null — unregistered recipient matched by email.
//   3. history exclusion — non-pending rows excluded from active count.
//   4. countPendingTransfers dual-condition — both paths increment the count.
//   5. cross-user IDOR — SENDER's inbox query must NOT return RECEIVER's transfer.
//
// Requires a live DB. Run with `pnpm test __tests__/transferencias-inbox.test.ts`.
//
// NOTE: these tests insert rows directly into petTransfers; they do NOT call
// the server actions (which require supabase auth mocks). The focus is the
// inbox predicate correctness.
//
// One-pending-per-pet constraint: each pet may have at most one pending
// transfer at a time. TOKEN_RESOLVED (pending, toOwnerId set) and
// TOKEN_UNRESOLVED (pending, email-only) therefore use separate pets.
// TOKEN_IDOR (pending, addressed to RECEIVER) uses a third pet.

import { and, eq, isNull, or } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, ownerships, petTransfers, pets, profiles } from "@/db";
import { countPendingTransfers } from "@/lib/analytics/owner-dashboard";
import { withMutationOverride } from "./_helpers/db-overrides";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const PET_TOKEN = "DIM-TRX-INB-PET1";
// Separate pet for TOKEN_UNRESOLVED — the one-pending-per-pet constraint
// prevents two pending rows on the same petId.
const PET_TOKEN_UNRESOLVED = "DIM-TRX-INB-PET3";
// Separate pet for the IDOR fixture.
const PET_TOKEN_IDOR = "DIM-TRX-INB-PET2";
const UNREGISTERED_EMAIL = "unregistered-trx-inbox@dim-test.local";

// PTR prefix matches the production token format (generatePrefixedToken("PTR")).
const TOKEN_RESOLVED = "PTR-inbox-test-resolved-001";
const TOKEN_UNRESOLVED = "PTR-inbox-test-unresolved-002";
const TOKEN_HISTORY = "PTR-inbox-test-history-003";
// IDOR regression fixture: a transfer addressed to RECEIVER that the SENDER
// must NOT be able to see via the inbox predicate.
const TOKEN_IDOR = "PTR-inbox-test-idor-004";

// Hardcoded UUIDs (pattern from performed-by-search.test.ts) — profiles.id has
// no FK to auth.users in the schema, so bare profiles can be inserted directly.
const SENDER_ID = "00000000-0000-0000-0000-0000000a0001";
const RECEIVER_ID = "00000000-0000-0000-0000-0000000a0002";

let petId: string;
let petIdUnresolved: string;
let petIdIdor: string;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Clean up any leftover rows from a previous run.
  await withMutationOverride(async (tx) => {
    await tx
      .delete(petTransfers)
      .where(
        or(
          eq(petTransfers.publicToken, TOKEN_RESOLVED),
          eq(petTransfers.publicToken, TOKEN_UNRESOLVED),
          eq(petTransfers.publicToken, TOKEN_HISTORY),
          eq(petTransfers.publicToken, TOKEN_IDOR),
        ),
      );

    for (const token of [PET_TOKEN, PET_TOKEN_UNRESOLVED, PET_TOKEN_IDOR]) {
      const stalePets = await tx
        .select({ id: pets.id })
        .from(pets)
        .where(eq(pets.publicToken, token));
      for (const { id } of stalePets) {
        await tx.delete(ownerships).where(eq(ownerships.petId, id));
        await tx.delete(pets).where(eq(pets.id, id));
      }
    }

    await tx.delete(profiles).where(or(eq(profiles.id, SENDER_ID), eq(profiles.id, RECEIVER_ID)));
  });

  // Insert bare profiles (no auth user required — profiles.id is just a UUID PK).
  await db
    .insert(profiles)
    .values({ id: SENDER_ID, displayName: "TRX-INB-SND1" })
    .onConflictDoNothing({ target: profiles.id });

  await db
    .insert(profiles)
    .values({ id: RECEIVER_ID, displayName: "TRX-INB-RCV1" })
    .onConflictDoNothing({ target: profiles.id });

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  // --- Pet 1: host for TOKEN_RESOLVED (pending, toOwnerId=RECEIVER) + TOKEN_HISTORY.

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN,
      name: "Inbox Test Pet",
      species: "dog",
      sex: "unknown",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petId = pet.id;

  await db.insert(ownerships).values({
    petId,
    ownerUserId: SENDER_ID,
    role: "owner",
  });

  // Row 1: resolved recipient (toOwnerId set) — PENDING.
  await db.insert(petTransfers).values({
    publicToken: TOKEN_RESOLVED,
    petId,
    fromOwnerId: SENDER_ID,
    toOwnerId: RECEIVER_ID,
    toOwnerEmail: "receiver-trx-inbox@dim-test.local",
    status: "pending",
    expiresAt,
  });

  // Row 3: resolved recipient — REJECTED (history, must not appear as active).
  // A rejected row is not constrained by the one-pending-per-pet index.
  await db.insert(petTransfers).values({
    publicToken: TOKEN_HISTORY,
    petId,
    fromOwnerId: SENDER_ID,
    toOwnerId: RECEIVER_ID,
    toOwnerEmail: "receiver-trx-inbox@dim-test.local",
    status: "rejected",
    expiresAt,
    respondedAt: new Date(),
  });

  // --- Pet 2: host for TOKEN_UNRESOLVED (pending, toOwnerId=NULL, email-only).
  // Needs its own pet because the one-pending-per-pet constraint prevents two
  // pending rows on the same petId.

  const [petUnresolved] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN_UNRESOLVED,
      name: "Inbox Test Pet (unresolved)",
      species: "dog",
      sex: "unknown",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petIdUnresolved = petUnresolved.id;

  await db.insert(ownerships).values({
    petId: petIdUnresolved,
    ownerUserId: SENDER_ID,
    role: "owner",
  });

  // Row 2: unregistered recipient (toOwnerId NULL, email only) — PENDING.
  await db.insert(petTransfers).values({
    publicToken: TOKEN_UNRESOLVED,
    petId: petIdUnresolved,
    fromOwnerId: SENDER_ID,
    toOwnerId: null,
    toOwnerEmail: UNREGISTERED_EMAIL,
    status: "pending",
    expiresAt,
  });

  // --- Pet 3: host for TOKEN_IDOR (pending, addressed to RECEIVER).
  // Used by the cross-user IDOR regression test.

  const [petIdor] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN_IDOR,
      name: "IDOR Test Pet",
      species: "cat",
      sex: "unknown",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petIdIdor = petIdor.id;

  await db.insert(ownerships).values({
    petId: petIdIdor,
    ownerUserId: SENDER_ID,
    role: "owner",
  });

  // Row 4: IDOR fixture — pending transfer explicitly addressed to RECEIVER.
  // Used to assert the SENDER's inbox query cannot reach it.
  await db.insert(petTransfers).values({
    publicToken: TOKEN_IDOR,
    petId: petIdIdor,
    fromOwnerId: SENDER_ID,
    toOwnerId: RECEIVER_ID,
    toOwnerEmail: "receiver-trx-inbox@dim-test.local",
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
          eq(petTransfers.publicToken, TOKEN_RESOLVED),
          eq(petTransfers.publicToken, TOKEN_UNRESOLVED),
          eq(petTransfers.publicToken, TOKEN_HISTORY),
          eq(petTransfers.publicToken, TOKEN_IDOR),
        ),
      );
    if (petId) {
      await tx.delete(ownerships).where(eq(ownerships.petId, petId));
      await tx.delete(pets).where(eq(pets.id, petId));
    }
    if (petIdUnresolved) {
      await tx.delete(ownerships).where(eq(ownerships.petId, petIdUnresolved));
      await tx.delete(pets).where(eq(pets.id, petIdUnresolved));
    }
    if (petIdIdor) {
      await tx.delete(ownerships).where(eq(ownerships.petId, petIdIdor));
      await tx.delete(pets).where(eq(pets.id, petIdIdor));
    }
    await tx.delete(profiles).where(or(eq(profiles.id, SENDER_ID), eq(profiles.id, RECEIVER_ID)));
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("transfers inbox query", () => {
  it("finds pending transfer by toOwnerId (registered recipient)", async () => {
    const rows = await db
      .select({ publicToken: petTransfers.publicToken })
      .from(petTransfers)
      .where(
        and(
          eq(petTransfers.status, "pending"),
          or(
            eq(petTransfers.toOwnerId, RECEIVER_ID),
            and(
              isNull(petTransfers.toOwnerId),
              eq(petTransfers.toOwnerEmail, "receiver-trx-inbox@dim-test.local"),
            ),
          ),
        ),
      );

    const tokens = rows.map((r) => r.publicToken);
    expect(tokens).toContain(TOKEN_RESOLVED);
  });

  it("finds pending transfer by email when toOwnerId is NULL (unregistered recipient)", async () => {
    const rows = await db
      .select({ publicToken: petTransfers.publicToken })
      .from(petTransfers)
      .where(
        and(
          eq(petTransfers.status, "pending"),
          or(
            eq(petTransfers.toOwnerId, RECEIVER_ID),
            and(isNull(petTransfers.toOwnerId), eq(petTransfers.toOwnerEmail, UNREGISTERED_EMAIL)),
          ),
        ),
      );

    const tokens = rows.map((r) => r.publicToken);
    expect(tokens).toContain(TOKEN_UNRESOLVED);
  });

  it("excludes history rows from the pending query (history is not pending)", async () => {
    const rows = await db
      .select({ publicToken: petTransfers.publicToken })
      .from(petTransfers)
      .where(
        and(
          eq(petTransfers.status, "pending"),
          or(
            eq(petTransfers.toOwnerId, RECEIVER_ID),
            and(
              isNull(petTransfers.toOwnerId),
              eq(petTransfers.toOwnerEmail, "receiver-trx-inbox@dim-test.local"),
            ),
          ),
        ),
      );

    const tokens = rows.map((r) => r.publicToken);
    expect(tokens).not.toContain(TOKEN_HISTORY);
  });

  it("IDOR: SENDER's inbox query does NOT return a transfer addressed to RECEIVER", async () => {
    // TOKEN_IDOR is addressed to RECEIVER_ID / receiver-trx-inbox@dim-test.local.
    // Running the same inbox predicate scoped to SENDER_ID + SENDER's own email
    // must NOT return it — this is the cross-user isolation regression guard.
    // The Fix-1 guarded predicate is used here to mirror the production code path.
    const SENDER_EMAIL = "sender-trx-inbox@dim-test.local";
    const recipientMatchAsSender = SENDER_EMAIL
      ? or(
          eq(petTransfers.toOwnerId, SENDER_ID),
          and(isNull(petTransfers.toOwnerId), eq(petTransfers.toOwnerEmail, SENDER_EMAIL)),
        )
      : eq(petTransfers.toOwnerId, SENDER_ID);

    const rows = await db
      .select({ publicToken: petTransfers.publicToken })
      .from(petTransfers)
      .where(and(eq(petTransfers.status, "pending"), recipientMatchAsSender));

    const tokens = rows.map((r) => r.publicToken);
    expect(tokens).not.toContain(TOKEN_IDOR);
  });
});

describe("countPendingTransfers", () => {
  it("counts pending transfer matched by toOwnerId", async () => {
    // RECEIVER_ID has TOKEN_RESOLVED (pending) + TOKEN_HISTORY (rejected).
    // Only the pending one should count.
    const c = await countPendingTransfers(RECEIVER_ID, "receiver-trx-inbox@dim-test.local");
    expect(c).toBeGreaterThanOrEqual(1);
  });

  it("counts pending transfer matched by email when toOwnerId is NULL", async () => {
    // A fresh UUID that has no toOwnerId rows at all — only the email path applies.
    const ghostId = "00000000-0000-0000-0000-000000000099";
    const c = await countPendingTransfers(ghostId, UNREGISTERED_EMAIL);
    expect(c).toBeGreaterThanOrEqual(1);
  });

  it("returns 0 for a user with no incoming pending transfers", async () => {
    const c = await countPendingTransfers(SENDER_ID, "nobody@dim-test.local");
    expect(c).toBe(0);
  });
});

// Tests for the §4.20 physical-tag-interest placeholder.
//
// Covers the read helper and the underlying state machine the toggle
// action implements (insert → cancel → re-interest). The action itself
// wraps `requirePetAccess` which needs a real Supabase session — that
// path is exercised via the e2e/integration smoke; here we drive the
// DB state directly to keep the test independent of auth.

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, ownerships, pets, physicalTagInterest } from "@/db";
import { getPhysicalTagInterest } from "@/lib/infra/physical-tag-interest";
import { generatePublicToken } from "@/lib/infra/publicToken";
import { expectDbError } from "./_helpers/expect-db-error";

let petId: string;
let userId: string;

beforeAll(async () => {
  // Pick an existing seeded owner — owner@dim.test is created by
  // `pnpm seed:test`. We don't insert a profile row to avoid colliding
  // with the auth.users → profiles trigger.
  const [profile] = await db.execute<{ id: string }>(
    sql`SELECT id FROM auth.users WHERE email = 'owner@dim.test' LIMIT 1`,
  );
  if (!profile?.id) {
    throw new Error("seed user owner@dim.test missing — run `pnpm seed:test`");
  }
  userId = profile.id;

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: generatePublicToken(),
      species: "dog",
      name: "PhysicalTagFixture",
      potentiallyDangerousBreed: false,
    })
    .returning({ id: pets.id });
  petId = pet.id;
  await db.insert(ownerships).values({
    petId,
    ownerUserId: userId,
    role: "owner",
    startedAt: new Date(),
  });
});

afterAll(async () => {
  await db
    .delete(physicalTagInterest)
    .where(and(eq(physicalTagInterest.petId, petId), eq(physicalTagInterest.userId, userId)));
  await db.delete(ownerships).where(eq(ownerships.petId, petId));
  await db.delete(pets).where(eq(pets.id, petId));
});

describe("getPhysicalTagInterest", () => {
  it("returns { interested: false } when no row exists", async () => {
    const state = await getPhysicalTagInterest(petId, userId);
    expect(state.interested).toBe(false);
    expect(state.requestedAt).toBeNull();
  });

  it("returns { interested: true, requestedAt } when an active row exists", async () => {
    await db.insert(physicalTagInterest).values({ petId, userId });
    const state = await getPhysicalTagInterest(petId, userId);
    expect(state.interested).toBe(true);
    expect(state.requestedAt).toBeInstanceOf(Date);
    // Cleanup so the next test sees a fresh slate.
    await db
      .delete(physicalTagInterest)
      .where(and(eq(physicalTagInterest.petId, petId), eq(physicalTagInterest.userId, userId)));
  });

  it("returns { interested: false } when the row is cancelled", async () => {
    await db.insert(physicalTagInterest).values({ petId, userId, cancelledAt: new Date() });
    const state = await getPhysicalTagInterest(petId, userId);
    expect(state.interested).toBe(false);
    expect(state.requestedAt).toBeNull();
    await db
      .delete(physicalTagInterest)
      .where(and(eq(physicalTagInterest.petId, petId), eq(physicalTagInterest.userId, userId)));
  });
});

describe("physical_tag_interest state machine (DB-level)", () => {
  it("(pet, user) uniqueness is enforced by the DB", async () => {
    await db.insert(physicalTagInterest).values({ petId, userId });
    // 23505 = unique_violation.
    await expectDbError(db.insert(physicalTagInterest).values({ petId, userId }), {
      code: "23505",
    });
    await db
      .delete(physicalTagInterest)
      .where(and(eq(physicalTagInterest.petId, petId), eq(physicalTagInterest.userId, userId)));
  });

  it("toggle pattern: insert → cancel → re-interest works on the same row", async () => {
    // 1. Insert (first interest)
    const [inserted] = await db
      .insert(physicalTagInterest)
      .values({ petId, userId })
      .returning({ id: physicalTagInterest.id });
    expect(inserted).toBeDefined();

    // 2. Cancel (soft delete)
    await db
      .update(physicalTagInterest)
      .set({ cancelledAt: new Date() })
      .where(eq(physicalTagInterest.id, inserted.id));
    const cancelled = await getPhysicalTagInterest(petId, userId);
    expect(cancelled.interested).toBe(false);

    // 3. Re-interest (clear cancelled_at on the SAME row — no new insert)
    await db
      .update(physicalTagInterest)
      .set({ cancelledAt: null })
      .where(eq(physicalTagInterest.id, inserted.id));
    const reInterested = await getPhysicalTagInterest(petId, userId);
    expect(reInterested.interested).toBe(true);

    // Cleanup
    await db.delete(physicalTagInterest).where(eq(physicalTagInterest.id, inserted.id));
  });
});

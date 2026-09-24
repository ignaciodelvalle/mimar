// Integration guard for the /gob/disputas list (PR-3).
//
// The govt custody-dispute list reads the dedicated `custody_disputes` table
// (innerJoin pets), NOT `cases` where kind='custody_dispute'. In production a
// dispute is created in lockstep with its case (ARCH-E): a
// custody_dispute_raised pet_event -> a custody_disputes row -> the case links
// back via custody_dispute_id. seed-panorama originally created only the `cases`
// half, so /gob/disputas was empty for EVERYONE (admin included) while
// /gob/analytics (which counts the cases) showed 5. Admin sees all rows in the
// page (no scope filter), so the empty list was a data gap, not a scope bug.
//
// This pins the data contract the seed must satisfy: a properly-raised dispute
// with a live pet is returned by the list query (the innerJoin does not drop it)
// and surfaces as an open dispute.

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { custodyDisputes, db, petEvents, pets } from "@/db";
import { withMutationOverride } from "./_helpers/db-overrides";

const PET_TOKEN = "DIM-PR3-DISP-PET";
const DISPUTE_TOKEN = "DIS-PR3-0001";
let petId: string;

beforeAll(async () => {
  // Deleting the pet cascades custody_disputes (pet_id ON DELETE CASCADE) and
  // pet_events, so this idempotent cleanup clears any leftover from a prior run.
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`DELETE FROM pets WHERE public_token = ${PET_TOKEN}`);
  });

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN,
      name: "PR3 Disputa Pet",
      species: "dog",
      sex: "female",
      potentiallyDangerousBreed: false,
      jurisdictionCountry: "AR",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
    })
    .returning();
  petId = pet.id;

  const [raising] = await db
    .insert(petEvents)
    .values({
      petId,
      eventType: "custody_dispute_raised",
      occurredAt: new Date("2026-05-01T00:00:00.000Z"),
      authorRole: "govt",
      payload: { source: "pr3-test" },
    })
    .returning({ id: petEvents.id });

  await db.insert(custodyDisputes).values({
    publicToken: DISPUTE_TOKEN,
    petId,
    raisedByRole: "govt",
    raisingEventId: raising.id,
    jurisdictionCountry: "AR",
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "La Plata",
    status: "open",
  });
});

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`DELETE FROM pets WHERE public_token = ${PET_TOKEN}`);
  });
});

describe("/gob/disputas list query — a properly-raised dispute is visible (PR-3)", () => {
  it("custody_disputes innerJoin pets returns the open dispute (not dropped by the join)", async () => {
    // The exact join shape the page runs; admin sees all rows (no scope filter).
    const rows = await db
      .select({ dispute: custodyDisputes, pet: pets })
      .from(custodyDisputes)
      .innerJoin(pets, eq(pets.id, custodyDisputes.petId))
      .where(eq(custodyDisputes.publicToken, DISPUTE_TOKEN));

    expect(rows).toHaveLength(1);
    expect(rows[0].dispute.status).toBe("open");
    expect(rows[0].pet.publicToken).toBe(PET_TOKEN);
  });
});

// lib/metrics/movement.test.ts — integration tests for fetchMovementCorridors.
//
// Seeds synthetic movement_recorded events (all three sub_kinds, one outside the
// period) and asserts the total + per-sub_kind decomposition and the period bound.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, petEvents, pets } from "@/db";
import { buildProjectionContext } from "@/lib/metrics";
import { windows } from "@/lib/metrics/period";
import { withMutationOverride } from "../../__tests__/_helpers/db-overrides";
import { fetchMovementCorridors } from "./movement";

const TEST_PROVINCE = "Mendoza";
const TEST_LOCALITY = "MovementCorridorsVille";
const TOKEN = "MOV-COR-TST-1";

const DAY_MS = 24 * 60 * 60 * 1000;
let petId: string;

async function cleanup() {
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`
      DELETE FROM pet_events
      WHERE pet_id IN (SELECT id FROM pets WHERE public_token = ${TOKEN})
    `);
    await tx.execute(sql`DELETE FROM pets WHERE public_token = ${TOKEN}`);
  });
}

async function seedMovement(subKind: string, occurredAt: Date) {
  await db.insert(petEvents).values({
    petId,
    eventType: "movement_recorded",
    occurredAt,
    payload: { payload_version: 1, sub_kind: subKind },
    authorRole: "owner",
    recordedByUserId: null,
  });
}

beforeAll(async () => {
  await cleanup();
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: TOKEN,
      name: "MoverDog",
      species: "dog",
      status: "active",
      jurisdictionProvince: TEST_PROVINCE,
      jurisdictionLocality: TEST_LOCALITY,
    })
    .returning({ id: pets.id });
  petId = pet.id;

  const recent = new Date(Date.now() - 5 * DAY_MS);
  await seedMovement("jurisdiction_changed", recent);
  await seedMovement("jurisdiction_changed", recent);
  await seedMovement("cvi_issued", recent);
  await seedMovement("transport_recorded", recent);
  // Outside the trailing-12m window — must not count.
  await seedMovement("jurisdiction_changed", new Date(Date.now() - 400 * DAY_MS));
});

afterAll(cleanup);

describe("fetchMovementCorridors", () => {
  it("returns zeros for an empty govt scope without hitting the DB", async () => {
    const ctx = buildProjectionContext({ role: "govt" }, [], windows.trailing12m());
    const result = await fetchMovementCorridors(ctx);
    expect(result).toEqual({
      total: 0,
      jurisdictionChanged: 0,
      cviIssued: 0,
      transportRecorded: 0,
    });
  });

  it("counts in-window movements decomposed by sub_kind", async () => {
    const ctx = buildProjectionContext(
      { role: "govt" },
      [{ province: TEST_PROVINCE, locality: TEST_LOCALITY }],
      windows.trailing12m(),
    );
    const result = await fetchMovementCorridors(ctx);

    expect(result.total).toBe(4);
    expect(result.jurisdictionChanged).toBe(2);
    expect(result.cviIssued).toBe(1);
    expect(result.transportRecorded).toBe(1);
  });
});

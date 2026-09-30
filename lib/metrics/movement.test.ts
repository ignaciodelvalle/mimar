// lib/metrics/movement.test.ts — integration tests for fetchMovementCorridors.
//
// Seeds synthetic movement_recorded events (all three sub_kinds, one outside the
// period) and asserts the total + per-sub_kind decomposition and the period bound,
// plus the travel small-cell rule (viajes-fase-2, D8): a CVI or transport count
// below ANONYMITY_K never publishes, and neither does a total that would reveal it.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, petEvents, pets } from "@/db";
import { buildProjectionContext } from "@/lib/metrics";
import { windows } from "@/lib/metrics/period";
import { withMutationOverride } from "../../__tests__/_helpers/db-overrides";
import { ANONYMITY_K } from "./anonymity";
import { fetchMovementCorridors, formatMovementCount, suppressTravelCounts } from "./movement";

const TEST_PROVINCE = "Mendoza";
const TEST_LOCALITY = "MovementCorridorsVille";
const TOKEN = "MOV-COR-TST-1";
// A second locality with travel counts AT the floor, so publication is proven
// too — a rule that suppressed everything would pass the first case alone.
const BUSY_LOCALITY = "MovementCorridorsBusy";
const BUSY_TOKEN = "MOV-COR-TST-2";

const DAY_MS = 24 * 60 * 60 * 1000;
let petId: string;

async function cleanup() {
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`
      DELETE FROM pet_events
      WHERE pet_id IN (SELECT id FROM pets WHERE public_token IN (${TOKEN}, ${BUSY_TOKEN}))
    `);
    await tx.execute(sql`DELETE FROM pets WHERE public_token IN (${TOKEN}, ${BUSY_TOKEN})`);
  });
}

let busyPetId: string;

async function seedMovement(subKind: string, occurredAt: Date, onPet: string = petId) {
  await db.insert(petEvents).values({
    petId: onPet,
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

  const [busy] = await db
    .insert(pets)
    .values({
      publicToken: BUSY_TOKEN,
      name: "BusyMover",
      species: "dog",
      status: "active",
      jurisdictionProvince: TEST_PROVINCE,
      jurisdictionLocality: BUSY_LOCALITY,
    })
    .returning({ id: pets.id });
  busyPetId = busy.id;
  for (let i = 0; i < ANONYMITY_K; i++) {
    await seedMovement("cvi_issued", recent, busyPetId);
    await seedMovement("transport_recorded", recent, busyPetId);
  }
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

  it("counts in-window movements and suppresses travel counts below the floor", async () => {
    const ctx = buildProjectionContext(
      { role: "govt" },
      [{ province: TEST_PROVINCE, locality: TEST_LOCALITY }],
      windows.trailing12m(),
    );
    const result = await fetchMovementCorridors(ctx);

    // Two relocations publish — they are not travel facts. One CVI and one
    // transport do not, and the total (4) would give back their sum.
    expect(result.jurisdictionChanged).toBe(2);
    expect(result.cviIssued).toBeNull();
    expect(result.transportRecorded).toBeNull();
    expect(result.total).toBeNull();
  });

  it("publishes travel counts at the floor", async () => {
    const ctx = buildProjectionContext(
      { role: "govt" },
      [{ province: TEST_PROVINCE, locality: BUSY_LOCALITY }],
      windows.trailing12m(),
    );
    const result = await fetchMovementCorridors(ctx);

    expect(result).toEqual({
      total: 2 * ANONYMITY_K,
      jurisdictionChanged: 0,
      cviIssued: ANONYMITY_K,
      transportRecorded: ANONYMITY_K,
    });
  });
});

describe("suppressTravelCounts", () => {
  it("withholds the total when one suppressed cell could be subtracted back out", () => {
    expect(
      suppressTravelCounts({
        total: 12,
        jurisdictionChanged: 5,
        cviIssued: 6,
        transportRecorded: 1,
      }),
    ).toEqual({ total: null, jurisdictionChanged: 5, cviIssued: 6, transportRecorded: null });
  });

  it("keeps the total when the suppressed cells together reach the floor", () => {
    // 3 + 3 hides behind the total as a sum of 6, and neither cell is readable.
    expect(
      suppressTravelCounts({
        total: 10,
        jurisdictionChanged: 4,
        cviIssued: 3,
        transportRecorded: 3,
      }),
    ).toEqual({ total: 10, jurisdictionChanged: 4, cviIssued: null, transportRecorded: null });
  });

  it("treats a zero as public — an empty cell identifies nobody", () => {
    expect(
      suppressTravelCounts({
        total: 2,
        jurisdictionChanged: 2,
        cviIssued: 0,
        transportRecorded: 0,
      }),
    ).toEqual({ total: 2, jurisdictionChanged: 2, cviIssued: 0, transportRecorded: 0 });
  });

  it("never suppresses relocations, however few", () => {
    expect(
      suppressTravelCounts({ total: 1, jurisdictionChanged: 1, cviIssued: 0, transportRecorded: 0 })
        .jurisdictionChanged,
    ).toBe(1);
  });

  it("renders a suppressed count as below the floor", () => {
    expect(formatMovementCount(null)).toBe(`<${ANONYMITY_K}`);
    expect(formatMovementCount(7)).toBe("7");
  });
});

// lib/metrics/deworming.test.ts — integration tests for fetchDewormingCoverage.
//
// Seeds synthetic pets + deworming_administered events against the local Postgres
// (bootstrapped schema) and asserts the coverage numerator/denominator and the
// FIXED trailing-12m window boundary. DB-free guard test for the empty scope.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, petEvents, pets } from "@/db";
import { buildProjectionContext } from "@/lib/metrics";
import { windows } from "@/lib/metrics/period";
import { withMutationOverride } from "../../__tests__/_helpers/db-overrides";
import { fetchDewormingCoverage } from "./deworming";

const TEST_PROVINCE = "Santa Fe";
const TEST_LOCALITY = "DewormCoverageVille";
const TOKEN_PREFIX = "DWM-COV-TST";

const DAY_MS = 24 * 60 * 60 * 1000;

async function cleanup() {
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`
      DELETE FROM pet_events
      WHERE pet_id IN (SELECT id FROM pets WHERE public_token LIKE ${`${TOKEN_PREFIX}-%`})
    `);
    await tx.execute(sql`
      DELETE FROM pets WHERE public_token LIKE ${`${TOKEN_PREFIX}-%`}
    `);
  });
}

async function seedPet(suffix: string): Promise<string> {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: `${TOKEN_PREFIX}-${suffix}`,
      name: `Dewormer-${suffix}`,
      species: "dog",
      status: "active",
      jurisdictionProvince: TEST_PROVINCE,
      jurisdictionLocality: TEST_LOCALITY,
    })
    .returning({ id: pets.id });
  return pet.id;
}

async function seedDeworming(petId: string, occurredAt: Date) {
  await db.insert(petEvents).values({
    petId,
    eventType: "deworming_administered",
    occurredAt,
    payload: { payload_version: 1, product: "Praziquantel", type: "internal", next_due_at: null },
    authorRole: "owner",
    recordedByUserId: null,
  });
}

beforeAll(async () => {
  await cleanup();
  // Pet A: dewormed 30 days ago (inside the trailing-12m window).
  const petA = await seedPet("A");
  await seedDeworming(petA, new Date(Date.now() - 30 * DAY_MS));
  // Pet B: no deworming at all.
  await seedPet("B");
  // Pet C: dewormed 400 days ago (OUTSIDE the trailing-12m window).
  const petC = await seedPet("C");
  await seedDeworming(petC, new Date(Date.now() - 400 * DAY_MS));
});

afterAll(cleanup);

describe("fetchDewormingCoverage", () => {
  it("returns zeros for an empty govt scope without hitting the DB", async () => {
    const ctx = buildProjectionContext({ role: "govt" }, [], windows.trailing12m());
    const result = await fetchDewormingCoverage(ctx);
    expect(result).toEqual({ rate: 0, dewormed: 0, total: 0, byProvince: [] });
  });

  it("counts only in-window dewormings over the full active population", async () => {
    const ctx = buildProjectionContext(
      { role: "govt" },
      [{ province: TEST_PROVINCE, locality: TEST_LOCALITY }],
      windows.trailing12m(),
    );
    const result = await fetchDewormingCoverage(ctx);

    // 3 active pets in scope; only pet A has an in-window deworming (pet C's is
    // 400 days old → excluded from the numerator, included in the denominator).
    expect(result.total).toBe(3);
    expect(result.dewormed).toBe(1);
    expect(result.rate).toBe(33.3);

    const provinceRow = result.byProvince.find((r) => r.province === TEST_PROVINCE);
    expect(provinceRow?.total).toBe(3);
    expect(provinceRow?.dewormed).toBe(1);
  });
});

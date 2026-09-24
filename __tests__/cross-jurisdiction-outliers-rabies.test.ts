// CAM-B2 — fetchCrossJurisdictionOutliers counts rabies by vaccine_name (not the
// drifted vaccine_type='antirabica'). Real/seed events carry "Antirrábica" in
// vaccine_name and leave vaccine_type null, so the old predicate read 0% rabies
// everywhere while the KPIs/map showed real values. This guards the alignment.
//
// Integration test — local Supabase + Postgres. Govt scope to a SYNTHETIC
// locality so only this test's dogs are in scope (the national seed fills every
// real province; outliers group by province but the scope filters province+loc).

import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, petEvents, pets } from "@/db";
import { buildProjectionContext, fetchCrossJurisdictionOutliers } from "@/lib/metrics";
import { windows } from "@/lib/metrics/period";
import { withMutationOverride } from "./_helpers/db-overrides";

const PROVINCE = "Santa Fe";
const LOCALITY = "OUTLIER-RABIES-ISO";

const fixtureIds: string[] = [];

async function insertDog(token: string): Promise<string> {
  const [row] = await db
    .insert(pets)
    .values({
      publicToken: token,
      name: token,
      species: "dog",
      sex: "male",
      status: "active",
      jurisdictionProvince: PROVINCE,
      jurisdictionLocality: LOCALITY,
    })
    .returning({ id: pets.id });
  fixtureIds.push(row.id);
  return row.id;
}

async function vaccinateRabies(petId: string, occurredAt = new Date()): Promise<void> {
  await db.insert(petEvents).values({
    petId,
    eventType: "vaccination_administered",
    occurredAt,
    // Canonical form name in vaccine_name; vaccine_type deliberately absent — the
    // shape real events + the seed produce.
    payload: { payload_version: 1, vaccine_name: "Antirrábica" },
    authorRole: "vet",
    recordedByUserId: null,
  });
}

const DAYS_400_AGO = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);

async function cleanup() {
  if (fixtureIds.length === 0) return;
  await withMutationOverride(async (tx) => {
    await tx.delete(petEvents).where(inArray(petEvents.petId, fixtureIds));
  });
  await db.delete(pets).where(inArray(pets.id, fixtureIds));
  fixtureIds.length = 0;
}

beforeAll(async () => {
  await cleanup();
  // 6 dogs (>= K_ANON_MIN) so the province row isn't suppressed. 3 vaccinated
  // in-window; 1 vaccinated 400 days ago (OUT of the trailing-12m window); 2 never.
  const dogs = await Promise.all(
    ["RABIES-A", "RABIES-B", "RABIES-C", "RABIES-D", "RABIES-E", "RABIES-F"].map((t) =>
      insertDog(`DIM-OUT-${t}`),
    ),
  );
  await vaccinateRabies(dogs[0]);
  await vaccinateRabies(dogs[1]);
  await vaccinateRabies(dogs[2]);
  // Out-of-window: this dog's ONLY rabies vaccination is > 12 months old, so it
  // must count in the DENOMINATOR (a dog in scope) but NOT the numerator (C3).
  await vaccinateRabies(dogs[3], DAYS_400_AGO);
});

afterAll(cleanup);

describe("fetchCrossJurisdictionOutliers — rabies counts vaccine_name (CAM-B2)", () => {
  it("reports a non-zero rabies rate for dogs vaccinated by vaccine_name only", async () => {
    const ctx = buildProjectionContext(
      { role: "govt" },
      [{ province: PROVINCE, locality: LOCALITY }],
      windows.trailing12m(),
    );
    const rows = await fetchCrossJurisdictionOutliers(ctx);
    const rabies = rows.find((r) => r.province === PROVINCE && r.metric === "rabies");

    expect(rabies).toBeDefined();
    // 3 in-window vaccinated of 6 dogs → 50%. The 400-day-old vaccination is
    // EXCLUDED (trailing-12m window, C3); under the pre-C3 all-time predicate it
    // would have counted → 4/6 = 66.7%.
    expect(rabies?.rate).toBe(50);
  });
});

// Regression: the perdidas + mordeduras panorama loaders must count REAL
// production events, not the demo-only payload shape the seed used to inject.
//
// Root cause (pre-pilot blocker): the loaders filtered/grouped by payload keys
// no production writer emits —
//   - perdidas keyed on `payload->>'kind' IN ('pet_lost','pet_found_sighting')`
//     but a pet marked lost is `status_changed` with `payload.to_status='lost'`
//     and a sighting is `note_added` with `payload.kind='sighting'`.
//   - both grouped/scoped by flat `payload->>'province'/'locality'`, which the
//     strict zod schemas never write (geography lives on the pet).
// So in a real district, real lost/sighting/bite events were INVISIBLE — only
// the raw-insert seed (which bypassed zod) rendered.
//
// This test inserts events through the ACTUAL validateEventPayload path (the
// same call every writer uses) with NO 'kind'/'province' payload keys, and
// asserts the loaders now attribute + count them via the JOIN to pets.
//
// #40b: the fixture seeds ABOVE k=5 per layer. It used to seed 2 perdidas events
// and 1 bite, and assert the province cell published "2" and "1" — written when
// province grain was exempt from k-anon. That exemption is retired (the count on a
// density layer IS the protected population), so those assertions were pinning a
// sub-k disclosure. The regression under test — real-shaped events are ATTRIBUTED
// and COUNTED — is unchanged; only the fixture clears the threshold.
//
// Integration test — local Supabase + Postgres. Govt scope to a SYNTHETIC
// locality so only this test's pet is in scope (the national seed fills every
// real province).

import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, petEvents, pets } from "@/db";
import type { EventType } from "@/db/schema";
import { validateEventPayload } from "@/lib/events/event-schemas";
import type { DashboardActor, DashboardJurisdiction } from "@/lib/metrics";

import { withMutationOverride } from "../../../../../__tests__/_helpers/db-overrides";
import { loadMordedurassByUnit, loadPerdidasByUnit, loadUnitHistory } from "../repository";

const PROVINCE = "Santa Fe";
const LOCALITY = "PANORAMA-LF-ISO"; // synthetic — no seed collision
const GOVT: DashboardActor = { role: "govt" };
const JURS: DashboardJurisdiction[] = [{ province: PROVINCE, locality: LOCALITY }];
const SINCE = new Date(Date.now() - 24 * 60 * 60 * 1000);

let petId = "";

async function insertEvent(eventType: EventType, payload: Record<string, unknown>): Promise<void> {
  await db.insert(petEvents).values({
    petId,
    eventType,
    occurredAt: new Date(),
    // Same validated path every real writer uses — proves the loader keys on the
    // production shape, not the seed's raw-insert shape.
    payload: validateEventPayload(eventType, payload) as Record<string, unknown>,
    authorRole: "owner",
    recordedByUserId: null,
  });
}

async function cleanup(): Promise<void> {
  if (!petId) return;
  await withMutationOverride(async (tx) => {
    await tx.delete(petEvents).where(inArray(petEvents.petId, [petId]));
  });
  await db.delete(pets).where(inArray(pets.id, [petId]));
  petId = "";
}

beforeAll(async () => {
  await cleanup();
  const [row] = await db
    .insert(pets)
    .values({
      publicToken: "DIM-PANO-LF-TEST",
      name: "PANO-LF-Test",
      species: "dog",
      sex: "male",
      status: "active",
      jurisdictionProvince: PROVINCE,
      jurisdictionLocality: LOCALITY,
    })
    .returning({ id: pets.id });
  petId = row.id;

  // REAL lost markings — status_changed, to_status='lost', NO payload kind/province.
  // REAL sightings — note_added, kind='sighting'.
  // 3 of each = 6 perdidas events, clearing the k=5 province guard.
  for (let i = 0; i < 3; i++) {
    await insertEvent("status_changed", { from_status: "active", to_status: "lost" });
    await insertEvent("note_added", { category: "otro", text: `avistaje ${i}`, kind: "sighting" });
  }
  // REAL bites — incident_reported, incident_type='bite_inflicted'. 5 of them so
  // the mordeduras cell clears k=5 too (the guard counts DISTINCT events).
  for (let i = 0; i < 5; i++) {
    await insertEvent("incident_reported", {
      incident_type: "bite_inflicted",
      severity: "moderate",
      injuries_summary: `mordedura test ${i}`,
      vet_involved: true,
    });
  }
  // Distractor — a recovery (to_status='active') must NOT count as perdidas.
  await insertEvent("status_changed", { from_status: "lost", to_status: "active" });
});

afterAll(cleanup);

describe("perdidas loader counts REAL lost + sighting events (schema-drift regression)", () => {
  it("loadPerdidasByUnit attributes them to the pet's province and counts 6", async () => {
    const res = await loadPerdidasByUnit("province", GOVT, JURS, SINCE);
    const cell = res.cells.find((c) => c.province === PROVINCE);
    expect(cell).toBeDefined();
    // 3 lost + 3 sightings = 6. The recovery (to_status='active') is excluded.
    expect(cell?.count).toBe(6);
    // Above k, so the cell publishes its real count rather than a hatch.
    expect(cell?.suppressed).toBe(false);
    expect(res.suppressedCount).toBe(0);
  }, 30_000);

  it("loadUnitHistory('perdidas') returns both the lost marking and the sighting", async () => {
    const hist = await loadUnitHistory({
      layer: "perdidas",
      province: PROVINCE,
      locality: null,
      since: SINCE,
      until: new Date(),
      actor: GOVT,
      jurisdictions: JURS,
    });
    const types = hist.events.map((e) => e.type);
    expect(types).toContain("pet_lost");
    expect(types).toContain("pet_found_sighting");
    // Trend sparkline is populated (both events land in today's bucket).
    expect(hist.trend.reduce((s, b) => s + b.count, 0)).toBeGreaterThanOrEqual(2);
  }, 30_000);
});

describe("mordeduras loader counts REAL bite events (schema-drift regression)", () => {
  it("loadMordedurassByUnit attributes the bites to the pet's province and counts 5", async () => {
    const res = await loadMordedurassByUnit("province", GOVT, JURS, SINCE);
    const cell = res.cells.find((c) => c.province === PROVINCE);
    expect(cell).toBeDefined();
    expect(cell?.count).toBe(5);
    expect(cell?.suppressed).toBe(false);
    expect(res.suppressedCount).toBe(0);
  }, 30_000);

  it("loadUnitHistory('mordeduras') returns the bite incident", async () => {
    const hist = await loadUnitHistory({
      layer: "mordeduras",
      province: PROVINCE,
      locality: null,
      since: SINCE,
      until: new Date(),
      actor: GOVT,
      jurisdictions: JURS,
    });
    expect(hist.events.map((e) => e.type)).toContain("bite_inflicted");
  }, 30_000);
});

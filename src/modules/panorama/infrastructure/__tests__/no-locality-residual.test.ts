// Regression (WARNING 4): the aggregated-point loaders must count events whose
// HOME jurisdiction has a province but NO locality into `noLocalityCount` — the
// same reconciliation residual the choropleth path exposes. Without it, those
// events are silently dropped from the locality/detail tier while the province
// total (and the KPIs) still include them, so the two aggregation levels disagree.
//
// Deterministic via a before/after DELTA on the residual so the national seed's
// baseline (0 in practice, but not asserted) cannot make the test flaky.
//
// Integration test — local Supabase + Postgres.

import { inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { db, petEvents, pets } from "@/db";
import type { EventType } from "@/db/schema";
import { validateEventPayload } from "@/lib/events/event-schemas";
import type { DashboardActor, DashboardJurisdiction } from "@/lib/metrics";

import { withMutationOverride } from "../../../../../__tests__/_helpers/db-overrides";
import { loadPerdidasByUnit } from "../repository";

const PROVINCE = "Santa Fe";
const ADMIN: DashboardActor = { role: "admin" };
const JURS: DashboardJurisdiction[] = [];
const SINCE = new Date(Date.now() - 24 * 60 * 60 * 1000);

let petId = "";

async function cleanup(): Promise<void> {
  if (!petId) return;
  await withMutationOverride(async (tx) => {
    await tx.delete(petEvents).where(inArray(petEvents.petId, [petId]));
  });
  await db.delete(pets).where(inArray(pets.id, [petId]));
  petId = "";
}

afterAll(cleanup);

describe("aggregated-point loaders count the province-set/locality-null residual (WARNING 4)", () => {
  it("a pet with a province but no locality lands in noLocalityCount, not the detail tier", async () => {
    const before = await loadPerdidasByUnit("locality", ADMIN, JURS, SINCE);

    // A pet homed in a province but with NO locality + one sighting in-window.
    const [row] = await db
      .insert(pets)
      .values({
        publicToken: "DIM-PANO-NOLOC",
        name: "PANO-NoLoc",
        species: "dog",
        sex: "male",
        status: "active",
        jurisdictionProvince: PROVINCE,
        jurisdictionLocality: null,
      })
      .returning({ id: pets.id });
    petId = row.id;
    await db.insert(petEvents).values({
      petId,
      eventType: "note_added" as EventType,
      occurredAt: new Date(),
      payload: validateEventPayload("note_added", {
        category: "otro",
        text: "avistaje",
        kind: "sighting",
      }) as Record<string, unknown>,
      authorRole: "owner",
      recordedByUserId: null,
    });

    const after = await loadPerdidasByUnit("locality", ADMIN, JURS, SINCE);

    // The residual grows by exactly one; the detail-tier cells do NOT gain a cell
    // for this pet (it has no locality to plot).
    expect(after.noLocalityCount - before.noLocalityCount).toBe(1);
    expect(after.cells.length).toBe(before.cells.length);
  }, 30_000);
});

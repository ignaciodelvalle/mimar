// Regression: the zoonosis + bite-point + outbreak-point panorama surfaces must
// surface REAL production events for a SCOPED govt actor — not only the raw-insert
// seed rows the loaders used to key on. Sibling to perdidas-mordeduras-real-events;
// closes the same "ghost-payload" schema-drift class on the remaining surfaces.
//
// Root cause (pre-pilot blocker):
//   - loadBiteEvents (point layer) scoped via petEventsScope, i.e. the payload
//     keys pet_jurisdiction_*, which incident_reported NEVER writes — so a scoped
//     govt actor saw ZERO real bites on the map. Fixed to petsScope + JOIN pets.
//   - loadZoonosisByUnit + loadUnitHistory('zoonosis') grouped/filtered by flat
//     payload province/locality, which outbreak_signal NEVER writes — it snapshots
//     pet_jurisdiction_province/locality instead. Fixed to key on the snapshot.
//   - loadOutbreakSignals already scoped by pet_jurisdiction_* (VALID — outbreak_signal
//     is the one event type that legitimately carries them); guarded here so it stays.
//
// All events are inserted through the ACTUAL validateEventPayload path (the same
// call every writer uses). Govt is scoped to a SYNTHETIC locality so only this
// test's pet is in scope (the national seed fills every real locality).
//
// Integration test — local Supabase + Postgres.

import { randomUUID } from "node:crypto";

import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, petEvents, pets } from "@/db";
import type { EventType } from "@/db/schema";
import { writePoint } from "@/lib/domain/location";
import { validateEventPayload } from "@/lib/events/event-schemas";
import type { DashboardActor, DashboardJurisdiction } from "@/lib/metrics";

import { withMutationOverride } from "../../../../../__tests__/_helpers/db-overrides";
import {
  loadBiteEvents,
  loadOutbreakSignals,
  loadUnitHistory,
  loadZoonosisByUnit,
} from "../repository";

const PROVINCE = "Santa Fe";
const LOCALITY = "PANORAMA-ZOON-ISO"; // synthetic — no seed collision
const COORD = { lat: -32.9468, lng: -60.6393 }; // Rosario-ish; only needs to be non-null
const GOVT: DashboardActor = { role: "govt" };
const JURS: DashboardJurisdiction[] = [{ province: PROVINCE, locality: LOCALITY }];
const SINCE = new Date(Date.now() - 24 * 60 * 60 * 1000);

let petId = "";

async function insertEvent(
  eventType: EventType,
  payload: Record<string, unknown>,
  located = false,
): Promise<void> {
  await db.insert(petEvents).values({
    petId,
    eventType,
    occurredAt: new Date(),
    payload: validateEventPayload(eventType, payload) as Record<string, unknown>,
    authorRole: "system",
    recordedByUserId: null,
    // Point layers (loadBiteEvents / loadOutbreakSignals) require a coordinate.
    ...(located ? writePoint(COORD) : {}),
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
      publicToken: "DIM-PANO-ZOON-TEST",
      name: "PANO-Zoon-Test",
      species: "dog",
      sex: "male",
      status: "active",
      jurisdictionProvince: PROVINCE,
      jurisdictionLocality: LOCALITY,
    })
    .returning({ id: pets.id });
  petId = row.id;

  // REAL bite — incident_reported. Carries NO jurisdiction in its payload; scoped
  // via the pet's home jurisdiction (petsScope + JOIN pets). Located (point layer).
  await insertEvent(
    "incident_reported",
    {
      incident_type: "bite_inflicted",
      severity: "moderate",
      injuries_summary: "mordedura test",
      vet_involved: true,
    },
    true,
  );

  // REAL outbreak_signal — the ONE event type that legitimately snapshots the pet's
  // jurisdiction into pet_jurisdiction_*. Located (point layer). direct_diagnosis
  // path so the strict schema's source-event refinement is satisfied.
  await insertEvent(
    "outbreak_signal",
    {
      triggered_by: "direct_diagnosis",
      source_symptom_event_id: null,
      source_disease_diagnosis_event_id: randomUUID(),
      disease_code: "rabies_suspected",
      disease_label: "Rabia (sospechada)",
      match_strength: {
        high_count: 0,
        medium_count: 0,
        low_count: 0,
        matched_symptom_codes: [],
      },
      pet_jurisdiction_country: "AR",
      pet_jurisdiction_province: PROVINCE,
      pet_jurisdiction_locality: LOCALITY,
      pet_species: "dog",
    },
    true,
  );
});

afterAll(cleanup);

describe("bite point layer counts REAL incident_reported events for a scoped govt actor", () => {
  it("loadBiteEvents returns the real bite (petsScope + JOIN pets, not payload scope)", async () => {
    const res = await loadBiteEvents(GOVT, JURS, SINCE);
    expect(res.rows.length).toBeGreaterThanOrEqual(1);
    expect(res.rows.some((r) => r.incidentType === "bite_inflicted")).toBe(true);
  }, 30_000);
});

describe("outbreak/zoonosis surfaces count REAL outbreak_signal events (schema-drift regression)", () => {
  it("loadOutbreakSignals returns the real signal (pet_jurisdiction_* scope — VALID)", async () => {
    const res = await loadOutbreakSignals(GOVT, JURS, SINCE);
    expect(res.rows.length).toBeGreaterThanOrEqual(1);
    expect(res.rows.some((r) => r.diseaseCode === "rabies_suspected")).toBe(true);
  }, 30_000);

  it("loadZoonosisByUnit attributes the signal to the pet_jurisdiction province (national = department grain, k-anon)", async () => {
    // PO 2026-07-16: the national (level="province") request now folds to DEPARTMENT
    // grain with k=5 suppression (isNationalDepartmentGrain), not one raw point per
    // province. The signal is still ATTRIBUTED to its pet_jurisdiction province (proving
    // the schema-drift fix holds — it is not ghost-dropped), but a lone signal in a
    // synthetic locality with no ar_localities department stands alone (count 1 < k=5),
    // so its cell is SUPPRESSED — the privacy floor, strictly more anonymising than the
    // old province count.
    const res = await loadZoonosisByUnit("province", GOVT, JURS, SINCE);
    const cell = res.cells.find((c) => c.province === PROVINCE);
    expect(cell).toBeDefined();
    expect(cell?.suppressed).toBe(true);
    expect(cell?.count).toBeNull();
  }, 30_000);

  // task panorama-bivariate-2026-07-21: the bivariate join's signal axis was
  // refused at national scope because loadZoonosisByUnit's k=5 suppression ran
  // at DEPARTMENT grain (~500 units, almost all sub-k). This proves the NEW
  // `provinceSignal` fallback (a) PAINTS well-populated provinces at national
  // scope, (b) still HONESTLY SUPPRESSES a genuinely sparse one — k-anon is
  // never weakened, just applied at a coarser (safer) unit — and (c) still runs
  // COMPLEMENTARY suppression a level up from the department grain: with
  // loadZoonosisSignalScopeTotal publishing the unsuppressed NATIONAL sum for
  // the KPI, a LONE suppressed province would otherwise be recoverable by
  // subtracting the visible provinces from that total, so the smallest visible
  // province must ALSO fold into suppression whenever exactly one primary
  // suppression happens nationally.
  it("loadZoonosisByUnit's provinceSignal fallback clears k=5, suppresses a sparse province, and complements the lone suppression", async () => {
    // ISOLATION (fix for the C5-reseed leak): this query is deliberately
    // NATIONAL and UNSCOPED (admin, no jurisdictions) — by design, it has to
    // see every outbreak_signal in the DB to prove the n===1 complementary
    // rule. That means it ALSO sees whatever the panorama seed's variety
    // tail (seedFeedVarietyTail) and history generators have written for
    // REAL provinces (Chubut/Río Negro/Salta/Santa Fe singletons observed
    // in local data) — each a legitimate sub-k signal that inflates
    // suppressedPerGroup["national"] past 1 and silently disables the very
    // promotion path this test exists to prove. The suite's own file-level
    // `SINCE` (24h) does not exclude them either — they're recent seed runs.
    // Rather than trying to out-guess how many ambient sub-k provinces exist
    // (a moving target across re-seeds), scope this ONE test to a `since`
    // cutoff captured right now, after every ambient signal already in the
    // DB and before any of this test's own inserts — so only this test's
    // controlled fixtures are in scope, regardless of what the seed has
    // written before or will write in a later, unrelated run.
    const isolatedSince = new Date(Date.now() - 1_000);

    const BIG_PROVINCE = "PANORAMA-BIVAR-PROV-BIG"; // 10 — safely visible
    const MED_PROVINCE = "PANORAMA-BIVAR-PROV-MED"; // 5 — clears k ALONE, but is the
    // smallest VISIBLE province nationally, so it gets promoted (complementary).
    const SMALL_PROVINCE = "PANORAMA-BIVAR-PROV-SMALL"; // 2 — primary-suppressed
    const insertOutbreak = (province: string, locality: string) =>
      insertEvent("outbreak_signal", {
        triggered_by: "direct_diagnosis",
        source_symptom_event_id: null,
        source_disease_diagnosis_event_id: randomUUID(),
        disease_code: "rabies_suspected",
        disease_label: "Rabia (sospechada)",
        match_strength: { high_count: 0, medium_count: 0, low_count: 0, matched_symptom_codes: [] },
        pet_jurisdiction_country: "AR",
        pet_jurisdiction_province: province,
        pet_jurisdiction_locality: locality,
        pet_species: "dog",
      });

    // 10 signals (clears k=5) in the "big" province, spread over two synthetic
    // localities — provinceSignal sums ACROSS localities independent of the
    // department fold `cells` uses, proving the two grains are computed
    // separately from the same raw rollup.
    for (let i = 0; i < 5; i += 1) await insertOutbreak(BIG_PROVINCE, "PANORAMA-BIVAR-LOC-1");
    for (let i = 0; i < 5; i += 1) await insertOutbreak(BIG_PROVINCE, "PANORAMA-BIVAR-LOC-2");
    // 5 signals — clears k=5 alone, but is the smallest VISIBLE province once
    // SMALL_PROVINCE below is primary-suppressed.
    for (let i = 0; i < 5; i += 1) await insertOutbreak(MED_PROVINCE, "PANORAMA-BIVAR-LOC-3");
    // 2 signals (sub-k) — primary-suppressed. Needs to be the ONLY suppressed
    // province in the national scope this query sees for the n===1 promotion
    // rule to fire.
    await insertOutbreak(SMALL_PROVINCE, "PANORAMA-BIVAR-LOC-4");
    await insertOutbreak(SMALL_PROVINCE, "PANORAMA-BIVAR-LOC-4");
    // (PROVINCE, LOCALITY) = ("Santa Fe", "PANORAMA-ZOON-ISO") gets its OWN
    // fresh 6 signals within `isolatedSince` — deliberately MORE than
    // MED_PROVINCE's 5 (not tied) so `complementarySuppress`'s strict `<`
    // smallest-visible comparison has no ambiguity about which province is
    // promoted. The suite's beforeAll signal for this same (province,
    // locality) predates `isolatedSince`, so it no longer counts here — this
    // test is now self-contained regardless of ambient data.
    for (let i = 0; i < 6; i += 1) await insertOutbreak(PROVINCE, LOCALITY);

    // Admin, no jurisdictions/adminProvince → national, unrestricted scope
    // (jurisdictionColumnsScope: "admin, no province → null (no restriction)"),
    // scoped to `isolatedSince` so only this test's own fixtures are counted.
    const res = await loadZoonosisByUnit("province", { role: "admin" }, [], isolatedSince);
    expect(res.provinceSignal).toBeDefined();
    const cells = res.provinceSignal ?? [];

    const big = cells.find((c) => c.province === BIG_PROVINCE);
    expect(big).toBeDefined();
    expect(big?.suppressed).toBe(false);
    expect(big?.count).toBe(10);

    const small = cells.find((c) => c.province === SMALL_PROVINCE);
    expect(small).toBeDefined();
    expect(small?.suppressed).toBe(true);
    expect(small?.count).toBeNull();

    // Complementary suppression: MED clears k=5 on its own, but is the smallest
    // VISIBLE province nationally while exactly one OTHER province (SMALL) is
    // primary-suppressed — so it is ALSO withheld (never a raw count), closing
    // the `nationalTotal − Σvisible` differencing gap.
    const med = cells.find((c) => c.province === MED_PROVINCE);
    expect(med).toBeDefined();
    expect(med?.suppressed).toBe(true);
    expect(med?.count).toBeNull();

    // These synthetic events share `petId` with the suite's fixture pet, so the
    // shared `cleanup()` in afterAll deletes them too — nothing extra to tear
    // down here.
  }, 30_000);

  it("loadUnitHistory('zoonosis') returns the outbreak_signal", async () => {
    const hist = await loadUnitHistory({
      layer: "zoonosis",
      province: PROVINCE,
      locality: null,
      since: SINCE,
      until: new Date(),
      actor: GOVT,
      jurisdictions: JURS,
    });
    // type is the disease_code (falls back to 'outbreak_signal').
    expect(hist.events.map((e) => e.type)).toContain("rabies_suspected");
    expect(hist.trend.reduce((s, b) => s + b.count, 0)).toBeGreaterThanOrEqual(1);
  }, 30_000);
});

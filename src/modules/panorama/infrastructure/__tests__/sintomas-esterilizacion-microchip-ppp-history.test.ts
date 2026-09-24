// NIGHT-3 item #5 — loadUnitHistory must return real history for the four layers
// that previously fell through its switch to the empty `default` (sintomas +
// the current-state esterilizacion/microchip/ppp choropleths). Before the fix a
// drill on a POPULATED cell of any of these opened a drawer with an empty
// "Historia de la unidad". This asserts the events list + trend are populated at
// province level — the same integration pattern as perdidas-mordeduras-real-events.
//
// #40b: the fixture seeds K_ANON pets, not one. It used to seed a single pet and
// rely on "province level (no k-anon guard)" — the premise task #40 retired. The
// province guard now applies, so a one-pet province is correctly SUPPRESSED and
// this file would have been asserting that a sub-k unit publishes its event list.
// The intent (these four layers return real history at all) is unchanged; only the
// fixture size moved above the threshold, where the assertion is meaningful.
//
// Integration test — local Supabase + Postgres. Govt scope to a SYNTHETIC
// locality so only this test's pet is in scope (the national seed fills every
// real province).

import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, petEvents, petIdentifications, pets } from "@/db";
import type { EventType } from "@/db/schema";
import type { DashboardActor, DashboardJurisdiction } from "@/lib/metrics";

import { withMutationOverride } from "../../../../../__tests__/_helpers/db-overrides";
import { loadChoroplethByLevel, loadUnitHistory } from "../repository";

const PROVINCE = "Santa Fe";
const LOCALITY = "PANORAMA-SEMP-ISO"; // synthetic — no seed collision
const GOVT: DashboardActor = { role: "govt" };
const JURS: DashboardJurisdiction[] = [{ province: PROVINCE, locality: LOCALITY }];
const SINCE = new Date(Date.now() - 24 * 60 * 60 * 1000);

/** The k-anon threshold the province guard enforces (mirrors K_ANON in the loader). */
const K_ANON = 5;

let petIds: string[] = [];

async function insertEvent(
  petId: string,
  eventType: EventType,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(petEvents).values({
    petId,
    eventType,
    occurredAt: new Date(),
    payload: { payload_version: 1, ...payload },
    authorRole: "system",
    recordedByUserId: null,
  });
}

async function cleanup(): Promise<void> {
  if (petIds.length === 0) return;
  await withMutationOverride(async (tx) => {
    await tx.delete(petEvents).where(inArray(petEvents.petId, petIds));
  });
  await db.delete(petIdentifications).where(inArray(petIdentifications.petId, petIds));
  await db.delete(pets).where(inArray(pets.id, petIds));
  petIds = [];
}

beforeAll(async () => {
  await cleanup();
  // K_ANON pets, each carrying one event per layer. The current-state guards
  // (esterilizacion/microchip/ppp) count DISTINCT PETS and the sintomas guard
  // counts DISTINCT EVENTS, so this clears k=5 for all four.
  for (let i = 0; i < K_ANON; i++) {
    const [row] = await db
      .insert(pets)
      .values({
        publicToken: `DIM-PANO-SEMP-TES${i}`,
        name: `PANO-SEMP-Test-${i}`,
        species: "dog",
        sex: "male",
        status: "active",
        potentiallyDangerousBreed: true,
        jurisdictionProvince: PROVINCE,
        jurisdictionLocality: LOCALITY,
      })
      .returning({ id: pets.id });
    petIds.push(row.id);

    await insertEvent(row.id, "symptom_observed");
    await insertEvent(row.id, "sterilization_performed");
    // THE INSCRIPTION NUMBER IS PART OF THE FIXTURE SINCE T4-I1 / #753, and
    // leaving it out is what this test caught. The `ppp-compliance` layer
    // counts attestations that COUNT — one citing the number the registry
    // issued, or one an accountable institution recorded
    // (lib/domain/ppp-attestation.ts) — and the drill-down mirrors that
    // numerator exactly, by design, so a suppressed cell cannot be
    // re-identified through the history. A bare `{payload_version: 1}` row
    // authored by `system` is neither, so the layer correctly went empty.
    //
    // Citing it here is not the test bending to the code: it is the fixture
    // becoming what the two product writers actually file. The web form posts
    // `registryId`, and `/api/v1` carries it in the attestation payload.
    await insertEvent(row.id, "dangerous_breed_attested", {
      registry: "prov_14107",
      registry_id: `RUPPPA-HIST-${i}`,
      attested_at: new Date().toISOString().slice(0, 10),
    });
    // microchip is backed by pet_identifications, not pet_events.
    await db.insert(petIdentifications).values({
      petId: row.id,
      kind: "microchip_iso",
      status: "active",
      recordedAt: new Date().toISOString().slice(0, 10),
      // chip_requires_iso_fields CHECK: a microchip_iso row must carry its ISO parts.
      code: `90012345678901${i}`,
      isoCountryCode: "900",
      isoManufacturerCode: "1234",
      isoNationalId: `5678901${i}`,
      isoCompliant: true,
    });
  }
});

afterAll(cleanup);

describe("loadUnitHistory — sintomas / esterilizacion / microchip / ppp (item #5)", () => {
  it("sintomas returns the symptom event + a populated trend", async () => {
    const hist = await loadUnitHistory({
      layer: "sintomas",
      province: PROVINCE,
      locality: null,
      since: SINCE,
      until: new Date(),
      actor: GOVT,
      jurisdictions: JURS,
    });
    expect(hist.events.map((e) => e.type)).toContain("symptom_observed");
    expect(hist.trend.reduce((s, b) => s + b.count, 0)).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("esterilizacion returns the sterilization event + a populated trend", async () => {
    const hist = await loadUnitHistory({
      layer: "esterilizacion",
      province: PROVINCE,
      locality: null,
      since: SINCE,
      until: new Date(),
      actor: GOVT,
      jurisdictions: JURS,
    });
    expect(hist.events.map((e) => e.type)).toContain("sterilization_performed");
    expect(hist.trend.reduce((s, b) => s + b.count, 0)).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("ppp returns the attestation event + a populated trend", async () => {
    const hist = await loadUnitHistory({
      layer: "ppp",
      province: PROVINCE,
      locality: null,
      since: SINCE,
      until: new Date(),
      actor: GOVT,
      jurisdictions: JURS,
    });
    expect(hist.events.map((e) => e.type)).toContain("dangerous_breed_attested");
    expect(hist.trend.reduce((s, b) => s + b.count, 0)).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("microchip returns the identification + a populated trend", async () => {
    const hist = await loadUnitHistory({
      layer: "microchip",
      province: PROVINCE,
      locality: null,
      since: SINCE,
      until: new Date(),
      actor: GOVT,
      jurisdictions: JURS,
    });
    expect(hist.events.map((e) => e.type)).toContain("microchip_iso");
    expect(hist.trend.reduce((s, b) => s + b.count, 0)).toBeGreaterThanOrEqual(1);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// T4-I1 / #753 — the map layer follows the evidence rule, not "a row exists"
// ---------------------------------------------------------------------------
//
// `metricNumeratorCondition("ppp-compliance")` used to spell the numerator out
// as a bare EXISTS over `dangerous_breed_attested`, under a comment promising
// it matched `fetchDangerousBreedCompliance` (C7). When C7 gained the evidence
// rule that promise silently became false, and the SAME console would have
// shaded a locality on the map while the KPI tile beside it counted fewer pets.
// A review caught the third copy; the fix was to share `PPP_ATTESTED_EVIDENCE`.
//
// This asserts the CONSEQUENCE over real rows rather than the sharing: a PPP
// pet whose attestation cites no number and carries no institutional signature
// must not move the locality's count-density cell.
describe("ppp-compliance choropleth — a bare attestation does not count (#753)", () => {
  let barePetId: string | null = null;

  afterAll(async () => {
    if (!barePetId) return;
    await withMutationOverride(async (tx) => {
      await tx.delete(petEvents).where(inArray(petEvents.petId, [barePetId as string]));
    });
    await db.delete(pets).where(inArray(pets.id, [barePetId as string]));
  });

  it("leaves the locality cell at the evidenced count", async () => {
    const before = await localityValue();
    // The fixture's K_ANON pets all cite a number, so the cell starts there.
    expect(before).toBe(K_ANON);

    const [row] = await db
      .insert(pets)
      .values({
        publicToken: "DIM-PANO-SEMP-BARE",
        name: "PANO-SEMP-Bare",
        species: "dog",
        sex: "male",
        status: "active",
        potentiallyDangerousBreed: true,
        jurisdictionProvince: PROVINCE,
        jurisdictionLocality: LOCALITY,
      })
      .returning({ id: pets.id });
    barePetId = row.id;
    // Attested, and unevidenced: no number, author `system`.
    await insertEvent(row.id, "dangerous_breed_attested", { registry: "prov_14107" });

    // NON-VACUITY: the pet really is in scope and really has an attestation —
    // under the old predicate this cell would read K_ANON + 1.
    const rawAttested = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(petEvents)
      .where(and(eq(petEvents.petId, row.id), eq(petEvents.eventType, "dangerous_breed_attested")));
    expect(rawAttested[0]?.n).toBe(1);

    expect(await localityValue()).toBe(K_ANON);
  }, 30_000);

  async function localityValue(): Promise<number | null> {
    const rows = await loadChoroplethByLevel("ppp-compliance", "locality", GOVT, JURS);
    // Matched on `locality` and not `key`: the key is a composite
    // ("Santa Fe|loc:PANORAMA-SEMP-ISO") whose spelling is the loader's
    // business, and a test that pins it would fail on a formatting change that
    // broke nothing.
    const cell = rows.cells.find((c) => c.locality === LOCALITY);
    return cell?.value ?? null;
  }
});

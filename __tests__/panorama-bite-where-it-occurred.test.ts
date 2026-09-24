// T1-G2 — a bite counts where it OCCURRED, on the map too (PO 2026-09-08;
// localidad plan L2·3 and L2·1).
//
// Integration test — local Supabase + Postgres.
//
// 1. PANORAMA. A dog registered in CABA bites five times in Córdoba (the bite
//    writers stamp the incident's place into the incident_reported payload) and
//    once with no place captured (the writers then fall back to the pet's home,
//    field by field — and so must the map). The Córdoba operator must see the
//    five, as a VISIBLE cell of five (k=5), and the CABA operator must see only
//    the fallback bite. Before T1-G2 the loaders joined the pet's home, so all
//    six counted in CABA and Córdoba saw none — while the bite CASES were
//    already routed to Córdoba.
//
// 2. THE WRITE GATE. The bite writers normalise with locality "soft": a map pin
//    carries a place NAME (reverse geocoding), never an INDEC id. A name the
//    catalog knows must come back with its id; one it does not know must still
//    save, raw, without an id — a bite report is never blocked by how a
//    geocoder spells a place.
//
// Made-up localities for the panorama half, so the national seed never lands
// in scope.

import { readFileSync } from "node:fs";

import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, petEvents, pets } from "@/db";
import { normalizeLocationForWrite } from "@/lib/domain/location-normalize";
import { validateEventPayload } from "@/lib/events/event-schemas";
import type { DashboardActor, DashboardJurisdiction } from "@/lib/metrics";
import {
  loadBiteEvents,
  loadMordedurassByUnit,
} from "@/src/modules/panorama/infrastructure/repository";

import { withMutationOverride } from "./_helpers/db-overrides";

const HOME_PROVINCE = "CABA";
const HOME_LOCALITY = "SYNTH-G2-HOME"; // made up
const INCIDENT_PROVINCE = "Córdoba";
const INCIDENT_LOCALITY = "SYNTH-G2-INCIDENT"; // made up
const TOKEN = "DIM-G2-BITER";

const GOVT: DashboardActor = { role: "govt" };
const CORDOBA: DashboardJurisdiction[] = [
  { province: INCIDENT_PROVINCE, locality: INCIDENT_LOCALITY },
];
const CABA_HOME: DashboardJurisdiction[] = [{ province: HOME_PROVINCE, locality: HOME_LOCALITY }];

const OCCURRED_AT = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
const SINCE = new Date(OCCURRED_AT.getTime() - 60 * 60 * 1000);

let petId = "";
const incidentIds: string[] = [];
let fallbackId = "";

async function insertBite(where: { province: string; locality: string } | null): Promise<string> {
  const [row] = await db
    .insert(petEvents)
    .values({
      petId,
      eventType: "incident_reported",
      occurredAt: OCCURRED_AT,
      payload: validateEventPayload("incident_reported", {
        incident_type: "bite_inflicted",
        severity: "moderate",
        injuries_summary: null,
        vet_involved: null,
        ...(where
          ? { jurisdiction_province: where.province, jurisdiction_locality: where.locality }
          : { jurisdiction_province: null, jurisdiction_locality: null }),
      }) as Record<string, unknown>,
      authorRole: "owner",
      recordedByUserId: null,
      locationLat: "-31.4000000",
      locationLng: "-64.1800000",
    })
    .returning({ id: petEvents.id });
  return row.id;
}

async function cleanup(): Promise<void> {
  await withMutationOverride(async (tx) => {
    await tx.execute(
      sql`DELETE FROM pet_events WHERE pet_id IN (SELECT id FROM pets WHERE public_token = ${TOKEN})`,
    );
    await tx.execute(sql`DELETE FROM pets WHERE public_token = ${TOKEN}`);
  });
}

beforeAll(async () => {
  await cleanup();
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: TOKEN,
      name: "Mordedor",
      species: "dog",
      sex: "male",
      status: "active",
      jurisdictionProvince: HOME_PROVINCE,
      jurisdictionLocality: HOME_LOCALITY,
    })
    .returning({ id: pets.id });
  petId = pet.id;
  for (let i = 0; i < 5; i++) {
    incidentIds.push(
      await insertBite({ province: INCIDENT_PROVINCE, locality: INCIDENT_LOCALITY }),
    );
  }
  fallbackId = await insertBite(null);
}, 60_000);

afterAll(cleanup, 60_000);

describe("panorama — a CABA dog that bites in Córdoba counts in Córdoba", () => {
  it("the Córdoba operator gets the five incident dots, and not the fallback one", async () => {
    const res = await loadBiteEvents(GOVT, CORDOBA, SINCE);
    expect(res.rows.map((r) => r.id).sort()).toEqual([...incidentIds].sort());
  });

  it("the CABA operator gets only the bite with no captured place (home fallback)", async () => {
    const res = await loadBiteEvents(GOVT, CABA_HOME, SINCE);
    expect(res.rows.map((r) => r.id)).toEqual([fallbackId]);
  });

  it("by unit: Córdoba shows a VISIBLE cell of exactly five; CABA does not get them", async () => {
    const cordoba = await loadMordedurassByUnit("province", GOVT, CORDOBA, SINCE);
    const cell = cordoba.cells.find((c) => c.province === INCIDENT_PROVINCE);
    expect(cell).toMatchObject({ suppressed: false, count: 5 });
    expect(cordoba.cells.some((c) => c.province === HOME_PROVINCE)).toBe(false);

    const caba = await loadMordedurassByUnit("province", GOVT, CABA_HOME, SINCE);
    // One fallback bite: under k, so present-and-suppressed — never five.
    const home = caba.cells.find((c) => c.province === HOME_PROVINCE);
    expect(home).toMatchObject({ suppressed: true, count: null });
    expect(caba.cells.some((c) => c.province === INCIDENT_PROVINCE)).toBe(false);
  });

  it("an admin drilled into the incident locality finds the five there", async () => {
    const res = await loadBiteEvents(
      { role: "admin" },
      [],
      SINCE,
      undefined,
      INCIDENT_PROVINCE,
      INCIDENT_LOCALITY,
    );
    expect(res.rows.map((r) => r.id).sort()).toEqual([...incidentIds].sort());
  });

  it("the fixture is what it claims: the pet's HOME is CABA", async () => {
    const [row] = await db
      .select({ province: pets.jurisdictionProvince, locality: pets.jurisdictionLocality })
      .from(pets)
      .where(inArray(pets.id, [petId]));
    expect(row).toEqual({ province: HOME_PROVINCE, locality: HOME_LOCALITY });
  });
});

describe("the bite writers' location gate — locality 'soft'", () => {
  // The shape a map pin produces: province + a reverse-geocoded locality NAME,
  // coordinates, and NO INDEC id (LocationFields L2 emits the id empty).
  const pin = (locality: string) => ({
    province: "Córdoba",
    provinceCode: "AR-X",
    locality,
    localityIndecId: null,
    lat: -33.1231,
    lng: -64.3493,
    address: null,
  });

  it("a pin whose locality is in the catalog carries its ar_localities id", async () => {
    const out = await normalizeLocationForWrite(pin("Rio Cuarto"), { locality: "soft" });
    expect(out.localityCanonical).toBe(true);
    expect(out.locality).toBe("Río Cuarto");
    expect(out.localityId).toMatch(/^[0-9a-f-]{36}$/);
    const [cat] = await db.execute<{ name: string }>(
      sql`SELECT locality_name AS name FROM ar_localities WHERE id = ${out.localityId}`,
    );
    expect(cat?.name).toBe("Río Cuarto");
  });

  it("both web bite writers use 'soft' (never 'strict', never 'none') and carry the id", () => {
    // The owner writer and the org writer. A source pin, because the actions
    // need a session to run; the gate's behaviour itself is proven above/below.
    const source = readFileSync("src/modules/surveillance/actions.ts", "utf8");
    const gates = source.match(/normalizeLocationForWrite\(loc, \{ locality: "(\w+)" \}\)/g) ?? [];
    expect(gates).toEqual([
      'normalizeLocationForWrite(loc, { locality: "soft" })',
      'normalizeLocationForWrite(loc, { locality: "soft" })',
    ]);
    expect(source.match(/eventLocalityId: normalizedLoc\.localityId/g)).toHaveLength(2);
  });

  it("a pin whose locality is NOT in the catalog still saves — raw name, no id, no throw", async () => {
    const out = await normalizeLocationForWrite(pin("Paraje Inventado G2"), { locality: "soft" });
    expect(out.localityCanonical).toBe(false);
    expect(out.locality).toBe("Paraje Inventado G2");
    expect(out.localityId).toBeNull();
    expect(out.province).toBe("Córdoba");
  });
});

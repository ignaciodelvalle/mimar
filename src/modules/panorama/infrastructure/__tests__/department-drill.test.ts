// Regression: the detail-tier drill must be DEPARTMENT-AWARE (PO "Option A").
//
// Since the aggregated-point + choropleth detail tiers fold to the department
// (barrio in CABA), a clicked map cell/bubble carries the DEPARTMENT NAME as its
// `locality`. loadUnitHistory must resolve that back to the department's member
// localities so "Historia de la unidad" aggregates over the SAME set the folded
// cell counted — otherwise the drawer is always empty (the exact bug this fixes).
//
// Deterministic against the national seed: a SYNTHETIC department + two synthetic
// member localities (registered in ar_localities under a real province so the ISO
// join resolves) that never collide with seed geography.
//
// Integration test — local Supabase + Postgres.

import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { arLocalities, db, petEvents, pets } from "@/db";
import type { EventType } from "@/db/schema";
import { validateEventPayload } from "@/lib/events/event-schemas";
import type { DashboardActor, DashboardJurisdiction } from "@/lib/metrics";

import { withMutationOverride } from "../../../../../__tests__/_helpers/db-overrides";
import { loadUnitHistory } from "../repository";

const PROVINCE = "Santa Fe";
const PROVINCE_CODE = "AR-S";
const DEPARTMENT = "PANORAMA-DEPT-ISO"; // synthetic department — no seed collision
const DEPARTMENT_CODE = "99999";
const LOCALITY_A = "PANO-DEPT-A";
const LOCALITY_B = "PANO-DEPT-B";
// WARNING 3 decoy: a locality NAMED like the department but sitting in a DIFFERENT
// department (code 88888). A name-based drill would pull its pet in; a CODE-based
// drill must exclude it.
const DECOY_DEPARTMENT = "PANORAMA-DEPT-OTHER";
const DECOY_DEPARTMENT_CODE = "88888";
const DECOY_LOCALITY = DEPARTMENT; // locality literally named like the department
const ADMIN: DashboardActor = { role: "admin" };
const JURS: DashboardJurisdiction[] = [];
const SINCE = new Date(Date.now() - 24 * 60 * 60 * 1000);

let petAId = "";
let petBId = "";
let petDecoyId = "";

async function insertSighting(petId: string): Promise<void> {
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
}

async function insertLocality(
  name: string,
  departmentName = DEPARTMENT,
  departmentCode = DEPARTMENT_CODE,
): Promise<void> {
  await db.insert(arLocalities).values({
    provinceCode: PROVINCE_CODE,
    departmentName,
    departmentCode,
    localityName: name,
    localitySlug: `${departmentCode}-${name.toLowerCase()}`,
    category: "localidad",
    source: "bahra",
    latitude: "-31.6",
    longitude: "-60.7",
  });
}

async function makePet(token: string, locality: string): Promise<string> {
  const [row] = await db
    .insert(pets)
    .values({
      publicToken: token,
      name: token,
      species: "dog",
      sex: "male",
      status: "active",
      jurisdictionProvince: PROVINCE,
      jurisdictionLocality: locality,
    })
    .returning({ id: pets.id });
  return row.id;
}

async function cleanup(): Promise<void> {
  const ids = [petAId, petBId, petDecoyId].filter(Boolean);
  if (ids.length) {
    await withMutationOverride(async (tx) => {
      await tx.delete(petEvents).where(inArray(petEvents.petId, ids));
    });
    await db.delete(pets).where(inArray(pets.id, ids));
  }
  await withMutationOverride(async (tx) => {
    await tx
      .delete(arLocalities)
      .where(
        and(
          eq(arLocalities.provinceCode, PROVINCE_CODE),
          inArray(arLocalities.departmentName, [DEPARTMENT, DECOY_DEPARTMENT]),
        ),
      );
  });
  petAId = "";
  petBId = "";
  petDecoyId = "";
}

beforeAll(async () => {
  await cleanup();
  await insertLocality(LOCALITY_A);
  await insertLocality(LOCALITY_B);
  // Decoy: a locality named exactly like DEPARTMENT but in a DIFFERENT department.
  await insertLocality(DECOY_LOCALITY, DECOY_DEPARTMENT, DECOY_DEPARTMENT_CODE);
  petAId = await makePet("DIM-PANO-DEPT-A", LOCALITY_A);
  petBId = await makePet("DIM-PANO-DEPT-B", LOCALITY_B);
  petDecoyId = await makePet("DIM-PANO-DEPT-DECOY", DECOY_LOCALITY);
  // 3 sightings in locality A + 3 in locality B → each locality below k=5, but the
  // department sums to 6 (>= 5) → visible when drilled by department. The decoy pet
  // gets 5 sightings (would clear k on its own if wrongly pulled in).
  for (let i = 0; i < 3; i++) {
    await insertSighting(petAId);
    await insertSighting(petBId);
  }
  for (let i = 0; i < 5; i++) {
    await insertSighting(petDecoyId);
  }
});

afterAll(cleanup);

describe("department-aware unit-history drill (PO Option A)", () => {
  it("drilling by department CODE aggregates member localities, clears k=5, and excludes a same-named decoy in another department (WARNING 3)", async () => {
    const hist = await loadUnitHistory({
      layer: "perdidas",
      province: PROVINCE,
      locality: DEPARTMENT, // the folded map cell carries the department name here…
      departmentCode: DEPARTMENT_CODE, // …but the CODE is the group key the fold used
      since: SINCE,
      until: new Date(),
      actor: ADMIN,
      jurisdictions: JURS,
    });
    expect(hist.suppressed ?? false).toBe(false);
    // Exactly the 6 member-locality sightings (A+B) — the department total. The
    // decoy's 5 (a locality literally named like the department, but under a
    // DIFFERENT department code) are NOT pulled in: matched by CODE, not name.
    expect(hist.events.length).toBe(6);
    expect(hist.trend.reduce((s, b) => s + b.count, 0)).toBe(6);
  }, 30_000);

  it("drilling by a single member LOCALITY stays k-anon suppressed (3 < 5)", async () => {
    const hist = await loadUnitHistory({
      layer: "perdidas",
      province: PROVINCE,
      locality: LOCALITY_A,
      since: SINCE,
      until: new Date(),
      actor: ADMIN,
      jurisdictions: JURS,
    });
    // The exact-match arm resolves only locality A (3 events) — below k, suppressed.
    expect(hist.suppressed).toBe(true);
    expect(hist.events).toHaveLength(0);
  }, 30_000);
});

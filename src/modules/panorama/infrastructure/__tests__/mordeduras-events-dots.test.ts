// panorama-event-points Slice 2 — loadBiteEvents (REAL incident dots).
//
// Integration test — local Supabase + Postgres. Asserts the near-zoom bite-dot
// loader:
//   - LOCATED events only: an incident_reported (bite_inflicted) WITH coords
//     becomes a dot; a bite WITHOUT coords is counted into noCoordCount, never
//     plotted as a fake centroid dot (fallback honesty, §5).
//   - SCOPE (privacy hinge): a govt operator sees ONLY their jurisdiction's bites
//     (incident-place attribution, which falls back to the pet's home when the
//     payload names no place — these fixtures name none) — a neighbouring province's bite is
//     EXCLUDED (out-of-scope operators never receive individual dots).
//   - admin (national) sees both provinces' bites.
//
// Synthetic localities so only this test's pets are in scope.

import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, petEvents, pets } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import type { DashboardActor, DashboardJurisdiction } from "@/lib/metrics";

import { withMutationOverride } from "../../../../../__tests__/_helpers/db-overrides";
import { loadBiteEvents } from "../repository";

const PROVINCE = "Santa Fe";
const LOCALITY = "PANORAMA-BITE-ISO"; // synthetic — no seed collision
const OTHER_PROVINCE = "Córdoba";
const OTHER_LOCALITY = "PANORAMA-BITE-OTHER";
const GOVT: DashboardActor = { role: "govt" };
const JURS: DashboardJurisdiction[] = [{ province: PROVINCE, locality: LOCALITY }];
const SINCE = new Date(Date.now() - 24 * 60 * 60 * 1000);

let petId = "";
let otherPetId = "";

async function insertBite(
  targetPetId: string,
  opts: { lat: string | null; lng: string | null; source?: string; occurredAt?: Date },
): Promise<void> {
  await db.insert(petEvents).values({
    petId: targetPetId,
    eventType: "incident_reported",
    occurredAt: opts.occurredAt ?? new Date(),
    payload: validateEventPayload("incident_reported", {
      incident_type: "bite_inflicted",
      severity: "moderate",
      injuries_summary: null,
      vet_involved: null,
      ...(opts.source ? { location_source: opts.source } : {}),
    }) as Record<string, unknown>,
    authorRole: "owner",
    recordedByUserId: null,
    locationLat: opts.lat,
    locationLng: opts.lng,
  });
}

async function cleanup(): Promise<void> {
  const ids = [petId, otherPetId].filter(Boolean);
  if (ids.length === 0) return;
  await withMutationOverride(async (tx) => {
    await tx.delete(petEvents).where(inArray(petEvents.petId, ids));
  });
  await db.delete(pets).where(inArray(pets.id, ids));
  petId = "";
  otherPetId = "";
}

beforeAll(async () => {
  await cleanup();
  const [row] = await db
    .insert(pets)
    .values({
      publicToken: "DIM-PANO-BITE-1",
      name: "Bite-Test",
      species: "dog",
      sex: "male",
      status: "active",
      jurisdictionProvince: PROVINCE,
      jurisdictionLocality: LOCALITY,
    })
    .returning({ id: pets.id });
  petId = row.id;

  const [other] = await db
    .insert(pets)
    .values({
      publicToken: "DIM-PANO-BITE-2",
      name: "Bite-Other",
      species: "dog",
      sex: "female",
      status: "active",
      jurisdictionProvince: OTHER_PROVINCE,
      jurisdictionLocality: OTHER_LOCALITY,
    })
    .returning({ id: pets.id });
  otherPetId = other.id;

  // In-scope bite WITH coords → a dot.
  await insertBite(petId, {
    lat: "-31.6333000",
    lng: "-60.7000000",
    source: "pin_manual",
    occurredAt: new Date(Date.now() - 60 * 60 * 1000),
  });
  // In-scope bite WITHOUT coords → residual, not a dot.
  await insertBite(petId, { lat: null, lng: null });
  // Out-of-scope bite (other province) WITH coords → excluded for GOVT.
  await insertBite(otherPetId, { lat: "-31.4200000", lng: "-64.1800000" });
});

afterAll(cleanup);

describe("loadBiteEvents — real incident dots (Slice 2)", () => {
  it("plots ONLY coord'd bites; a coord-less bite is excluded from dots", async () => {
    const res = await loadBiteEvents(GOVT, JURS, SINCE);
    // Exactly one dot: the coord'd bite. The coord-less bite is NOT plotted.
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].locationLat).toBe("-31.6333000");
    expect(res.rows[0].incidentType).toBe("bite_inflicted");
  }, 30_000);

  it("counts the coord-less bite into the 'sin ubicación exacta' residual", async () => {
    const res = await loadBiteEvents(GOVT, JURS, SINCE);
    expect(res.noCoordCount).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("scopes to the operator's OWN jurisdiction — a neighbouring province's bite is excluded", async () => {
    const res = await loadBiteEvents(GOVT, JURS, SINCE);
    // The out-of-scope bite plots at -64.18/-31.42; it must never reach this operator.
    expect(res.rows.some((r) => r.locationLng === "-64.1800000")).toBe(false);
  }, 30_000);

  it("admin (national) sees both jurisdictions' bites", async () => {
    const res = await loadBiteEvents({ role: "admin" }, [], SINCE);
    const lngs = res.rows.map((r) => r.locationLng);
    expect(lngs).toContain("-60.7000000");
    expect(lngs).toContain("-64.1800000");
  }, 30_000);
});

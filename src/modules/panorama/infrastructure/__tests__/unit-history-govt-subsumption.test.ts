// Regression (US-1, Tier-2 authz critique): loadUnitHistory's govt defense-in-
// depth fence must apply whole-province SUBSUMPTION — the same semantics the API
// route already uses (jurisdictionScopeContains) — instead of raw exact-locality
// equality.
//
// Before the fix the second fence matched `j.locality === locality`, so a whole-
// province govt operator (assignment `CABA / "Ciudad Autónoma de Buenos Aires"`)
// clicking a barrio (Palermo) got an EMPTY history for a barrio they legitimately
// govern and see aggregated on the map. This test proves BOTH:
//   (a) a whole-province operator NOW receives the barrio's history, and
//   (b) a barrio-scoped operator whose assignment does NOT cover the requested
//       (province, locality) is still DENIED — the fence never over-widens.
//
// Integration test — local Supabase + Postgres. Synthetic CABA barrio so only
// this test's pet is in scope; ≥ K_ANON (5) perdidas events so the k-anon guard
// does not suppress the ALLOW path.

import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, petEvents, pets } from "@/db";
import type { EventType } from "@/db/schema";
import { validateEventPayload } from "@/lib/events/event-schemas";
import type { DashboardActor, DashboardJurisdiction } from "@/lib/metrics";

import { withMutationOverride } from "../../../../../__tests__/_helpers/db-overrides";
import { loadUnitHistory } from "../repository";

const PROVINCE = "CABA";
const BARRIO = "PANO-US1-BARRIO"; // synthetic — no seed collision
const WHOLE_CABA = "Ciudad Autónoma de Buenos Aires"; // whole-province INDEC locality

// (a) whole-province assignment — SUBSUMES every barrio in CABA.
const GOVT: DashboardActor = { role: "govt" };
const WHOLE_PROVINCE_JURS: DashboardJurisdiction[] = [{ province: PROVINCE, locality: WHOLE_CABA }];
// (b) a DIFFERENT barrio-scoped assignment — province matches, locality does NOT.
//     Exact-pair semantics must keep this DENIED (no over-widen to the province).
const OTHER_BARRIO_JURS: DashboardJurisdiction[] = [{ province: PROVINCE, locality: "Palermo" }];

const SINCE = new Date(Date.now() - 24 * 60 * 60 * 1000);
const LOST_COUNT = 6; // > K_ANON (5) so the ALLOW path is not suppressed

let petId = "";

async function insertEvent(eventType: EventType, payload: Record<string, unknown>): Promise<void> {
  await db.insert(petEvents).values({
    petId,
    eventType,
    occurredAt: new Date(),
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
      publicToken: "DIM-PANO-US1SUB",
      name: "PANO-US1-Subsumption",
      species: "dog",
      sex: "male",
      status: "active",
      jurisdictionProvince: PROVINCE,
      jurisdictionLocality: BARRIO,
    })
    .returning({ id: pets.id });
  petId = row.id;

  for (let i = 0; i < LOST_COUNT; i++) {
    await insertEvent("status_changed", { from_status: "active", to_status: "lost" });
  }
});

afterAll(cleanup);

describe("unit-history govt fence applies whole-province subsumption (US-1)", () => {
  it("(a) whole-province operator receives the barrio's history", async () => {
    const hist = await loadUnitHistory({
      layer: "perdidas",
      province: PROVINCE,
      locality: BARRIO,
      since: SINCE,
      until: new Date(),
      actor: GOVT,
      jurisdictions: WHOLE_PROVINCE_JURS,
    });

    // Non-empty: the fence subsumed the barrio under the whole-CABA assignment,
    // and the SQL scope clause did the same — the operator sees the unit's events.
    expect(hist.events.length).toBeGreaterThan(0);
    expect(hist.byType.pet_lost).toBe(LOST_COUNT);
  }, 30_000);

  it("(b) an operator with no covering assignment is DENIED (no over-widen)", async () => {
    const hist = await loadUnitHistory({
      layer: "perdidas",
      province: PROVINCE,
      locality: BARRIO,
      since: SINCE,
      until: new Date(),
      actor: GOVT,
      // Palermo != PANO-US1-BARRIO, and a barrio-scoped assignment is exact-pair
      // only — it must NOT widen to cover a sibling barrio in the same province.
      jurisdictions: OTHER_BARRIO_JURS,
    });

    expect(hist.events).toEqual([]);
    expect(hist.byType).toEqual({});
  }, 30_000);
});

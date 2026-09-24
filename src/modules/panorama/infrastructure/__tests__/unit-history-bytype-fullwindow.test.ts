// Regression (KA5): unit-history `byType` must be computed from a SEPARATE grouped
// COUNT(*) over the FULL window — NOT tallied from the EVENT_LIMIT(20)-capped
// `events` array. A unit with >20 events in-window otherwise reports a per-type
// breakdown that undercounts (only the newest 20 rows are tallied).
//
// Deterministic: one pet in a synthetic locality with 15 lost markings + 10
// sightings = 25 perdidas events in-window (> the 20-event cap). The `events`
// list is capped at 20, but byType must report the TRUE per-type totals
// (pet_lost=15, pet_found_sighting=10, sum=25).
//
// Integration test — local Supabase + Postgres. Govt scope to a SYNTHETIC
// locality so only this test's pet is in scope.

import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, petEvents, pets } from "@/db";
import type { EventType } from "@/db/schema";
import { validateEventPayload } from "@/lib/events/event-schemas";
import type { DashboardActor, DashboardJurisdiction } from "@/lib/metrics";

import { withMutationOverride } from "../../../../../__tests__/_helpers/db-overrides";
import { loadUnitHistory } from "../repository";

const PROVINCE = "Santa Fe";
const LOCALITY = "PANO-BYTYPE-LOC"; // synthetic — no seed collision
const GOVT: DashboardActor = { role: "govt" };
const JURS: DashboardJurisdiction[] = [{ province: PROVINCE, locality: LOCALITY }];
const SINCE = new Date(Date.now() - 24 * 60 * 60 * 1000);

const LOST_COUNT = 15;
const SIGHTING_COUNT = 10; // total 25 > EVENT_LIMIT (20)

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
  // Delete by public_token, not the in-memory petId: a prior run that aborted
  // (e.g. a worker OOM) before afterAll leaves DIM-PANO-BYTYPE orphaned, and a
  // petId-guarded cleanup can't recover it — the orphan then poisons every later
  // run (beforeAll's insert hits the unique-token constraint) and drifts the
  // global pet-cache-rederivation sweep. Resolving the row by token makes cleanup
  // idempotent and self-healing across process boundaries.
  const orphans = await db
    .select({ id: pets.id })
    .from(pets)
    .where(eq(pets.publicToken, "DIM-PANO-BYTYPE"));
  const ids = orphans.map((r) => r.id);
  if (ids.length === 0) {
    petId = "";
    return;
  }
  await withMutationOverride(async (tx) => {
    await tx.delete(petEvents).where(inArray(petEvents.petId, ids));
  });
  await db.delete(pets).where(inArray(pets.id, ids));
  petId = "";
}

beforeAll(async () => {
  await cleanup();
  const [row] = await db
    .insert(pets)
    .values({
      publicToken: "DIM-PANO-BYTYPE",
      name: "PANO-ByType",
      species: "dog",
      sex: "male",
      status: "active",
      jurisdictionProvince: PROVINCE,
      jurisdictionLocality: LOCALITY,
    })
    .returning({ id: pets.id });
  petId = row.id;

  for (let i = 0; i < LOST_COUNT; i++) {
    await insertEvent("status_changed", { from_status: "active", to_status: "lost" });
  }
  for (let i = 0; i < SIGHTING_COUNT; i++) {
    await insertEvent("note_added", { category: "otro", text: "avistaje", kind: "sighting" });
  }
});

afterAll(cleanup);

describe("unit-history byType counts the full window, not the capped events (KA5)", () => {
  it("reports correct per-type totals even when in-window events exceed the 20 cap", async () => {
    const hist = await loadUnitHistory({
      layer: "perdidas",
      province: PROVINCE,
      locality: LOCALITY,
      since: SINCE,
      until: new Date(),
      actor: GOVT,
      jurisdictions: JURS,
    });

    // The events array is still capped at EVENT_LIMIT (20 most-recent).
    expect(hist.events.length).toBe(20);

    // byType reports the TRUE windowed totals — NOT a tally of the capped 20.
    expect(hist.byType.pet_lost).toBe(LOST_COUNT);
    expect(hist.byType.pet_found_sighting).toBe(SIGHTING_COUNT);

    const total = Object.values(hist.byType).reduce((s, n) => s + n, 0);
    expect(total).toBe(LOST_COUNT + SIGHTING_COUNT); // 25 — exceeds the 20-event cap
    expect(total).toBeGreaterThan(hist.events.length);
  }, 30_000);
});

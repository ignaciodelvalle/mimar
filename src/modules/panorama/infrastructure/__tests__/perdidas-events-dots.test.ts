// panorama-event-points Slice 1 — loadPerdidasEvents (REAL sighting dots).
//
// Integration test — local Supabase + Postgres. Asserts the near-zoom dot loader:
//   - SIGHTINGS ONLY (A3): a note_added kind='sighting' with coords becomes a dot;
//     a status_changed→lost WITH coords is NOT plotted (lost-mark is out of Slice 1).
//   - fallback honesty (§5): a coord-less sighting is counted into noCoordCount,
//     never plotted as a fake centroid dot.
//   - scope (A2): a govt operator sees ONLY their province's sightings (pet-home
//     attribution via petsScope) — a neighbouring province's sighting is excluded.
//   - occurredAt → LostPointRow.lastSeenAt mapping.
//
// Synthetic localities so only this test's pets are in scope (the national seed
// fills every real province).

import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, petEvents, pets } from "@/db";
import type { EventType } from "@/db/schema";
import { validateEventPayload } from "@/lib/events/event-schemas";
import type { DashboardActor, DashboardJurisdiction } from "@/lib/metrics";

import { withMutationOverride } from "../../../../../__tests__/_helpers/db-overrides";
import { loadPerdidasEvents } from "../repository";

const PROVINCE = "Santa Fe";
const LOCALITY = "PANORAMA-DOTS-ISO"; // synthetic — no seed collision
const OTHER_PROVINCE = "Córdoba";
const OTHER_LOCALITY = "PANORAMA-DOTS-OTHER";
const GOVT: DashboardActor = { role: "govt" };
const JURS: DashboardJurisdiction[] = [{ province: PROVINCE, locality: LOCALITY }];
const SINCE = new Date(Date.now() - 24 * 60 * 60 * 1000);

let petId = "";
let otherPetId = "";

async function insertSighting(
  targetPetId: string,
  opts: { lat: string | null; lng: string | null; source?: string; occurredAt?: Date },
): Promise<void> {
  await db.insert(petEvents).values({
    petId: targetPetId,
    eventType: "note_added",
    occurredAt: opts.occurredAt ?? new Date(),
    payload: validateEventPayload("note_added", {
      category: "otro",
      text: "avistaje",
      kind: "sighting",
      ...(opts.source ? { location_source: opts.source } : {}),
    }) as Record<string, unknown>,
    authorRole: "scanner",
    recordedByUserId: null,
    locationLat: opts.lat,
    locationLng: opts.lng,
  });
}

async function insertEvent(
  targetPetId: string,
  eventType: EventType,
  payload: Record<string, unknown>,
  loc?: { lat: string; lng: string },
): Promise<void> {
  await db.insert(petEvents).values({
    petId: targetPetId,
    eventType,
    occurredAt: new Date(),
    payload: validateEventPayload(eventType, payload) as Record<string, unknown>,
    authorRole: "owner",
    recordedByUserId: null,
    locationLat: loc?.lat ?? null,
    locationLng: loc?.lng ?? null,
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
      publicToken: "DIM-PANO-DOTS-1",
      name: "Dot-Test",
      species: "dog",
      sex: "male",
      status: "lost",
      jurisdictionProvince: PROVINCE,
      jurisdictionLocality: LOCALITY,
    })
    .returning({ id: pets.id });
  petId = row.id;

  const [other] = await db
    .insert(pets)
    .values({
      publicToken: "DIM-PANO-DOTS-2",
      name: "Dot-Other",
      species: "cat",
      sex: "female",
      status: "lost",
      jurisdictionProvince: OTHER_PROVINCE,
      jurisdictionLocality: OTHER_LOCALITY,
    })
    .returning({ id: pets.id });
  otherPetId = other.id;

  // In-scope sighting WITH coords → a dot.
  await insertSighting(petId, {
    lat: "-31.6333000",
    lng: "-60.7000000",
    source: "gps",
    occurredAt: new Date(Date.now() - 60 * 60 * 1000),
  });
  // In-scope sighting WITHOUT coords → residual, not a dot.
  await insertSighting(petId, { lat: null, lng: null });
  // A lost MARK with coords → must NOT be plotted (sightings only, A3).
  await insertEvent(
    petId,
    "status_changed",
    { from_status: "active", to_status: "lost" },
    { lat: "-31.6000000", lng: "-60.7100000" },
  );
  // Out-of-scope sighting (other province) WITH coords → excluded for GOVT.
  await insertSighting(otherPetId, { lat: "-31.4200000", lng: "-64.1800000" });
});

afterAll(cleanup);

describe("loadPerdidasEvents — real sighting dots (Slice 1)", () => {
  it("plots ONLY coord'd sightings; lost-marks and coord-less sightings are excluded from dots", async () => {
    const res = await loadPerdidasEvents(GOVT, JURS, SINCE);
    const mine = res.rows.filter((r) => r.publicToken === "DIM-PANO-DOTS-1");
    // Exactly one dot: the coord'd sighting. The lost-mark (with coords) and the
    // coord-less sighting are NOT plotted.
    expect(mine).toHaveLength(1);
    expect(mine[0].locationLat).toBe("-31.6333000");
    expect(mine[0].locationSource).toBe("gps");
    // occurredAt → lastSeenAt ISO mapping.
    expect(mine[0].lastSeenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  }, 30_000);

  it("counts the coord-less sighting into the 'sin ubicación exacta' residual", async () => {
    const res = await loadPerdidasEvents(GOVT, JURS, SINCE);
    expect(res.noCoordCount).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("scopes to the operator's OWN province — a neighbouring province's sighting is excluded", async () => {
    const res = await loadPerdidasEvents(GOVT, JURS, SINCE);
    expect(res.rows.some((r) => r.publicToken === "DIM-PANO-DOTS-2")).toBe(false);
  }, 30_000);

  it("admin (national) sees both provinces' sightings", async () => {
    const res = await loadPerdidasEvents({ role: "admin" }, [], SINCE);
    const tokens = res.rows.map((r) => r.publicToken);
    expect(tokens).toContain("DIM-PANO-DOTS-1");
    expect(tokens).toContain("DIM-PANO-DOTS-2");
  }, 30_000);
});

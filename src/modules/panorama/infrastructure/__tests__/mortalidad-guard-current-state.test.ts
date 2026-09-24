// Regression (KA3): the mortalidad unit-history k-anon guard must mirror the MAP
// numerator — pets CURRENTLY in status='deceased' (metricPredicate('mortality'),
// NO window) — exactly like every other current-state guard (cobertura,
// esterilizacion, microchip, ppp). The prior guard counted DISTINCT pets with a
// windowed `death_recorded` EVENT over the attacker-controlled [since, until]
// scrubber range. That let a department the MAP suppressed (current deceased < 5)
// clear k=5 in the guard for a wide-enough window and leak up to 20 death_recorded
// rows (dates + disposition_method) — a k-anon break.
//
// Deterministic: a synthetic locality with 3 pets CURRENTLY deceased (map counts 3
// → suppressed) plus 3 ACTIVE pets that each carry a `death_recorded` event in the
// window (a reversed / corrected death — the append-only log still holds the event,
// but the current state is NOT deceased). The old windowed guard saw 6 distinct
// pets with death events → cleared k=5 → LEAK. The new current-state guard sees 3
// deceased → suppressed — REGARDLESS of window width.
//
// Integration test — local Supabase + Postgres.

import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, petEvents, pets } from "@/db";
import type { EventType } from "@/db/schema";
import { validateEventPayload } from "@/lib/events/event-schemas";
import type { DashboardActor, DashboardJurisdiction } from "@/lib/metrics";

import { withMutationOverride } from "../../../../../__tests__/_helpers/db-overrides";
import { loadUnitHistory } from "../repository";

const PROVINCE = "Santa Fe";
const LOCALITY = "PANO-MORT-LOC"; // synthetic — no seed collision
const ADMIN: DashboardActor = { role: "admin" };
const JURS: DashboardJurisdiction[] = [];

const petIds: string[] = [];

async function makePet(token: string, status: "active" | "deceased"): Promise<string> {
  const [row] = await db
    .insert(pets)
    .values({
      publicToken: token,
      name: token,
      species: "dog",
      sex: "male",
      status,
      jurisdictionProvince: PROVINCE,
      jurisdictionLocality: LOCALITY,
    })
    .returning({ id: pets.id });
  return row.id;
}

async function insertDeathEvent(petId: string, occurredAt: Date): Promise<void> {
  await db.insert(petEvents).values({
    petId,
    eventType: "death_recorded" as EventType,
    occurredAt,
    payload: validateEventPayload("death_recorded", {
      cause: "natural",
      cause_detail: null,
      confirmed_by_vet: null,
      vet_name: null,
      disposition_method: "unknown",
      facility: null,
      death_at_clinic: null,
      clinic_name: null,
      vet_contacted_owner: null,
      vet_decided_alone: null,
      owner_to_private_crematorium: null,
      disease_code: null,
      confirmed_by_lab: null,
      is_reportable: false,
    }) as Record<string, unknown>,
    authorRole: "owner",
    authorVerified: false,
    recordedByUserId: null,
  });
}

async function cleanup(): Promise<void> {
  if (petIds.length) {
    await withMutationOverride(async (tx) => {
      await tx.delete(petEvents).where(inArray(petEvents.petId, petIds));
    });
    await db.delete(pets).where(inArray(pets.id, petIds));
    petIds.length = 0;
  }
}

const now = new Date();
const monthsAgo = (n: number) => new Date(now.getTime() - n * 30 * 24 * 60 * 60 * 1000);

beforeAll(async () => {
  await cleanup();
  // 3 CURRENTLY deceased pets — the map numerator = 3 (< 5 → suppressed on the map).
  for (let i = 0; i < 3; i++) {
    const id = await makePet(`DIM-PANO-MORT-D${i}`, "deceased");
    petIds.push(id);
    await insertDeathEvent(id, monthsAgo(i)); // spread across recent months
  }
  // 3 ACTIVE pets that each carry a death_recorded event in the window (reversed /
  // corrected deaths). The old windowed guard counted these → 6 distinct pets ≥ 5.
  for (let i = 0; i < 3; i++) {
    const id = await makePet(`DIM-PANO-MORT-A${i}`, "active");
    petIds.push(id);
    await insertDeathEvent(id, monthsAgo(i + 3));
  }
});

afterAll(cleanup);

describe("mortalidad unit-history guard mirrors the current-state map (KA3)", () => {
  it("suppresses a map-suppressed cell (current deceased < 5) — WIDE window (old guard would leak)", async () => {
    const hist = await loadUnitHistory({
      layer: "mortalidad",
      province: PROVINCE,
      locality: LOCALITY,
      // A wide window that spans ALL 6 death events — the exact condition under
      // which the old windowed guard cleared k=5 (6 distinct pets) and leaked.
      since: monthsAgo(24),
      until: now,
      actor: ADMIN,
      jurisdictions: JURS,
    });
    expect(hist.suppressed).toBe(true);
    expect(hist.events).toEqual([]);
  }, 30_000);

  it("suppresses REGARDLESS of window width — NARROW window", async () => {
    const hist = await loadUnitHistory({
      layer: "mortalidad",
      province: PROVINCE,
      locality: LOCALITY,
      since: monthsAgo(1),
      until: now,
      actor: ADMIN,
      jurisdictions: JURS,
    });
    expect(hist.suppressed).toBe(true);
    expect(hist.events).toEqual([]);
  }, 30_000);

  it("does NOT suppress once current deceased pets clear k=5 (mirrors the map)", async () => {
    // Add 2 more CURRENTLY deceased pets → 5 deceased → map shows the cell → history shown.
    for (let i = 3; i < 5; i++) {
      const id = await makePet(`DIM-PANO-MORT-D${i}`, "deceased");
      petIds.push(id);
      await insertDeathEvent(id, monthsAgo(i));
    }
    const hist = await loadUnitHistory({
      layer: "mortalidad",
      province: PROVINCE,
      locality: LOCALITY,
      since: monthsAgo(24),
      until: now,
      actor: ADMIN,
      jurisdictions: JURS,
    });
    expect(hist.suppressed ?? false).toBe(false);
    expect(hist.events.length).toBeGreaterThan(0);
  }, 30_000);
});

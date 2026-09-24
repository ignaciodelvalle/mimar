// tendencia loader — two-window event delta per province.
//
// Contract (see loadTendenciaByProvince):
//   value = events(current window) − events(prior equivalent window), both
//   windows RAW (pre-suppression) into deltaCells.
//   k-anon DIFFERENCING RULE: a cell publishes NO delta when EITHER window
//   carries a protected count (0 < n < 5) — otherwise "Δ = current − prior"
//   would reveal the protected window by subtraction. A count of exactly 0 is
//   NOT protected ("+N desde cero" is as public as the visible window itself).
//
// Deterministic against the national seed: govt actors scoped to SYNTHETIC
// localities, so each scope's two windows are exactly the fixture events.
//
// Integration test — local Supabase + Postgres.

import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, petEvents, pets } from "@/db";
import type { EventType } from "@/db/schema";
import { validateEventPayload } from "@/lib/events/event-schemas";
import type { DashboardActor, DashboardJurisdiction } from "@/lib/metrics";

import { withMutationOverride } from "../../../../../__tests__/_helpers/db-overrides";
import { loadTendenciaByProvince } from "../repository";

const PROVINCE = "Santa Fe";
const PROVINCE_CODE = "AR-S";
const LOC_VISIBLE = "PANORAMA-TD-VIS"; // current 7, prior 5 → Δ +2
const LOC_DIFFERENCING = "PANORAMA-TD-DIFF"; // current 7, prior 3 (< k) → suppressed
const LOC_FROM_ZERO = "PANORAMA-TD-ZERO"; // current 6, prior 0 → Δ +6 (public)

const GOVT: DashboardActor = { role: "govt" };
const jurs = (locality: string): DashboardJurisdiction[] => [{ province: PROVINCE, locality }];

const DAY_MS = 86_400_000;
const SINCE = new Date(Date.now() - 30 * DAY_MS);
const IN_CURRENT = new Date(Date.now() - 2 * DAY_MS); // inside [since, now]
const IN_PRIOR = new Date(Date.now() - 35 * DAY_MS); // inside [since-30d, since)

const petIds: string[] = [];

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
  petIds.push(row.id);
  return row.id;
}

async function insertEvents(
  petId: string,
  occurredAt: Date,
  n: number,
  // Since 2026-07-25 the layer counts INCIDENTS only — registry activity growth
  // is adoption, not deterioration. Parameterised so a test can prove the
  // exclusion, not just the arithmetic.
  eventType: EventType = "incident_reported" as EventType,
): Promise<void> {
  for (let i = 0; i < n; i++) {
    const payload =
      eventType === ("incident_reported" as EventType)
        ? validateEventPayload("incident_reported", {
            incident_type: "bite_inflicted",
            severity: "minor",
            injuries_summary: null,
            vet_involved: null,
          })
        : validateEventPayload("note_added", {
            category: "otro",
            text: `tendencia fixture ${i}`,
          });
    await db.insert(petEvents).values({
      petId,
      eventType,
      occurredAt,
      payload: payload as Record<string, unknown>,
      authorRole: "owner",
      recordedByUserId: null,
    });
  }
}

async function cleanup(): Promise<void> {
  if (petIds.length === 0) return;
  await withMutationOverride(async (tx) => {
    await tx.delete(petEvents).where(inArray(petEvents.petId, petIds));
  });
  await db.delete(pets).where(inArray(pets.id, petIds));
  petIds.length = 0;
}

beforeAll(async () => {
  const visible = await makePet("DIM-TDV-0001", LOC_VISIBLE);
  await insertEvents(visible, IN_CURRENT, 7);
  await insertEvents(visible, IN_PRIOR, 5);

  const differencing = await makePet("DIM-TDD-0001", LOC_DIFFERENCING);
  await insertEvents(differencing, IN_CURRENT, 7);
  await insertEvents(differencing, IN_PRIOR, 3); // protected prior (0 < 3 < 5)

  const fromZero = await makePet("DIM-TDZ-0001", LOC_FROM_ZERO);
  await insertEvents(fromZero, IN_CURRENT, 6); // prior window: nothing at all
});

afterAll(cleanup);

describe("loadTendenciaByProvince — delta value", () => {
  it("publishes Δ = current − prior when both windows are ≥ k (7 − 5 = +2)", async () => {
    const res = await loadTendenciaByProvince(GOVT, jurs(LOC_VISIBLE), SINCE);
    expect(res.cells).toHaveLength(1);
    expect(res.cells[0].provinceCode).toBe(PROVINCE_CODE);
    expect(res.cells[0].value).toBe(2);
    expect(res.suppressedCount).toBe(0);
  }, 30_000);

  it("publishes a from-zero delta (+6) — an empty window is not a protected one", async () => {
    const res = await loadTendenciaByProvince(GOVT, jurs(LOC_FROM_ZERO), SINCE);
    expect(res.cells).toHaveLength(1);
    expect(res.cells[0].value).toBe(6);
    expect(res.suppressedCount).toBe(0);
  }, 30_000);
});

describe("loadTendenciaByProvince — the differencing rule", () => {
  it("suppresses the cell when the PRIOR window is protected (prior 3 < k)", async () => {
    // Publishing Δ = 7 − 3 = +4 next to the visible current 7 would reveal the
    // protected prior count by subtraction — the exact leak the rule prevents.
    const res = await loadTendenciaByProvince(GOVT, jurs(LOC_DIFFERENCING), SINCE);
    expect(res.suppressedCount).toBe(1);
    // ⚠️ THIS ASSERTION USED TO READ `expect(res.cells).toHaveLength(0)` — it
    // PINNED the defect (#40). A protected cell that DISAPPEARS is itself a
    // disclosure channel: a province dropping out between two frames announces
    // that one of its windows crossed k. And downstream it was worse than the
    // leak it prevented — with no cell, the D.5(b) overlay stippled the province
    // as "sin datos", i.e. "nadie reportó incidentes acá", the opposite of the
    // truth. The cell is now PRESENT and suppressed, so the map hatches it.
    expect(res.cells).toHaveLength(1);
    expect(res.cells[0].provinceCode).toBe(PROVINCE_CODE);
    expect(res.cells[0].suppressed).toBe(true);
    expect(res.cells[0].value).toBeNull();
  }, 30_000);

  it("a suppressed delta publishes NULL, never 0 (a false zero reads as 'no change')", async () => {
    const res = await loadTendenciaByProvince(GOVT, jurs(LOC_DIFFERENCING), SINCE);
    expect(res.cells[0].value).not.toBe(0);
    expect(res.cells[0].value).toBeNull();
  }, 30_000);
});

describe("loadTendenciaByProvince — counts INCIDENTS, not registry activity", () => {
  it("a 40-vs-1 swing in registry events moves the delta by zero", async () => {
    // The bug this locks, measured live 2026-07-25: counting every pet_event
    // made the four biggest types — pet_registered, vaccination_administered,
    // microchip_implanted, sterilization_performed (~174k of ~200k) — dominate
    // the delta. With inverted polarity ("more than before = warning pole") the
    // map painted 24 of 24 provinces as deteriorating while the driver was
    // registry ADOPTION. A view that reports uptake as decay is worse than none.
    const before = await loadTendenciaByProvince(GOVT, jurs(LOC_VISIBLE), SINCE);
    const valueBefore = before.cells.find((c) => c.provinceCode === PROVINCE_CODE)?.value;

    const noisy = await makePet("DIM-TEND-REG1", LOC_VISIBLE);
    await insertEvents(noisy, IN_CURRENT, 40, "note_added" as EventType);
    await insertEvents(noisy, IN_PRIOR, 1, "note_added" as EventType);

    const after = await loadTendenciaByProvince(GOVT, jurs(LOC_VISIBLE), SINCE);
    const valueAfter = after.cells.find((c) => c.provinceCode === PROVINCE_CODE)?.value;

    expect(valueAfter).toBe(valueBefore);
  });
});

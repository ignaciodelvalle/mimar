// desierto-veterinario loader — SHARE OF ACTIVE PETS WITH NO VETERINARY ACT.
//
// Contract (see loadVetDesertByProvince):
//   value = 100 × (activePets − attendedPets) / activePets, one decimal
//     activePets   = pets in scope with status active/lost (the denominator AND
//                    the k-anon dimension).
//     attendedPets = DISTINCT pets of that universe with ≥1 event of
//                    VET_ACTIVITY_EVENT_TYPES inside [since, until].
//   k-anon: a scoped province universe with < 5 ACTIVE pets gets NO cell and is
//   counted in suppressedCount.
//
// SUPERSEDES the recency framing ("days since the last veterinary act"), which
// was a MAX over thousands of pets and therefore pinned to one pole: measured
// 2026-07-26 it returned 0 days for 20 of 24 provinces and 1 day for the other
// 4 — two distinct values nationally. The per-pet share discriminates
// (24,6% Mendoza → 80,7% Salta over 90 days).
//
// FIXTURE DISCIPLINE: every pair of localities below differs on EXACTLY ONE
// axis, so a passing assertion can only be explained by that axis.
//   BASE  vs VAX      → event TYPE (visit / vaccination), everything else equal.
//   BASE  vs DEWORM   → event TYPE (visit / deworming), everything else equal.
//   BASE  vs OLD      → event DATE (inside / outside the window).
//   BASE  vs REPEAT   → events PER PET (3 pets × 1 / 1 pet × 3).
//   ALL   vs DECEASED → the presence of non-active pets in the universe.
//
// Deterministic against the national seed: govt actors scoped to SYNTHETIC
// localities (no seed collision), so the pets universe within scope is exactly
// the fixture — the assertions pin the loader's contract, not seed volume.
//
// Integration test — local Supabase + Postgres.

import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, petEvents, pets } from "@/db";
import type { EventType } from "@/db/schema";
import { validateEventPayload } from "@/lib/events/event-schemas";
import type { DashboardActor, DashboardJurisdiction } from "@/lib/metrics";

import { withMutationOverride } from "../../../../../__tests__/_helpers/db-overrides";
import { loadVetDesertByProvince } from "../repository";

const PROVINCE = "Santa Fe";
const PROVINCE_CODE = "AR-S";

// Disjoint synthetic localities → disjoint scoped universes, one per assertion.
const LOC_NONE = "PANORAMA-VU-NONE"; // 6 active pets, no veterinary act at all
const LOC_ALL = "PANORAMA-VU-ALL"; // 6 active pets, all 6 attended
const LOC_BASE = "PANORAMA-VU-BASE"; // 6 active pets, 3 attended by a vet visit
const LOC_VAX = "PANORAMA-VU-VAX"; // idem, but the act is a vaccination
const LOC_DEWORM = "PANORAMA-VU-DEWORM"; // idem, but the act is a deworming
const LOC_OLD = "PANORAMA-VU-OLD"; // idem, but the visit predates the window
const LOC_REPEAT = "PANORAMA-VU-REPEAT"; // 6 pets, ONE pet with 3 visits
const LOC_DECEASED = "PANORAMA-VU-DECEASED"; // 6 attended active + 4 deceased
const LOC_LATE_REG = "PANORAMA-VU-LATEREG"; // 5 registered long ago + 5 after the cut
const LOC_DIED_LATER = "PANORAMA-VU-DIEDLATER"; // 6 alive at the cut, 3 died after it
const LOC_SUBK = "PANORAMA-VU-SUBK"; // 2 active pets (< k=5) → suppressed

const GOVT: DashboardActor = { role: "govt" };
const jurs = (locality: string): DashboardJurisdiction[] => [{ province: PROVINCE, locality }];

const DAY_MS = 86_400_000;
const SINCE = new Date(Date.now() - 30 * DAY_MS);
const INSIDE_WINDOW = new Date(Date.now() - 10 * DAY_MS);
// The replay cut sits INSIDE the 30-day window, so [since, cut] is a real
// window with room for acts on either side of it. First written with the cut
// equal to `since`, which made the replay window empty and the fixture unable
// to discriminate anything.
const LONG_AGO = new Date("2019-01-01T00:00:00Z");
const REPLAY_CUT = new Date(Date.now() - 15 * 86_400_000);
const ACT_BEFORE_CUT = new Date(Date.now() - 20 * 86_400_000);
const AFTER_CUT = new Date(Date.now() - 5 * 86_400_000);
const BEFORE_WINDOW = new Date(Date.now() - 200 * DAY_MS);

const petIds: string[] = [];
let seq = 0;

/**
 * A pet in the universe, anchored in the spine.
 *
 * `registeredAt` matters since the as-of-t denominator (PO decision D3): the
 * universe is "pets registered before t and not deceased at t", and both facts
 * are read from the event log, not from the cache columns. These fixtures used
 * to insert a pets row with NO pet_registered event at all — a cache row with
 * no spine anchor, which is exactly the state invariant #3 forbids and
 * lint:spine now blocks in the seeds.
 */
async function makePet(
  locality: string,
  status: "active" | "deceased" = "active",
  registeredAt: Date = new Date("2020-01-01T00:00:00Z"),
): Promise<string> {
  seq += 1;
  const token = `DIM-VU-${String(seq).padStart(4, "0")}`;
  const [row] = await db
    .insert(pets)
    .values({
      publicToken: token,
      name: token,
      species: "dog",
      sex: "male",
      status,
      jurisdictionProvince: PROVINCE,
      jurisdictionLocality: locality,
    })
    .returning({ id: pets.id });
  petIds.push(row.id);
  await db.insert(petEvents).values({
    petId: row.id,
    eventType: "pet_registered" as EventType,
    occurredAt: registeredAt,
    payload: {},
    authorRole: "owner",
    recordedByUserId: null,
  });
  return row.id;
}

/** Record a status transition in the spine, the way the app does. */
async function addStatusChange(
  petId: string,
  toStatus: "active" | "lost" | "deceased",
  occurredAt: Date,
): Promise<void> {
  await db.insert(petEvents).values({
    petId,
    eventType: "status_changed" as EventType,
    occurredAt,
    payload: { from_status: "active", to_status: toStatus, payload_version: 1 },
    authorRole: "owner",
    recordedByUserId: null,
  });
}

const PAYLOADS: Record<string, Record<string, unknown>> = {
  vet_visit_logged: { reason: "control", diagnosis: null, vet_name: null, clinic: null },
  vaccination_administered: {
    vaccine_name: "Antirrábica",
    brand: null,
    batch: null,
    administered_by: null,
    next_due_at: null,
  },
  deworming_administered: {
    product: "Antiparasitario",
    type: "internal",
    administered_by: null,
    next_due_at: null,
  },
};

async function addAct(petId: string, eventType: string, occurredAt: Date): Promise<void> {
  await db.insert(petEvents).values({
    petId,
    eventType: eventType as EventType,
    occurredAt,
    payload: validateEventPayload(eventType as EventType, PAYLOADS[eventType]) as Record<
      string,
      unknown
    >,
    authorRole: "vet",
    recordedByUserId: null,
  });
}

/** N active pets in `locality`, the first `attended` of them carrying one act. */
async function seedUniverse(
  locality: string,
  size: number,
  attended: number,
  eventType: string,
  occurredAt: Date,
): Promise<void> {
  for (let i = 0; i < size; i++) {
    const id = await makePet(locality);
    if (i < attended) await addAct(id, eventType, occurredAt);
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
  // 6 pets, none attended → 100% unattended.
  await seedUniverse(LOC_NONE, 6, 0, "vet_visit_logged", INSIDE_WINDOW);
  // 6 pets, all attended → 0% unattended.
  await seedUniverse(LOC_ALL, 6, 6, "vet_visit_logged", INSIDE_WINDOW);
  // The BASE fixture the next four are compared against: 3 of 6 attended → 50%.
  await seedUniverse(LOC_BASE, 6, 3, "vet_visit_logged", INSIDE_WINDOW);
  // Axis: event TYPE. A vaccination is a veterinary act → same 50%.
  await seedUniverse(LOC_VAX, 6, 3, "vaccination_administered", INSIDE_WINDOW);
  // Axis: event TYPE. Deworming is over-the-counter and owner-applied → 100%.
  await seedUniverse(LOC_DEWORM, 6, 3, "deworming_administered", INSIDE_WINDOW);
  // Axis: event DATE. The same visits, 200 days back → outside the window → 100%.
  await seedUniverse(LOC_OLD, 6, 3, "vet_visit_logged", BEFORE_WINDOW);
  // Axis: events PER PET. One pet attended three times → 5 of 6 unattended.
  for (let i = 0; i < 6; i++) {
    const id = await makePet(LOC_REPEAT);
    if (i === 0) {
      await addAct(id, "vet_visit_logged", INSIDE_WINDOW);
      await addAct(id, "vet_visit_logged", new Date(Date.now() - 9 * DAY_MS));
      await addAct(id, "vet_visit_logged", new Date(Date.now() - 8 * DAY_MS));
    }
  }
  // Axis: non-active pets in the universe. 6 attended active + 4 deceased that
  // were never attended — the deceased must not dilute a live-population share.
  await seedUniverse(LOC_DECEASED, 6, 6, "vet_visit_logged", INSIDE_WINDOW);
  for (let i = 0; i < 4; i++) await makePet(LOC_DECEASED, "deceased");
  // Sub-k universe: 2 active pets → suppressed, no cell.
  await seedUniverse(LOC_SUBK, 2, 1, "vet_visit_logged", INSIDE_WINDOW);

  // ---- as-of-t denominator fixtures (PO decision D3) --------------------
  // Both fixtures are built so the replay and the live view give DIFFERENT
  // percentages. A fixture where both answers agree cannot tell whether the
  // denominator travelled — it would pass before the fix and after it.
  //
  // LATE_REG: 5 registered long ago and ALL attended inside the window, plus 5
  // registered after the cut and never attended.
  //   live   → 10 pets, 5 attended  → 50% unattended
  //   replay →  5 pets, 5 attended  →  0% unattended
  for (let i = 0; i < 5; i++) {
    const id = await makePet(LOC_LATE_REG, "active", LONG_AGO);
    await addAct(id, "vet_visit_logged", ACT_BEFORE_CUT);
  }
  for (let i = 0; i < 5; i++) await makePet(LOC_LATE_REG, "active", AFTER_CUT);

  // DIED_LATER: 9 registered long ago; the 3 that die after the cut are the
  // attended ones, so removing them changes the share as well as the universe.
  //   live   → 6 alive,  0 attended → 100% unattended
  //   replay → 9 alive,  3 attended →  67% unattended
  for (let i = 0; i < 9; i++) {
    const id = await makePet(LOC_DIED_LATER, "active", LONG_AGO);
    if (i < 3) {
      await addAct(id, "vet_visit_logged", ACT_BEFORE_CUT);
      await addStatusChange(id, "deceased", AFTER_CUT);
      // The app dual-writes: the event is the fact, the column is the cache the
      // live view reads. A fixture that only wrote the event would leave the
      // live view seeing a pet the spine says is dead.
      await db.update(pets).set({ status: "deceased" }).where(eq(pets.id, id));
    }
  }
}, 60_000);

afterAll(cleanup);

/** The single province cell the scoped loader returns.
 *
 * #40: every fixture universe here is >= 5 active pets, so the cell must come
 * back VISIBLE. Asserting that explicitly is the point — if a future fixture
 * shrinks below k the cell turns suppressed (value null), and this would
 * otherwise fail as a confusing null comparison instead of naming the cause. */
async function pctFor(locality: string, asOf?: Date): Promise<number> {
  const res = await loadVetDesertByProvince(GOVT, jurs(locality), SINCE, asOf);
  expect(res.cells).toHaveLength(1);
  expect(res.cells[0].provinceCode).toBe(PROVINCE_CODE);
  expect(res.cells[0].suppressed).toBe(false);
  const value = res.cells[0].value;
  if (value === null) throw new Error("k-anon suppressed: fixture universe fell below k=5");
  return value;
}

describe("loadVetDesertByProvince — share of active pets with no veterinary act", () => {
  it("reports 100% when no pet in the universe was attended in the period", async () => {
    expect(await pctFor(LOC_NONE)).toBe(100);
  }, 30_000);

  it("reports 0% when every pet in the universe was attended", async () => {
    expect(await pctFor(LOC_ALL)).toBe(0);
  }, 30_000);

  it("reports the share, not a duration (3 of 6 attended → 50%)", async () => {
    expect(await pctFor(LOC_BASE)).toBe(50);
  }, 30_000);

  it("counts a vaccination as attention — identical fixture, only the event type differs", async () => {
    // LOC_VAX is LOC_BASE with vaccination_administered in place of
    // vet_visit_logged. Same universe size, same attended count, same date.
    expect(await pctFor(LOC_VAX)).toBe(await pctFor(LOC_BASE));
    expect(await pctFor(LOC_VAX)).toBe(50);
  }, 30_000);

  it("does NOT count a deworming — identical fixture, only the event type differs", async () => {
    // Antiparasitics are sold over the counter and applied at home, so counting
    // them would measure owner diligence instead of access to a professional.
    expect(await pctFor(LOC_DEWORM)).toBe(100);
  }, 30_000);

  it("ignores acts OUTSIDE the period — identical fixture, only the date differs", async () => {
    // The recency framing this replaces had NO lower bound: a visit from two
    // years ago still counted. "Sin atención en el período" must mean the period.
    expect(await pctFor(LOC_OLD)).toBe(100);
  }, 30_000);

  it("counts PETS attended, not acts — one pet visited 3 times leaves 5 of 6 unattended", async () => {
    expect(await pctFor(LOC_REPEAT)).toBe(83.3);
  }, 30_000);

  it("excludes non-active pets from the universe (deceased never dilute the share)", async () => {
    // 6 attended active pets + 4 deceased. Counting all 10 would report 40%.
    expect(await pctFor(LOC_DECEASED)).toBe(0);
  }, 30_000);

  it("replays the share as of t (asOf before the acts → nobody attended yet)", async () => {
    const asOf = new Date(Date.now() - 20 * DAY_MS);
    expect(await pctFor(LOC_BASE, asOf)).toBe(100);
  }, 30_000);

  it("never reports a value outside 0-100 (a share is bounded by construction)", async () => {
    for (const loc of [LOC_NONE, LOC_ALL, LOC_BASE, LOC_REPEAT]) {
      const v = await pctFor(loc);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  }, 60_000);
});

// PO decision D3 (2026-07-28). The claim "asOf moves `until`, replaying the
// share as of t" was only half true: the NUMERATOR travelled (events filtered
// to [since, asOf]) while the DENOMINATOR stayed today's population. A pet
// registered yesterday joined the denominator of a replay from six months ago,
// and one that died last week was missing from a replay in which it was alive.
// The PO chose the honest replay over a caption disclaiming it.
describe("loadVetDesertByProvince — the denominator travels with the numerator (D3)", () => {
  it("excludes pets registered AFTER the replay cut", async () => {
    // Live: 10 pets, 5 attended → 50%. At the cut only the 5 attended existed.
    expect(await pctFor(LOC_LATE_REG)).toBe(50);
    expect(await pctFor(LOC_LATE_REG, REPLAY_CUT)).toBe(0);
  });

  it("counts a pet that was alive AT the cut even though it died later", async () => {
    // Live: the 3 attended ones are gone → 6 pets, 0 attended → 100%.
    // At the cut all 9 were alive and 3 had been attended → 67%.
    expect(await pctFor(LOC_DIED_LATER)).toBe(100);
    expect(await pctFor(LOC_DIED_LATER, REPLAY_CUT)).toBeCloseTo(66.7, 1);
  });
});

describe("loadVetDesertByProvince — k-anon on the ACTIVE-pet universe", () => {
  it("suppresses a sub-k universe as a PRESENT, valueless cell (not an absent one)", async () => {
    // ⚠️ This assertion used to be `expect(res.cells).toHaveLength(0)` — the
    // same defect #40 fixed in tendencia. Dropping the cell made the province
    // disappear, and the D.5(b) overlay then stippled it as "sin datos", which
    // reads as "nadie reportó acá". The truth is the opposite: there ARE pets,
    // just too few for the share to describe them without identifying them.
    // Absence is also a channel — a province that vanishes announces it crossed k.
    const res = await loadVetDesertByProvince(GOVT, jurs(LOC_SUBK), SINCE);
    expect(res.suppressedCount).toBe(1);
    expect(res.cells).toHaveLength(1);
    expect(res.cells[0].suppressed).toBe(true);
    expect(res.cells[0].value).toBeNull();
    // Never a 0 — on this layer 0% means "every pet was attended", the most
    // reassuring reading on the map. A false zero here would be the worst
    // possible substitution.
    expect(res.cells[0].value).not.toBe(0);
  }, 30_000);
});

// Task #40b — k-anonymity at PROVINCE grain for the aggregated-point loaders and
// the unit-history panel.
//
// THE DEFECT THIS PINS. Task #40 applied k=5 to province choropleth cells and was
// closed, but it only covered the choropleth loaders. The premise it retired —
// "no k-anon at province level, province cells are large" — stayed live in the
// per-unit point loaders, cited verbatim. On a DENSITY/SIGNAL layer the plotted
// count IS the protected population, so a province with two bite events published
// a bubble reading "2": a group of two identifiable animals, at national zoom,
// named. The premise was true of a province's POPULATION and false of its
// DENOMINATOR — which is what k-anonymity is about.
//
// The unit-history panel is the second half. Suppressing the bubble while
// `/api/panorama/unit-history?province=X` (no `locality`) still returned the full
// event list would be a fence with a gate — and a client-side check would not
// close it, since the API is directly callable.
//
// Integration test — local Supabase + Postgres. Govt scope to SYNTHETIC localities
// so only this file's fixtures are in scope (the national seed fills every real
// province).

import { inArray, sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { withMutationOverride } from "@/__tests__/_helpers/db-overrides";
import { db, petEvents, pets } from "@/db";
import type { DashboardActor, DashboardJurisdiction } from "@/lib/metrics";

import { loadPerdidasByUnit, loadUnitHistory } from "../repository";

/** The policy k. Mirrors ANONYMITY_K / the loader's K_ANON — not a magic 5. */
const K = 5;

const PROV_A = "Formosa";
const PROV_B = "Catamarca";
const LOC_A = "PANORAMA-K40B-A"; // synthetic — no seed collision
const LOC_B = "PANORAMA-K40B-B";
const TOKEN_PREFIX = "DIM-K40B-";

const GOVT: DashboardActor = { role: "govt" };
const JURS_A: DashboardJurisdiction[] = [{ province: PROV_A, locality: LOC_A }];
const JURS_BOTH: DashboardJurisdiction[] = [
  { province: PROV_A, locality: LOC_A },
  { province: PROV_B, locality: LOC_B },
];
const SINCE = new Date(Date.now() - 24 * 60 * 60 * 1000);

async function cleanup(): Promise<void> {
  const rows = await db
    .select({ id: pets.id })
    .from(pets)
    .where(sql`${pets.publicToken} LIKE ${`${TOKEN_PREFIX}%`}`);
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return;
  // pet_events has a BEFORE DELETE trigger; the GUC override is the escape hatch.
  await withMutationOverride(async (tx) => {
    await tx.delete(petEvents).where(inArray(petEvents.petId, ids));
  });
  await db.delete(pets).where(inArray(pets.id, ids));
}

/** Seed `n` `perdidas`-qualifying events (status_changed → lost) in a unit. */
async function seedLost(province: string, locality: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const [row] = await db
      .insert(pets)
      .values({
        publicToken: `${TOKEN_PREFIX}${province.slice(0, 3)}${String(i).padStart(3, "0")}`,
        name: `K40B-${i}`,
        species: "dog",
        status: "active",
        jurisdictionProvince: province,
        jurisdictionLocality: locality,
      })
      .returning({ id: pets.id });
    await db.insert(petEvents).values({
      petId: row.id,
      eventType: "status_changed",
      occurredAt: new Date(),
      payload: { payload_version: 1, from_status: "active", to_status: "lost" },
      authorRole: "system",
      recordedByUserId: null,
    });
  }
}

beforeAll(cleanup);
afterEach(cleanup);

describe("aggregated point loaders — k-anon at province grain (#40b)", () => {
  it("suppresses a sub-k province: the cell is EMITTED with count null, never dropped", async () => {
    await seedLost(PROV_A, LOC_A, 2);

    const res = await loadPerdidasByUnit("province", GOVT, JURS_A, SINCE);
    const cell = res.cells.find((c) => c.province === PROV_A);

    expect(cell).toBeDefined();
    expect(cell?.suppressed).toBe(true);
    // null, NOT 0. A false zero asserts "nothing happened here", which is both
    // untrue and indistinguishable from a real measurement.
    expect(cell?.count).toBeNull();
    // THE DISCLOSURE: the console's "N unidades suprimidas por k-anonimato" line
    // reads this. Suppressing while reporting 0 hides data and tells nobody.
    expect(res.suppressedCount).toBe(1);
  }, 30_000);

  it("does NOT suppress at EXACTLY k — the comparison is `>= k`, not `> k`", async () => {
    await seedLost(PROV_A, LOC_A, K);

    const res = await loadPerdidasByUnit("province", GOVT, JURS_A, SINCE);
    const cell = res.cells.find((c) => c.province === PROV_A);

    expect(cell).toBeDefined();
    expect(cell?.suppressed).toBe(false);
    expect(cell?.count).toBe(K);
    expect(res.suppressedCount).toBe(0);
  }, 30_000);

  it("is one below k at k-1 — the boundary bites on the very next event", async () => {
    await seedLost(PROV_A, LOC_A, K - 1);

    const res = await loadPerdidasByUnit("province", GOVT, JURS_A, SINCE);
    const cell = res.cells.find((c) => c.province === PROV_A);

    expect(cell?.suppressed).toBe(true);
    expect(cell?.count).toBeNull();
    expect(res.suppressedCount).toBe(1);
  }, 30_000);

  it("applies COMPLEMENTARY suppression across provinces (the differencing defense)", async () => {
    // A lone suppressed province is recoverable from a published scope total by
    // subtraction: hidden = total − Σ(visible). So the smallest visible sibling
    // goes too, and the group at this grain is the whole scope ("national") —
    // NOT per-province, which at province grain would be a group of one and a
    // silent no-op.
    await seedLost(PROV_A, LOC_A, K); // clears k on its own
    await seedLost(PROV_B, LOC_B, 2); // protected

    const res = await loadPerdidasByUnit("province", GOVT, JURS_BOTH, SINCE);
    const a = res.cells.find((c) => c.province === PROV_A);
    const b = res.cells.find((c) => c.province === PROV_B);

    expect(b?.suppressed).toBe(true);
    expect(b?.count).toBeNull();
    // The complement: A is above k but is withheld anyway, because publishing it
    // alongside the scope total would reveal B.
    expect(a?.suppressed).toBe(true);
    expect(a?.count).toBeNull();
    expect(res.suppressedCount).toBe(2);
    // The invariant, stated directly: nothing published, nothing derivable.
    for (const c of res.cells) {
      if (c.suppressed) expect(c.count).toBeNull();
    }
  }, 30_000);
});

describe("unit-history — k-anon guard at province grain (#40b)", () => {
  it("suppresses the province history panel below k — no events, no trend", async () => {
    await seedLost(PROV_A, LOC_A, 2);

    const hist = await loadUnitHistory({
      layer: "perdidas",
      province: PROV_A,
      locality: null, // ← the province-grain request that used to be exempt
      since: SINCE,
      until: new Date(),
      actor: GOVT,
      jurisdictions: JURS_A,
    });

    expect(hist.suppressed).toBe(true);
    expect(hist.events).toEqual([]);
    expect(hist.trend).toEqual([]);
    expect(hist.byType).toEqual({});
  }, 30_000);

  it("returns the province history at exactly k — the guard does not over-suppress", async () => {
    await seedLost(PROV_A, LOC_A, K);

    const hist = await loadUnitHistory({
      layer: "perdidas",
      province: PROV_A,
      locality: null,
      since: SINCE,
      until: new Date(),
      actor: GOVT,
      jurisdictions: JURS_A,
    });

    expect(hist.suppressed).toBeUndefined();
    expect(hist.events.map((e) => e.type)).toContain("pet_lost");
    expect(hist.trend.reduce((s, bucket) => s + bucket.count, 0)).toBeGreaterThanOrEqual(K);
  }, 30_000);
});

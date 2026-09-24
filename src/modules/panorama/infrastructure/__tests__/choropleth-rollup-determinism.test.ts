// DB-backed integration test for the LOCALITY rollup's cap determinism
// (PO decision 2026-08-05).
//
// THE DEFECT THIS PINS. `rollupPetsPerLocality` aggregates pets by
// (province, locality) and then applies `.limit(PER_LAYER_CAP)`. That LIMIT
// carried NO ORDER BY, so which localities survived was whatever the planner
// emitted first: two loads of the SAME data could serve DIFFERENT subsets of
// the national + department view, and an operator watching the map could not
// distinguish a real change from a reshuffle. It also made the live-vs-cube
// comparison in application/__tests__/cube-parity.test.ts compare against a
// moving target — that suite's (2a) block cites this exact "carries no ORDER BY"
// property as the reason a raw set difference proves nothing there.
//
// THE CONTRACT. `n DESC, province ASC, locality ASC` — a TOTAL order over the
// grouped rows (the pair is the group key, so it is unique), which makes the
// truncated set a pure function of the data:
//   · LARGEST-FIRST — no locality is dropped while a smaller one is kept.
//   · STABLE — repeated loads return the same rows in the same order.
//
// FIXTURE. microchip-penetration at admin-national: the panorama seed has ~3.6k
// (province, locality) groups for it, well past PER_LAYER_CAP=2000, so the cap
// genuinely fires. Mortality (~150 groups) would not truncate at all and could
// not exercise this. cube-parity.test.ts asserts the same truncation from the
// loader side (`expect(live.truncated).toBe(true)` for microchip national).

import { describe, expect, it } from "vitest";

import { sql } from "drizzle-orm";

import { db } from "@/db";
import type { DashboardActor } from "@/lib/metrics";

import { metricPredicate, rollupPetsPerLocality } from "../repository-choropleth";
import { PER_LAYER_CAP, petsScope } from "../repository-scope";

const ADMIN: DashboardActor = { role: "admin" };

/** The rollup under test, at admin-national scope. */
async function microchipRollup() {
  return rollupPetsPerLocality([metricPredicate("microchip-penetration")], petsScope(ADMIN, []));
}

/**
 * The TRUE per-locality counts for the same metric + scope, queried directly.
 * Test-only elevated access: it deliberately bypasses the cap so the test can
 * see the localities the cap dropped, which is the only way to check that the
 * ones it kept are the largest.
 */
async function trueCounts(): Promise<Map<string, number>> {
  const rows = await db.execute<{ province: string; locality: string; n: string }>(sql`
    SELECT jurisdiction_province AS province,
           jurisdiction_locality AS locality,
           COUNT(DISTINCT id) AS n
    FROM pets
    WHERE jurisdiction_locality IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM pet_identifications pi
        WHERE pi.pet_id = pets.id
          AND pi.kind = 'microchip_iso'
          AND pi.status = 'active'
      )
    GROUP BY 1, 2
  `);
  return new Map(rows.map((r) => [`${r.province}|${r.locality}`, Number(r.n)]));
}

describe("locality rollup — the cap keeps the largest localities, deterministically", () => {
  it("truncates at the cap, ordered by count DESC, with no duplicate cells", async () => {
    const rows = await microchipRollup();

    // The fixture premise: without truncation there is nothing to order.
    expect(
      rows.length,
      "the microchip seed must exceed PER_LAYER_CAP for this test to mean anything",
    ).toBe(PER_LAYER_CAP);

    // Ordering: counts never rise as the array advances.
    for (let i = 1; i < rows.length; i++) {
      expect(
        rows[i].count,
        `rollup is not ordered by count DESC at index ${i}: ${rows[i - 1].count} then ${rows[i].count}`,
      ).toBeLessThanOrEqual(rows[i - 1].count);
    }

    // The (province, locality) pair is the GROUP BY key, so it is unique — which
    // is what makes the tiebreaker a TOTAL order rather than a partial one.
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  }, 120_000);

  it("keeps the LARGEST localities — nothing bigger than the cut is dropped", async () => {
    const [rows, truth] = await Promise.all([microchipRollup(), trueCounts()]);
    const kept = new Set(rows.map((r) => r.key));
    const cut = rows[rows.length - 1].count;

    // Every locality strictly ABOVE the cut must be present. This is the
    // assertion the missing ORDER BY violated: it held only by luck before.
    // (Rows exactly AT the cut are the tie group the province/locality
    // tiebreaker splits; the DB collation decides that split, so the test does
    // not re-derive it here — the stability case below proves the split does
    // not move between runs.)
    const wronglyDropped = [...truth.entries()]
      .filter(([key, n]) => n > cut && !kept.has(key))
      .map(([key, n]) => `${key} (${n})`);
    expect(
      wronglyDropped,
      `the cap dropped localities larger than the smallest one it kept (${cut})`,
    ).toEqual([]);

    // And symmetrically: nothing below the cut sneaked in.
    for (const r of rows) {
      expect(r.count, `kept ${r.key} with ${r.count}, below the cut ${cut}`).toBeGreaterThanOrEqual(
        cut,
      );
      // The rollup's own count must be the true one (the pre-join aggregate is
      // exact by construction — no ar_localities fan-out reaches it).
      expect(truth.get(r.key), `rollup count for ${r.key} disagrees with the raw count`).toBe(
        r.count,
      );
    }
  }, 120_000);

  it("is STABLE — three consecutive loads return identical rows in identical order", async () => {
    // Serial, not Promise.all: concurrent identical queries can share a plan and
    // hide exactly the instability this is looking for.
    const a = await microchipRollup();
    const b = await microchipRollup();
    const c = await microchipRollup();
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(JSON.stringify(c)).toBe(JSON.stringify(a));
  }, 180_000);
});

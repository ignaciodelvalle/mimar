// Tests for the cross-region ranking projection (Item 22).
//
// Pure unit tests cover:
//   - rankByField correctly orders rows by a numeric field ascending/descending
//   - ranking slice (top N / bottom N)
//
// Integration tests cover:
//   - fetchRegionRanking returns top/bottom by rabies coverage

import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { applyRankingDisclosure, rankByField, regionRankingPetsScope } from "./analytics-ranking";

// ---------------------------------------------------------------------------
// Pure unit tests — no DB
// ---------------------------------------------------------------------------

describe("rankByField", () => {
  const rows = [
    { province: "Buenos Aires", code: "AR-B", value: 45, count: 100 },
    { province: "Córdoba", code: "AR-X", value: 72, count: 80 },
    { province: "Santa Fe", code: "AR-S", value: 30, count: 60 },
    { province: "Mendoza", code: "AR-M", value: 88, count: 40 },
    { province: "Tucumán", code: "AR-T", value: 15, count: 20 },
  ];

  it("returns top N by value descending", () => {
    const result = rankByField(rows, "value", "desc", 3);
    expect(result).toHaveLength(3);
    expect(result[0].province).toBe("Mendoza");
    expect(result[1].province).toBe("Córdoba");
    expect(result[2].province).toBe("Buenos Aires");
    expect(result[0].rank).toBe(1);
    expect(result[2].rank).toBe(3);
  });

  it("returns bottom N by value ascending", () => {
    const result = rankByField(rows, "value", "asc", 3);
    expect(result).toHaveLength(3);
    expect(result[0].province).toBe("Tucumán");
    expect(result[1].province).toBe("Santa Fe");
    expect(result[2].province).toBe("Buenos Aires");
    expect(result[0].rank).toBe(1);
  });

  it("returns all rows when limit exceeds length", () => {
    const result = rankByField(rows, "value", "desc", 100);
    expect(result).toHaveLength(5);
  });

  it("assigns sequential rank starting at 1", () => {
    const result = rankByField(rows, "value", "desc", 5);
    for (let i = 0; i < result.length; i++) {
      expect(result[i].rank).toBe(i + 1);
    }
  });

  it("handles empty array", () => {
    expect(rankByField([], "value", "desc", 5)).toHaveLength(0);
  });

  it("returns at most limit rows", () => {
    expect(rankByField(rows, "value", "desc", 2)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Region-ranking jurisdiction scope — whole-province (CABA) subsumption
// ---------------------------------------------------------------------------
//
// Regression: fetchRegionRanking previously built an ad-hoc exact
// `(province = X AND locality = Y)` clause. A whole-CABA govt assignment has
// locality "Ciudad Autónoma de Buenos Aires", but CABA pets are tagged with
// barrio localities ("Belgrano", "Palermo", …), so the exact clause matched
// zero barrio-tagged pets and CABA silently vanished from the ranking. The fix
// routes scope through the shared jurisdictionPairClause, which emits a
// province-only predicate for whole-province assignments.

function render(clause: ReturnType<typeof regionRankingPetsScope>) {
  if (clause === null) return { sql: "", params: [] as unknown[] };
  return new PgDialect().sqlToQuery(clause);
}

describe("regionRankingPetsScope — CABA whole-province subsumption", () => {
  it("emits a PROVINCE-ONLY predicate for a whole-CABA govt assignment (barrio-tagged pets still match)", () => {
    const clause = regionRankingPetsScope({ role: "govt" }, [
      { province: "CABA", locality: "Ciudad Autónoma de Buenos Aires" },
    ]);
    const { sql: text, params } = render(clause);
    // Province alone → a barrio-tagged CABA pet ("Belgrano") is still in scope.
    expect(text).toContain("jurisdiction_province");
    expect(text).not.toContain("jurisdiction_locality");
    expect(params).toContain("CABA");
    // The OLD ad-hoc exact clause would have pinned the whole-province locality
    // string here — which no barrio-tagged pet carries → CABA returned 0 rows.
    expect(params).not.toContain("Ciudad Autónoma de Buenos Aires");
  });

  it("keeps the EXACT pair for a barrio-specific assignment (no widening)", () => {
    const clause = regionRankingPetsScope({ role: "govt" }, [
      { province: "CABA", locality: "Palermo" },
    ]);
    const { sql: text, params } = render(clause);
    expect(text).toContain("jurisdiction_locality");
    expect(params).toEqual(expect.arrayContaining(["CABA", "Palermo"]));
  });

  it("keeps the EXACT pair for a normal (non-whole-province) locality", () => {
    const clause = regionRankingPetsScope({ role: "govt" }, [
      { province: "Mendoza", locality: "Godoy Cruz" },
    ]);
    const { sql: text, params } = render(clause);
    expect(text).toContain("jurisdiction_province");
    expect(text).toContain("jurisdiction_locality");
    expect(params).toEqual(expect.arrayContaining(["Mendoza", "Godoy Cruz"]));
  });

  it("returns null for admin (universal scope unchanged)", () => {
    expect(regionRankingPetsScope({ role: "admin" }, [])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RA-3 finding C7 — a per-unit RATE reveals its denominator
// ---------------------------------------------------------------------------
//
// `applyRankingDisclosure` is the pure half production runs (fetchRegionRanking
// delegates to it), so these pin the SAME code path, not a restatement.

describe("applyRankingDisclosure — RA-3 C7", () => {
  // The finding's own example: 3 dogs / 1 vaccinated used to ship "33%", and
  // `bottom` sorts ASCENDING, so it surfaced FIRST.
  const TDF = { province: "Tierra del Fuego", code: "AR-V", value: 33, count: 3 };
  const LA_RIOJA = { province: "La Rioja", code: "AR-F", value: 61, count: 1204 };
  const BA = { province: "Buenos Aires", code: "AR-B", value: 45, count: 90_000 };

  it("withholds a foreign sub-k province from an admin and announces it", () => {
    const r = applyRankingDisclosure({ role: "admin" }, [], [TDF, LA_RIOJA, BA]);

    expect(r.suppressedCount).toBe(1);
    const named = [...r.top, ...r.bottom].map((x) => x.province);
    expect(named).not.toContain("Tierra del Fuego");
    // The rate is gone in every encoding — not published as 0 somewhere else.
    expect([...r.top, ...r.bottom].map((x) => x.coveragePct)).not.toContain(33);
    // The above-k siblings are UNTOUCHED. Blanking La Rioja's real 1.204 to
    // protect Tierra del Fuego's 3 is the RA-1 over-correction.
    expect(named).toContain("La Rioja");
    expect(named).toContain("Buenos Aires");
  });

  it("`bottom` no longer leads with the sub-k cell", () => {
    const r = applyRankingDisclosure({ role: "admin" }, [], [TDF, LA_RIOJA, BA]);
    expect(r.bottom[0]?.province).not.toBe("Tierra del Fuego");
    expect(r.bottom[0]?.province).toBe("Buenos Aires"); // 45 < 61
  });

  it("counts only PUBLISHABLE provinces in totalProvinces (the <3 honesty gate)", () => {
    // 3 provinces in scope, 2 of them sub-k ⇒ 1 rankable. Best/worst framing over
    // one row is the same dishonesty claim #2 named, so the count must not be
    // propped up by rows nobody can see.
    const alsoTiny = { province: "Santa Cruz", code: "AR-Z", value: 50, count: 2 };
    const r = applyRankingDisclosure({ role: "admin" }, [], [TDF, alsoTiny, BA]);
    expect(r.suppressedCount).toBe(2);
    expect(r.totalProvinces).toBe(1);
  });

  it("D.10 SURVIVES: a govt operator's OWN 3-pet province keeps its real rate", () => {
    // An own cell is never a suppression candidate. Blanket k here would blind an
    // operator about their own administrados AND put this surface at odds with
    // /gob/censo for the same viewer in the same session.
    const r = applyRankingDisclosure(
      { role: "govt" },
      [{ province: "Tierra del Fuego", locality: "" }],
      [TDF],
    );
    expect(r.suppressedCount).toBe(0);
    expect(r.totalProvinces).toBe(1);
    expect(r.top[0].province).toBe("Tierra del Fuego");
    expect(r.top[0].coveragePct).toBe(33);
    expect(r.top[0].count).toBe(3);
  });

  it("an admin DRILL is a query param, not an assignment — it does not turn k off", () => {
    // `?province=Tierra del Fuego` narrows the row set to one; the verdict is
    // unchanged, so the drill cannot be used to read the cell the national view
    // hides.
    const r = applyRankingDisclosure({ role: "admin" }, [], [TDF]);
    expect(r.suppressedCount).toBe(1);
    expect(r.top).toHaveLength(0);
    expect(r.bottom).toHaveLength(0);
    expect(r.totalProvinces).toBe(0);
  });

  it("an EMPTY province (0 pets) is a coverage gap, not a withholding", () => {
    // Same nuance as provinceCell/suppressDelta: badging an empty group
    // "protegido por privacidad" dresses a real gap as a deliberate secret.
    // Zero-pet provinces are filtered upstream; the rule must agree.
    const r = applyRankingDisclosure({ role: "admin" }, [], [LA_RIOJA, BA]);
    expect(r.suppressedCount).toBe(0);
  });
});

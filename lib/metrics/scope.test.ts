// Regression tests for jurisdictionPairClause whole-province subsumption
// (critique of PR #762, finding 7).
//
// govt-home-kpis.ts previously re-derived the jurisdiction-pair predicate inline
// (casesScopeClause, welfareReportsScopeClause, fetchRabiesCoverage[ByProvince])
// with EXACT (province, locality) equality — NOT covered by 7a17ec97's
// subsumption fix. Those sites now route through jurisdictionPairClause. These
// tests pin the shared clause's subsumption contract: a whole-province
// assignment emits a PROVINCE-ONLY predicate (no locality operand), while a
// barrio-specific assignment keeps the exact pair.

import { and, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { pets } from "@/db";
import { jurisdictionPairClause } from "@/lib/metrics/scope";

function render(clause: ReturnType<typeof jurisdictionPairClause> | undefined) {
  if (!clause) return { sql: "", params: [] as unknown[] };
  return new PgDialect().sqlToQuery(clause);
}

const provinceExpr = sql`${pets.jurisdictionProvince}`;
const localityExpr = sql`${pets.jurisdictionLocality}`;

describe("jurisdictionPairClause — whole-province subsumption (finding 7)", () => {
  it("emits a PROVINCE-ONLY predicate for a whole-province (CABA) assignment", () => {
    const clause = jurisdictionPairClause(
      [{ province: "CABA", locality: "Ciudad Autónoma de Buenos Aires" }],
      provinceExpr,
      localityExpr,
    );
    const { sql: text, params } = render(clause);
    // The locality operand must NOT appear — the province alone subsumes every barrio.
    expect(text).toContain("jurisdiction_province");
    expect(text).not.toContain("jurisdiction_locality");
    expect(params).toContain("CABA");
    expect(params).not.toContain("Ciudad Autónoma de Buenos Aires");
  });

  it("keeps the EXACT pair for a barrio-specific assignment", () => {
    const clause = jurisdictionPairClause(
      [{ province: "CABA", locality: "Palermo" }],
      provinceExpr,
      localityExpr,
    );
    const { sql: text, params } = render(clause);
    expect(text).toContain("jurisdiction_province");
    expect(text).toContain("jurisdiction_locality");
    expect(params).toEqual(expect.arrayContaining(["CABA", "Palermo"]));
  });

  it("keeps the EXACT pair for a normal (non-whole-province) locality", () => {
    const clause = jurisdictionPairClause(
      [{ province: "Buenos Aires", locality: "La Plata" }],
      provinceExpr,
      localityExpr,
    );
    const { sql: text } = render(clause);
    expect(text).toContain("jurisdiction_locality");
  });

  it("returns null for an empty assignment list", () => {
    expect(jurisdictionPairClause([], provinceExpr, localityExpr)).toBeNull();
  });
});

// AND/OR precedence regression (#60, dawn HIGH fix f933838a). The clause is
// almost always composed as `and(otherCond, …, pairClause)`. SQL binds AND
// tighter than OR, so WITHOUT the clause's own outer-paren group the composed
// predicate degrades to `otherCond AND pair1 OR pair2 OR …` and every row
// matching pair2… leaks past otherCond (Argo pet-drill leak). This pins the
// grouping for the EXACT composition that hid the bug: a two-pair clause ANDed
// with a sibling condition. Do not delete without an equivalent guard.
describe("jurisdictionPairClause — parenthesized under AND composition (#60)", () => {
  const TWO_PAIRS = [
    { province: "CABA", locality: "Palermo" },
    { province: "Buenos Aires", locality: "La Plata" },
  ];

  it("wraps its OR-chain so an ANDed sibling condition cannot be bypassed", () => {
    const clause = jurisdictionPairClause(TWO_PAIRS, provinceExpr, localityExpr);
    expect(clause).not.toBeNull();
    // The exact dangerous shape: sibling AND-condition + the pair clause.
    const composed = and(sql`${pets.status} = 'active'`, clause ?? sql`false`);
    const { sql: text, params } = render(composed);

    // Both pairs render (two barrio-specific → each keeps province AND locality).
    expect(params).toEqual(expect.arrayContaining(["Palermo", "La Plata"]));
    // The OR-chain must sit inside its OWN group that is a single AND operand:
    // `… and ((…) or (…))`. The buggy (un-grouped) clause would render
    // `… and (…) or (…)` — i.e. `and (` immediately followed by a single pair,
    // NOT a nested `((`. Requiring the nested open-paren after AND encodes the fix.
    expect(text).toMatch(/and\s*\(\(/i);
    // Defensive: the sibling condition must not be left dangling before a bare OR
    // (no `'active' and (…) or` at the top level).
    expect(text).not.toMatch(/'active'\s+and\s+\([^(]*\)\s+or\s+\(/i);
  });

  it("a single-pair clause is already self-contained under AND", () => {
    const clause = jurisdictionPairClause(
      [{ province: "CABA", locality: "Palermo" }],
      provinceExpr,
      localityExpr,
    );
    const composed = and(sql`${pets.status} = 'active'`, clause ?? sql`false`);
    const { sql: text } = render(composed);
    // One pair: `and ((province = $ and locality = $))` — still grouped, harmless.
    expect(text).toMatch(/and\s*\(\(/i);
  });
});

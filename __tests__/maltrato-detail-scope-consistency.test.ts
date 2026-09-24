// Regression: LIST-vs-DETAIL authorization consistency for citizen-ingested
// denuncias (demo blocker 2026-07-08).
//
// THE bug: an anonymous citizen denuncia (DEN-VAM2-Z4WZ) geocoded to "Almagro"
// — a CABA barrio — appeared FIRST in the /gob/maltrato triage queue for a
// whole-CABA operator, but clicking it 404'd. The queue list clause
// (jurisdictionPairClause via buildMaltratoListConditions) applies whole-province
// SUBSUMPTION: a whole-CABA assignment ("Ciudad Autónoma de Buenos Aires")
// governs every barrio, so the Almagro row matched on province alone. The DETAIL
// page and the welfare mutation guards (loadInScopeReport / loadAndVerifyScope in
// src/modules/welfare/actions.ts) instead hand-rolled an EXACT (province,
// locality) pair check — "Ciudad Autónoma de Buenos Aires" !== "Almagro" → the
// detail returned notFound() and every operator action rejected with "Denuncia
// no encontrada". Seed denuncias tagged with the whole-city locality opened fine;
// only barrio-geocoded citizen rows diverged.
//
// The fix routes the detail page + both action guards through
// jurisdictionScopeContains — the same subsumption semantics the list clause
// already used. This test locks the invariant: if the queue LIST shows a row,
// the DETAIL/action authorization MUST resolve it (and both must exclude an
// out-of-scope operator).

import { describe, expect, it } from "vitest";

import { jurisdictionScopeContains } from "@/lib/domain/jurisdiction-canonical";
import type { DashboardJurisdiction } from "@/lib/metrics/context";
import { jurisdictionPairClause } from "@/lib/metrics/scope";
import { sql } from "drizzle-orm";

// Drizzle SQL objects hold circular table refs that break JSON.stringify; this
// mirrors the extractor in maltrato-sql-queue.test.ts — recursively collect all
// string/number literals so we can assert which values constrain the clause.
function extractLiterals(node: unknown, seen = new WeakSet()): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node !== "object") return "";
  if (seen.has(node as object)) return "";
  seen.add(node as object);
  return Object.values(node as Record<string, unknown>)
    .map((v) => extractLiterals(v, seen))
    .join(" ");
}

// Does the queue LIST clause for this operator constrain on the barrio locality?
// A whole-province assignment emits province-only equality (subsumption) → the
// locality literal is ABSENT → every barrio in the province matches. A barrio-
// specific assignment emits the exact pair → the locality literal is PRESENT.
function listClauseLiterals(jurisdictions: DashboardJurisdiction[]): string {
  const clause = jurisdictionPairClause(jurisdictions, sql`province_expr`, sql`locality_expr`);
  return clause ? extractLiterals(clause) : "";
}

// Demo blocker fixture: citizen denuncia geocoded to a CABA barrio.
const ALMAGRO = { province: "CABA", locality: "Almagro" } as const;

// Operators.
const WHOLE_CABA: DashboardJurisdiction[] = [
  { province: "CABA", locality: "Ciudad Autónoma de Buenos Aires" },
];
const CABA_PALERMO: DashboardJurisdiction[] = [{ province: "CABA", locality: "Palermo" }];
const SALTA: DashboardJurisdiction[] = [{ province: "Salta", locality: "Salta" }];

describe("maltrato list-vs-detail scope consistency (demo blocker)", () => {
  it("whole-CABA operator: queue shows the Almagro denuncia AND the detail opens it", () => {
    // LIST side: whole-province clause is province-only — no locality literal,
    // so an Almagro row matches. (Subsumption path in jurisdictionPairClause.)
    const literals = listClauseLiterals(WHOLE_CABA);
    expect(literals).toContain("CABA");
    expect(literals).not.toContain("Ciudad Autónoma de Buenos Aires");
    expect(literals).not.toContain("Almagro");

    // DETAIL / action side: MUST authorize the same row (was 404 before the fix).
    expect(jurisdictionScopeContains(WHOLE_CABA, ALMAGRO.province, ALMAGRO.locality)).toBe(true);
  });

  it("out-of-scope Salta operator: queue hides it AND the detail 404s", () => {
    // LIST side: Salta clause never mentions CABA → the Almagro row is excluded.
    const literals = listClauseLiterals(SALTA);
    expect(literals).toContain("Salta");
    expect(literals).not.toContain("CABA");

    // DETAIL / action side: not in scope → notFound() / "Denuncia no encontrada".
    expect(jurisdictionScopeContains(SALTA, ALMAGRO.province, ALMAGRO.locality)).toBe(false);
  });

  it("barrio-specific operator stays narrow: a Palermo operator cannot open an Almagro denuncia", () => {
    // LIST side: exact-pair clause constrains on the Palermo locality literal —
    // an Almagro row does not satisfy it.
    const literals = listClauseLiterals(CABA_PALERMO);
    expect(literals).toContain("Palermo");

    // DETAIL / action side: barrio assignment never widens to a sibling barrio.
    expect(jurisdictionScopeContains(CABA_PALERMO, ALMAGRO.province, ALMAGRO.locality)).toBe(false);
  });
});

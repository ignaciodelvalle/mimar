// Regression: the CABA two-tier subsumption class across ALL exact-match
// authorization sites (2026-07-08 sweep, following commit 4cc1cbd5).
//
// THE bug class: a govt operator gate that hand-rolls an EXACT (province,
// locality) equality against a resource row's stored jurisdiction. Under the
// two-tier CABA model a WHOLE-PROVINCE assignment (whole-CABA / "Ciudad Autónoma
// de Buenos Aires") governs EVERY barrio in that province, so an exact pair
// wrongly 404s / denies a whole-CABA operator on a barrio-tagged row (Almagro,
// Palermo…). 4cc1cbd5 fixed the welfare detail+action guards; this sweep closed
// the same latent bug at ~15 further sites by routing them through the canonical
// subsumption helpers (jurisdictionScopeContains / isWholeProvinceLocality /
// jurisdictionPairClause).
//
// This test locks the invariant, grouped by surface class, using the exported
// predicate each class now depends on. The invariant, everywhere:
//   - a WHOLE-CABA operator OPENS a barrio-tagged (Almagro) row     → allowed
//   - a SALTA operator is DENIED an Almagro row (other province)    → denied
//   - a barrio-PALERMO operator stays NARROW: denied Almagro,       → denied
//     allowed only its own Palermo                                  → allowed

import { describe, expect, it } from "vitest";

import {
  isWholeProvinceLocality,
  jurisdictionScopeContains,
} from "@/lib/domain/jurisdiction-canonical";
import { canDecideRequest, visibleRequestsClause } from "@/lib/infra/approval-scope";
import { type CaseViewer, canReadCase } from "@/lib/infra/case-access";
import type { CaseDetail } from "@/lib/infra/case-queries";
import { isInScope } from "@/src/modules/surveillance/application/outbreak-investigation";

// --- Canonical operator profiles -------------------------------------------
// Whole-CABA: locality IS the whole-province INDEC single entry.
const WHOLE_CABA = [{ province: "CABA", locality: "Ciudad Autónoma de Buenos Aires" }];
// Barrio-specific CABA operator.
const PALERMO = [{ province: "CABA", locality: "Palermo" }];
// Different province entirely.
const SALTA = [{ province: "Salta", locality: "Salta" }];

// --- Canonical target rows --------------------------------------------------
const ALMAGRO = { province: "CABA", locality: "Almagro" }; // barrio-geocoded row
const PALERMO_ROW = { province: "CABA", locality: "Palermo" };

// Drizzle SQL objects hold circular table refs; recursively collect literals so
// we can assert which values constrain a clause (mirrors maltrato-sql-queue.test).
function extractLiterals(node: unknown, seen = new WeakSet<object>()): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node !== "object") return "";
  if (seen.has(node as object)) return "";
  seen.add(node as object);
  return Object.values(node as Record<string, unknown>)
    .map((v) => extractLiterals(v, seen))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Class 1 — in-memory scope engine (jurisdictionScopeContains)
//
// Powers: gob/moderacion/[id], gob/disputas/[disputeToken],
// admin/observaciones/[publicToken], gob/servicios/[offeringToken],
// actions/decomiso.ts (pet + govtOrg), decomiso lookup-pet-for-decomiso,
// lib/infra/case-access (canReadCase), custody-disputes (resolve/lookup/
// escalate/add-party), surveillance/professional-close-observation.
// ---------------------------------------------------------------------------
describe("subsumption class — jurisdictionScopeContains (11 in-memory gates)", () => {
  it("whole-CABA operator OPENS a barrio-tagged (Almagro) row", () => {
    expect(jurisdictionScopeContains(WHOLE_CABA, ALMAGRO.province, ALMAGRO.locality)).toBe(true);
  });

  it("Salta operator is DENIED an Almagro row (other province stays invisible)", () => {
    expect(jurisdictionScopeContains(SALTA, ALMAGRO.province, ALMAGRO.locality)).toBe(false);
  });

  it("barrio-Palermo operator stays NARROW: denied Almagro, allowed its own Palermo", () => {
    expect(jurisdictionScopeContains(PALERMO, ALMAGRO.province, ALMAGRO.locality)).toBe(false);
    expect(jurisdictionScopeContains(PALERMO, PALERMO_ROW.province, PALERMO_ROW.locality)).toBe(
      true,
    );
  });

  it("fail-closed: a target with no province is in nobody's scope", () => {
    expect(jurisdictionScopeContains(WHOLE_CABA, null, "Almagro")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Class 2 — case access (canReadCase, govt branch)
//
// Real integration of jurisdictionScopeContains at the /casos read guard. The
// govt branch resolves scope BEFORE any DB call, so these run without a db.
// ---------------------------------------------------------------------------
describe("subsumption class — canReadCase (lib/infra/case-access)", () => {
  const govt = (jurisdictions: CaseViewer["jurisdictions"]): CaseViewer => ({
    userId: "u1",
    role: "govt",
    jurisdictions,
  });
  const caseAt = (province: string, locality: string) =>
    ({
      caseKind: "welfare_denuncia",
      jurisdictionProvince: province,
      jurisdictionLocality: locality,
      pet: null,
    }) as unknown as CaseDetail;

  it("whole-CABA operator READS a barrio-tagged (Almagro) case", async () => {
    expect(await canReadCase(caseAt("CABA", "Almagro"), govt(WHOLE_CABA))).toBe(true);
  });

  it("Salta operator is DENIED an Almagro case", async () => {
    expect(await canReadCase(caseAt("CABA", "Almagro"), govt(SALTA))).toBe(false);
  });

  it("barrio-Palermo operator: denied Almagro, allowed its own Palermo", async () => {
    expect(await canReadCase(caseAt("CABA", "Almagro"), govt(PALERMO))).toBe(false);
    expect(await canReadCase(caseAt("CABA", "Palermo"), govt(PALERMO))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Class 3 — approvals, in-memory decision guard (canDecideRequest)
// ---------------------------------------------------------------------------
describe("subsumption class — canDecideRequest (lib/infra/approval-scope)", () => {
  const req = (province: string, locality: string) => ({
    type: "role_upgrade_vet" as const,
    jurisdictionProvince: province,
    jurisdictionLocality: locality,
  });

  it("whole-CABA operator DECIDES a barrio-tagged (Almagro) request", () => {
    expect(canDecideRequest({ role: "govt" }, req("CABA", "Almagro"), WHOLE_CABA)).toBe(true);
  });

  it("Salta operator is DENIED an Almagro request", () => {
    expect(canDecideRequest({ role: "govt" }, req("CABA", "Almagro"), SALTA)).toBe(false);
  });

  it("barrio-Palermo operator: denied Almagro, allowed its own Palermo", () => {
    expect(canDecideRequest({ role: "govt" }, req("CABA", "Almagro"), PALERMO)).toBe(false);
    expect(canDecideRequest({ role: "govt" }, req("CABA", "Palermo"), PALERMO)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Class 4 — approvals, SQL queue clause (visibleRequestsClause)
//
// The queue LIST must scope identically to canDecideRequest. Assert the emitted
// clause: a whole-CABA assignment constrains on PROVINCE ALONE (the whole-city
// locality string is dropped, so barrio rows match); a Palermo assignment keeps
// the exact pair.
// ---------------------------------------------------------------------------
describe("subsumption class — visibleRequestsClause SQL (lib/infra/approval-scope)", () => {
  const govtProfile = { id: "u1", role: "govt" as const };

  it("whole-CABA clause matches province-only (drops the whole-city locality literal)", () => {
    const clause = visibleRequestsClause(govtProfile, WHOLE_CABA);
    const literals = extractLiterals(clause);
    expect(literals).toContain("CABA");
    // Subsumption: the whole-province locality string must NOT constrain the clause,
    // otherwise a barrio-tagged request would be excluded.
    expect(literals).not.toContain("Ciudad Autónoma de Buenos Aires");
  });

  it("barrio-Palermo clause keeps the exact (province, locality) pair", () => {
    const clause = visibleRequestsClause(govtProfile, PALERMO);
    const literals = extractLiterals(clause);
    expect(literals).toContain("CABA");
    expect(literals).toContain("Palermo");
  });

  it("empty jurisdictions → false clause (govt with no assignments sees nothing)", () => {
    const clause = visibleRequestsClause(govtProfile, []);
    expect(extractLiterals(clause)).toContain("false");
  });

  // Admin is the UNIVERSAL catch-all: the queue clause imposes NO scope
  // restriction, so /admin/cola shows every pending request and stays consistent
  // with the global fetchQueueHealth counter (QA 2026-07-08: counter said 1 while
  // the admin queue was empty). A `true` clause is unrestricted; it must NOT carry
  // any jurisdiction/type literal that would narrow the population.
  it("admin clause is unrestricted (true) — universal catch-all, no scope literal", () => {
    const adminProfile = { id: "admin1", role: "admin" as const };
    const clause = visibleRequestsClause(adminProfile, []);
    const literals = extractLiterals(clause);
    expect(literals).toContain("true");
    expect(literals).not.toContain("CABA");
    expect(literals).not.toContain("false");
  });
});

// ---------------------------------------------------------------------------
// Class 5 — whole-province primitive (isWholeProvinceLocality)
//
// Powers: surveillance/outbreak-investigation isInScope, approval SQL tupleMatches.
// The primitive that distinguishes a whole-province assignment from a barrio one.
// ---------------------------------------------------------------------------
describe("subsumption class — isWholeProvinceLocality primitive", () => {
  it("recognizes the whole-CABA locality as province-granularity", () => {
    expect(isWholeProvinceLocality("CABA", "Ciudad Autónoma de Buenos Aires")).toBe(true);
  });

  it("a barrio (Palermo/Almagro) is NOT whole-province — stays exact", () => {
    expect(isWholeProvinceLocality("CABA", "Palermo")).toBe(false);
    expect(isWholeProvinceLocality("CABA", "Almagro")).toBe(false);
  });

  // Locks the outbreak-investigation isInScope: a whole-CABA operator covers a
  // barrio-tagged case; Salta does not; Palermo stays narrow.
  //
  // This used to run against a COPY of the predicate written out inside this
  // file. The comment claimed it "locks the shape", but what it locked was the
  // copy: production could drift to something more permissive and this stayed
  // green (audit 2026-08-12). It now imports the real function — the one the
  // four outbreak actions actually call.
  const outbreakInScope = (
    jurisdictions: ReadonlyArray<{ province: string; locality: string }>,
    caseProvince: string | null,
    caseLocality: string | null,
  ): boolean =>
    isInScope(
      { jurisdictionProvince: caseProvince, jurisdictionLocality: caseLocality },
      jurisdictions,
    );

  it("outbreak isInScope: whole-CABA covers an Almagro case; Salta denied; Palermo narrow", () => {
    expect(outbreakInScope(WHOLE_CABA, "CABA", "Almagro")).toBe(true);
    expect(outbreakInScope(SALTA, "CABA", "Almagro")).toBe(false);
    expect(outbreakInScope(PALERMO, "CABA", "Almagro")).toBe(false);
    expect(outbreakInScope(PALERMO, "CABA", "Palermo")).toBe(true);
  });

  it("a national case (no province) is in scope for any operator", () => {
    expect(outbreakInScope(SALTA, null, null)).toBe(true);
  });

  it("a province-wide case (no locality) matches any operator in that province", () => {
    expect(outbreakInScope(PALERMO, "CABA", null)).toBe(true);
    expect(outbreakInScope(SALTA, "CABA", null)).toBe(false);
  });
});

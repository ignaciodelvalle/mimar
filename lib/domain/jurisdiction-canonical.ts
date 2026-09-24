// Canonical jurisdiction_province storage helper (handoff P6 / critique §Bug 2).
//
// Decision (2026-05-28): the canonical storage format for jurisdiction_province
// is the **display name** as it appears in lib/ar-provincias.ts → PROVINCES.
// Example: "Buenos Aires", "CABA", "Mendoza".
//
// The wire format from LocationFields is the ISO code (`provinceCode=AR-B`).
// This helper bridges the two: every server action that writes
// jurisdiction_province pipes its input through canonicalProvinceNameForStorage
// so the column stays in a single format.
//
// Reasons for display-name over ISO:
//   - Existing code (pets.ts, welfare.ts, govt dashboards) already reads and
//     filters by display name.
//   - K-anonymity rollups in govt dashboards group on this column.
//   - ISO codes are great as keys but ugly when surfaced in error messages
//     or audit logs — display names need no UI translation.
//
// Migration 0055 backfills the 11 tables holding this column to display name
// and adds a CHECK constraint enforcing the 24-value enum.

import { PROVINCES, provinceByCode, provinceByName } from "@/lib/reference/ar-provincias";

/**
 * Normalize any province input — ISO code, exact display name, alias (e.g.
 * "Capital Federal", "Bs As"), case variant, INDEC long form — into the
 * canonical display name suitable for storage in `jurisdiction_province`.
 *
 * Returns `null` for empty input or unresolvable strings. Callers that
 * have a NOT NULL column should validate the result before writing.
 */
export function canonicalProvinceNameForStorage(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // ISO code path — fastest and unambiguous.
  if (/^AR-[A-Z]$/.test(trimmed)) {
    return provinceByCode(trimmed)?.name ?? null;
  }

  // Alias-tolerant resolver handles case, diacritics, and known aliases
  // ("Ciudad Autónoma de Buenos Aires" → "CABA", "Bs As" → "Buenos Aires").
  return provinceByName(trimmed)?.name ?? null;
}

/**
 * Set of valid display names, frozen at module load. Used by the runtime
 * validation guard and as the source of truth for the SQL CHECK constraint
 * in migration 0055.
 */
export const CANONICAL_PROVINCE_NAMES: ReadonlySet<string> = new Set(PROVINCES.map((p) => p.name));

export function isCanonicalProvinceName(value: string | null | undefined): boolean {
  if (!value) return false;
  return CANONICAL_PROVINCE_NAMES.has(value);
}

// ---------------------------------------------------------------------------
// Whole-province localities (two-tier CABA jurisdiction model)
// ---------------------------------------------------------------------------

// Some provinces are modeled by INDEC as a SINGLE locality equal to the whole
// province. CABA is the canonical case: the INDEC localities catalog holds ONE
// CABA entry ("Ciudad Autónoma de Buenos Aires"), while the 48 barrios
// (Ley CABA 1.777) are a FINER overlay imported separately (category 'barrio',
// province_code AR-C). See
// docs/superpowers/plans/archive/2026-05-19-caba-barrios-import-execution.md.
//
// Consequence: a CABA row's jurisdiction_locality can be EITHER the whole-city
// entry (legacy rows + INDEC-only seeds, e.g. seed-demo-scenario's FOCAL_LOCALITY)
// OR a specific barrio (Palermo, Almagro, …) when the address was geocoded to a
// barrio. Backfilling legacy whole-city rows to barrios was explicitly declined
// (out of scope) — the two tiers coexist by design.
//
// For jurisdiction scoping this means a govt assignment on the whole-province
// locality governs the ENTIRE province and MUST subsume every locality/barrio in
// it. An exact (province, locality) pair match cannot bridge the two tiers, so a
// whole-CABA operator would otherwise never see a barrio-tagged denuncia (and
// vice-versa). See jurisdictionPairClause in lib/metrics/scope.ts.
//
// D3 (PO decision, 2026-08-04): "provincia entera fuera de CABA — SE CONSTRUYE
// AHORA." Any province may be addressed as a whole, not just CABA.
//
// The two forms are NOT interchangeable and both are kept on purpose:
//
//   INDEC single-entry name — a FACT about the INDEC catalog. Only CABA has one
//     ("Ciudad Autónoma de Buenos Aires"). It is a real, stored locality string
//     that pre-dates this decision and rows already carry it.
//   The EMPTY sentinel — the product's own "toda la provincia" marker, already
//     the shape the rest of the codebase uses (`describeMandate`,
//     `censusEligibleProvince`, `localitiesForScope`) and already honoured by
//     `isWholeProvinceAssignment`. It is what a non-CABA province gets, because
//     INDEC gives it nothing to borrow.
//
// The bug D3 closes: the WORDING path already read `locality === ""` as "toda
// la provincia", while the QUERY path (`jurisdictionPairClause` → this
// predicate) did not — so a whole-Mendoza operator was TOLD they govern Mendoza
// and then served `locality = ''`, which matches no pet, no denuncia, nothing.
// Wording and query must never disagree about what counts as the whole province
// (C3, plan-maestro-integridad).
//
// NOT the province's own name: "Mendoza", "Córdoba", "Salta" and "Santa Fe" are
// all real LOCALITIES inside the provinces they name. Using the name as the
// sentinel would silently promote a capital-city assignment to province-wide.

/** The generic "toda la provincia" locality marker (every province). */
export const WHOLE_PROVINCE_SENTINEL = "";

/** Provinces INDEC models as a SINGLE locality equal to the whole province. */
const INDEC_WHOLE_PROVINCE_LOCALITY: Readonly<Record<string, string>> = {
  CABA: "Ciudad Autónoma de Buenos Aires",
};

// Map: canonical province display name → its whole-province locality string.
// Every canonical province is present (D3); CABA keeps its INDEC entry, the
// other 23 carry the generic sentinel.
export const WHOLE_PROVINCE_LOCALITY: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    PROVINCES.map((p) => [
      p.name,
      INDEC_WHOLE_PROVINCE_LOCALITY[p.name] ?? WHOLE_PROVINCE_SENTINEL,
    ]),
  ),
);

/**
 * True when `(province, locality)` addresses the WHOLE province rather than a
 * specific sub-locality/barrio. Jurisdiction scope clauses use this so a
 * whole-province govt assignment matches every locality in that province
 * instead of only the exact stored string.
 *
 * Accepts BOTH forms above, and nothing else:
 *   - the generic sentinel (`""`) for any canonical province — D3;
 *   - CABA's INDEC whole-city entry, unchanged.
 *
 * Deliberately narrow, and FAIL-CLOSED in three directions that all matter for
 * authorization:
 *   - a locality-specific assignment (`CABA / Palermo`, `Mendoza / Godoy Cruz`)
 *     stays exact-match — it never widens beyond its own unit;
 *   - a NON-canonical province name never becomes whole-province, however its
 *     locality reads (`govt_assignments` has a CHECK for canonicality, so this
 *     is defence in depth);
 *   - a null/undefined locality is not the sentinel. Only the empty STRING is.
 *     Data rows with a NULL locality are matched by the province-only branch in
 *     `jurisdictionPairClause`, which is a different mechanism.
 */
export function isWholeProvinceLocality(
  province: string | null | undefined,
  locality: string | null | undefined,
): boolean {
  if (!province || locality === null || locality === undefined) return false;
  if (!CANONICAL_PROVINCE_NAMES.has(province)) return false;
  if (locality === WHOLE_PROVINCE_SENTINEL) return true;
  return WHOLE_PROVINCE_LOCALITY[province] === locality;
}

/**
 * True for a WHOLE-PROVINCE govt assignment in EITHER stored form: the
 * generic `locality === ""` sentinel (used by most provinces) or the two-tier
 * INDEC canonical form above (CABA's whole-city entry, a non-empty locality
 * NAME). `lib/metrics/context.ts` (`isSubProvincialScope`,
 * `censusEligibleProvince`) and `lib/ui/scope-chrome.ts` (`describeMandate`)
 * both need this exact subsumption — the WORDING an operator reads and the
 * QUERY semantics that scope their data must never disagree about what counts
 * as "the whole province" (C3, plan-maestro-integridad).
 */
export function isWholeProvinceAssignment(j: {
  province: string;
  locality: string;
}): boolean {
  return j.locality === "" || isWholeProvinceLocality(j.province, j.locality);
}

/**
 * In-memory counterpart of `jurisdictionPairClause` (lib/metrics/scope.ts):
 * does a govt actor's assigned jurisdiction set contain the target
 * `(province, locality)`?
 *
 * Same subsumption semantics as the SQL clause, so a scoping decision made in
 * application code matches what the dashboards' WHERE clauses would filter:
 *   - a WHOLE-PROVINCE assignment (e.g. CABA / "Ciudad Autónoma de Buenos Aires")
 *     matches on PROVINCE alone — it subsumes every locality/barrio in that
 *     province (a whole-CABA operator governs any CABA barrio).
 *   - a barrio/locality-specific assignment (e.g. CABA / Palermo) requires the
 *     EXACT pair — it never widens beyond its own barrio.
 *
 * Fail-closed: a target with no province is in nobody's scope (returns false),
 * mirroring how a null jurisdiction row is never selected by the SQL clause.
 */
export function jurisdictionScopeContains(
  jurisdictions: ReadonlyArray<{ province: string; locality: string }>,
  targetProvince: string | null | undefined,
  targetLocality: string | null | undefined,
): boolean {
  if (!targetProvince) return false;
  return jurisdictions.some((j) =>
    isWholeProvinceLocality(j.province, j.locality)
      ? j.province === targetProvince
      : j.province === targetProvince && j.locality === targetLocality,
  );
}

// ---------------------------------------------------------------------------
// Read scope by role — THE ONE place "does this role read the whole country?"
// is decided (national role, 2026-09-09).
// ---------------------------------------------------------------------------

/**
 * The roles admitted to the /gob READ surface. `admin` and `national` read the
 * whole country; `govt` reads its `govt_assignments` mandate.
 */
export type GobReadRole = "admin" | "govt" | "national";

const GOB_READ_ROLES: ReadonlySet<string> = new Set(["admin", "govt", "national"]);

/** Is `role` admitted to the /gob READ surface (pages + read-only API routes)? */
export function isGobReadRole(role: string): role is GobReadRole {
  return GOB_READ_ROLES.has(role);
}

/**
 * Roles whose READ scope is the whole country: no jurisdiction predicate, an
 * empty jurisdiction list means "universal", and the province/locality URL
 * params act as an explicit DRILL (additive narrowing) instead of a mandate
 * intersection.
 *
 * `admin` (universal governance role) and `national` (read-only national
 * analyst — migration 0214). Adding a role here is the whole change for the
 * READ side; the WRITE side never consults this list (mutations gate on
 * `requireAdminOrGovtOrRedirect` and friends, which admit admin | govt only).
 */
export const NATIONAL_READ_SCOPE_ROLES: ReadonlySet<string> = new Set(["admin", "national"]);

/**
 * Does `role` read with country-wide scope?
 *
 * Replaces every `role === "admin"` SCOPE check on the read path (ProjectionScope
 * construction, the dashboards' scope clauses, the panorama request-scope
 * resolver, the jurisdiction filter resolver, the layout chrome). It is NOT a
 * capability check: a `national` reads what an `admin` reads and writes nothing,
 * so a `role === "admin"` that guards a mutation, an admin-only link, or the
 * /admin portal must stay a literal comparison. Takes `string` so it accepts
 * `profiles.role` as stored without a cast.
 */
export function hasNationalReadScope(role: string): boolean {
  return NATIONAL_READ_SCOPE_ROLES.has(role);
}

/**
 * Narrow a govt actor's assigned jurisdictions by an optional (province, locality)
 * UI filter, WITH whole-province subsumption. The result is the effective scope
 * the scoped loaders receive — it NEVER widens beyond the actor's assignments:
 *
 *   - no province selected            → the full assignment list (unchanged).
 *   - province only                   → assignments in that province.
 *   - province + locality selected    → the SINGLE selected unit, but only if
 *     it is within scope (jurisdictionScopeContains applies whole-province
 *     subsumption, so a whole-province assignment NARROWS to the picked locality
 *     instead of being emptied by an exact-locality mismatch); otherwise `[]`.
 *
 * Bug this fixes (critique of PR #762): the previous inline intersection filtered
 * assignments by EXACT locality equality, so a whole-province assignment (e.g.
 * whole-CABA / "Ciudad Autónoma de Buenos Aires") disappeared the moment a barrio
 * locality filter was applied → scoped=[] → the loaders emitted `sql\`false\`` →
 * empty results for data the operator legitimately governs. Subsumption narrows
 * to the selected locality instead of emptying.
 *
 * Admin actors must NOT be routed through this helper — their drill-down uses the
 * explicit adminProvince/adminLocality predicates, not scope narrowing.
 */
export function narrowGovtScope(
  jurisdictions: ReadonlyArray<{ province: string; locality: string }>,
  selectedProvince: string | null | undefined,
  selectedLocality: string | null | undefined,
): { province: string; locality: string }[] {
  if (!selectedProvince) return jurisdictions.map((j) => ({ ...j }));
  if (!selectedLocality) {
    return jurisdictions.filter((j) => j.province === selectedProvince).map((j) => ({ ...j }));
  }
  return jurisdictionScopeContains(jurisdictions, selectedProvince, selectedLocality)
    ? [{ province: selectedProvince, locality: selectedLocality }]
    : [];
}

/**
 * The stored locality strings a `(province, locality)` SEARCH must accept.
 *
 * THE BUG THIS EXISTS FOR (measured on staging, 2026-08-13). A citizen searching
 * "vacunación antirrábica · Recoleta, CABA" got "sin servicios", while the very
 * campaign meant for them sat approved, public and with ~16 slots a day. The
 * offering is stored as `CABA / Ciudad Autónoma de Buenos Aires` — WHOLE CABA,
 * the INDEC entry — and the search filtered locality with plain equality, so a
 * barrio search could never reach it. In CABA that is not an edge case: this
 * module documents CABA as THE canonical two-tier province, where the catalog
 * holds one city entry and the 48 barrios are a finer overlay. Every
 * whole-province offering was unreachable from every barrio search.
 *
 * It is also the SAME bug `narrowGovtScope` was written to fix for govt scope
 * (critique of PR #762) — exact-locality equality erasing a whole-province row.
 * That fix never reached the appointment search. Hence one shared helper.
 *
 * Direction matters, and it is the opposite of `jurisdictionScopeContains`:
 * there, a whole-province ACTOR reaches a barrio ROW. Here, a barrio SEARCH
 * reaches a whole-province ROW. Same subsumption, read the other way.
 *
 * Fail-closed like the rest of the module: a non-canonical province never
 * widens — only the literal locality is accepted.
 */
export function localitiesCoveringSearch(province: string, locality: string): string[] {
  if (!CANONICAL_PROVINCE_NAMES.has(province)) return [locality];
  const accepted = new Set<string>([locality, WHOLE_PROVINCE_SENTINEL]);
  const indecWholeProvince = WHOLE_PROVINCE_LOCALITY[province];
  if (indecWholeProvince) accepted.add(indecWholeProvince);
  return [...accepted];
}

/**
 * How to LABEL an offering's own coverage to a citizen.
 *
 * Must be derived from the OFFERING's jurisdiction, never the organisation's.
 * On 2026-08-13 the appointment detail page printed the organisation's locality
 * ("Recoleta") while the search matched the offering's ("Ciudad Autónoma de
 * Buenos Aires"). The label named a place the search would never accept, so a
 * citizen who read it and typed it got zero results — the label was lying about
 * what was findable.
 *
 * A whole-province offering is labelled by its PROVINCE, because that is both
 * what it covers and what a citizen would search. Spanish gender is dodged on
 * purpose: "CABA" is right for all 24 jurisdictions, "Toda CABA"/"Todo Buenos
 * Aires" is not.
 */
export function offeringCoverageLabel(
  province: string | null | undefined,
  locality: string | null | undefined,
): string | null {
  if (!province) return locality || null;
  if (isWholeProvinceLocality(province, locality)) return province;
  return locality || province;
}

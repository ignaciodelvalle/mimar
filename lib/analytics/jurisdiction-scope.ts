/**
 * Canonical jurisdiction-scope resolver for /gob dashboard pages and export routes.
 *
 * The jurisdiction half of the `(events, filters) → view` projection — the exact
 * sibling of the period half (`resolveAnalyticsPeriod`, which resolves
 * `(period searchParams) → {since, until}`). The period half got its shared
 * resolver long ago; the jurisdiction half never did. This adds it.
 *
 * THE JURISDICTIONAL FENCE IS SACRED. This function IS the fence's server-side
 * resolution. It takes the operator's assignment set plus the raw ?province /
 * ?locality searchParams and returns everything a gob screen needs to render its
 * jurisdiction filters — most importantly `filteredJurisdictions`, the narrowed
 * assignment set the data fetchers scope by.
 *
 * It does NOT re-implement the narrowing. The fence-critical narrowing lives in
 * the already-tested pure core `resolveScopedJurisdictions` (lib/infra/gov-scope.ts);
 * this function is the async orchestrator that does the I/O (ISO→Province,
 * slug→Locality, localities fetch) and derivation (allowedProvinces, admin-drill
 * names) around it, then DELEGATES the narrowing to that core. We wrap the proven
 * fence once and route every call site through the wrapper.
 *
 * Security guarantees (see dim-interno:docs/plans/jurisdiction-scope-primitive.md §2, §4):
 *   - Admin ⇒ filteredJurisdictions returned unchanged (empty = universal; SQL
 *     scope clauses short-circuit on role === "admin"). Narrowing is a no-op.
 *   - Govt ⇒ narrowing only ever intersects DOWN against the server-held
 *     assignment set. A crafted ?province/?locality can never widen: selecting a
 *     locality the operator is not assigned yields an EMPTY list, not a broader one.
 *   - The client's selection is re-resolved server-side on every request through
 *     provinceByCode / localityByName; it is an INPUT to resolution, never a
 *     trusted scope.
 *   - Fail-closed: an invalid ISO code, or a lone ?locality with no ?province,
 *     degrades to "no narrowing within the already-fenced set" — never fail-open.
 *   - allowedProvinces is derived from the operator's ORIGINAL assignments (or the
 *     static 24 for admin), never from the narrowed set or any attacker value.
 *   - adminSelectedProvince/Locality (the admin SQL-drill names) are gated on
 *     role === "admin". Govt callers get null and MUST NOT pass them — for a govt
 *     user the scope is already enforced by filteredJurisdictions, so name-based
 *     drilling would be a widening vector.
 */

import { GOB_ALL_PROVINCES, PROVINCE_ISO_MAP } from "@/lib/analytics/govt-dashboards";
import {
  type GobReadRole,
  hasNationalReadScope,
  isWholeProvinceAssignment,
} from "@/lib/domain/jurisdiction-canonical";
import {
  type Locality,
  type LocalityOption,
  listLocalitiesByProvince,
  localityByName,
} from "@/lib/infra/ar-localidades";
import { resolveScopedJurisdictions } from "@/lib/infra/gov-scope";
import type { DashboardJurisdiction } from "@/lib/metrics";
import {
  type Province,
  type ProvinceCode,
  provinceByCode,
  provinceByName,
} from "@/lib/reference/ar-provincias";
import { firstSearchParam } from "@/lib/utils/search-params";

/** The raw ?province / ?locality searchParams, source-shape-agnostic. */
export type JurisdictionScopeParams = {
  /**
   * ?province — ISO 3166-2:AR code, e.g. "AR-B". Absent/empty = national.
   *
   * `string[]` is part of the contract, not sloppiness: Next hands a page an
   * ARRAY the moment a key repeats (`?province=AR-B&province=AR-C`), and every
   * /gob and /admin dashboard forwards `sp.province` here untouched. The
   * province path happened to fail closed (`provinceByCode` only compares), but
   * `locality` reached `normalize()` → `s.normalize is not a function` → a raw
   * 500 on a link a funcionario can produce by concatenating two copied URLs.
   * Collapsed once here rather than at 15 call sites.
   */
  province?: string | string[] | null;
  /** ?locality — locality slug, e.g. "la-plata". Absent = province-level (or national). */
  locality?: string | string[] | null;
};

export type JurisdictionScopeInput = {
  /**
   * From requireGobReadAccessOrRedirect(). admin | national ⇒ universal read
   * scope, empty jurisdictions (hasNationalReadScope decides — never the
   * emptiness of the list); govt ⇒ the mandate below.
   */
  role: GobReadRole;
  /** The operator's assignment set. Admin gets [] by contract (= universal). */
  jurisdictions: DashboardJurisdiction[];
  /** The raw ?province / ?locality searchParams (ISO code + slug). */
  params: JurisdictionScopeParams;
};

export type ResolvedJurisdictionScope = {
  /** ?province resolved (canonical name + ISO + slug), or null for national scope. */
  selectedProvince: Province | null;

  /** ?locality resolved to its catalog row (canonical localityName + slug), or null. */
  selectedLocality: Locality | null;

  /** Localities of selectedProvince, for the <JurisdictionSwitcher> dropdown. [] when national. */
  localities: LocalityOption[];

  /**
   * THE FENCE. The operator's jurisdictions narrowed by the selection.
   * Delegates to resolveScopedJurisdictions — NEVER widens beyond assignments.
   * Admin ⇒ returned unchanged (empty = universal; SQL scope short-circuits on role).
   */
  filteredJurisdictions: DashboardJurisdiction[];

  /**
   * The provinces the switcher may offer.
   * Admin ⇒ GOB_ALL_PROVINCES (all 24). Govt ⇒ derived from ORIGINAL assignments
   * (NOT filteredJurisdictions — a switcher derived from the narrowed set would
   * shrink to one province after a selection and trap the operator).
   */
  allowedProvinces: Array<{ code: string; name: string }>;

  /**
   * ADMIN-ONLY drill-down names, to push into a SQL WHERE for tables the admin
   * queries universally (admin has no assignments to narrow, so the URL selection
   * is applied as an explicit predicate instead). Both null for govt — a govt's
   * scope is ALREADY enforced by filteredJurisdictions, and passing these for govt
   * would be a widening vector.
   */
  adminSelectedProvince: string | null;
  adminSelectedLocality: string | null;
};

/**
 * Resolve `(role, jurisdictions, {province, locality} searchParams)` into the full
 * jurisdiction-scope value a gob screen needs. See the module header for the fence
 * guarantees and dim-interno:docs/plans/jurisdiction-scope-primitive.md for the branch table.
 */
export async function resolveJurisdictionScope(
  input: JurisdictionScopeInput,
): Promise<ResolvedJurisdictionScope> {
  const { role, jurisdictions } = input;

  // Collapse repeated search params ONCE, at the boundary. Everything below
  // may assume plain strings. See JurisdictionScopeParams for why the input
  // type admits arrays at all.
  const params = {
    province: firstSearchParam(input.params.province ?? undefined),
    locality: firstSearchParam(input.params.locality ?? undefined),
  };

  const selectedProvince = params.province ? provinceByCode(params.province) : null;

  // Single-jurisdiction Localidad fix (qa-triage-2026-07-23, finding #10): a
  // govt operator with EXACTLY ONE assigned province (e.g. a whole-CABA
  // assignment) never gets a `?province=` searchParam by default — the
  // Provincia switcher shows their one province with no "Todas" option to
  // "select" (nothing to disambiguate), so no onChange ever fires to set the
  // param. Before this fix `localities` stayed `[]` in that case, permanently
  // trapping the Localidad <select> in a disabled, unexplained state — a dead
  // control the operator could never unlock through the UI. Narrowing to a
  // barrio WITHIN a whole-province assignment is already a supported, fenced
  // drill-down (isWholeProvinceAssignment subsumption, jurisdiction-canonical.ts)
  // — this only fills the switcher's OWN dropdown for that legitimate case; it
  // does not touch `selectedProvince`/map-drill state below, which stay gated
  // on the real (explicit) URL param. (It DOES now reach the locality drill —
  // see `localityScopeProvince` below, the second half of the same defect.)
  // admin | national: universal read scope, URL selection is an explicit DRILL.
  // govt: the mandate is the ceiling, the URL selection narrows within it.
  const universal = hasNationalReadScope(role);

  const uniqueProvinceNames = universal
    ? []
    : Array.from(new Set(jurisdictions.map((j) => j.province)));
  const impliedSoleProvince =
    !selectedProvince && uniqueProvinceNames.length === 1
      ? provinceByName(uniqueProvinceNames[0])
      : null;

  const dropdownProvince = selectedProvince ?? impliedSoleProvince;
  const provinceLocalities = dropdownProvince
    ? await listLocalitiesByProvince(dropdownProvince.code as ProvinceCode)
    : [];
  // Mandate-scoped dropdown (red-team 2026-07 finding #2): a govt operator's
  // Localidad <select> must only OFFER localities inside their mandate. Before
  // this fix it listed the WHOLE province (all 48 CABA barrios for a
  // Palermo-only operator) — selecting an out-of-mandate barrio resolved to an
  // empty set (fail-closed, no leak) but let the operator "operate" outside
  // their mandate with no signal. A whole-province assignment ("" sentinel or
  // the CABA whole-city entry) legitimately covers every barrio and keeps the
  // full list; only locality-scoped mandates constrain it. Admin is universal
  // and always keeps the full list. Display-only: `filteredJurisdictions`
  // (THE FENCE) is untouched — this narrows what the switcher offers, never
  // what the queries scope by.
  const localities =
    !universal && dropdownProvince
      ? constrainLocalitiesToMandate(provinceLocalities, jurisdictions, dropdownProvince.name)
      : provinceLocalities;

  // Second half of the single-jurisdiction Localidad defect (blind QA
  // 2026-08-19, O11/O12). Unlocking the dropdown above was not enough: the
  // operator picks "Palermo", the URL gets `?locality=Palermo` with NO
  // `?province=` (nothing ever sets it — see above), so `selectedLocality`
  // resolved to null and `narrowGovtScope`'s `if (!selectedProvince) return
  // jurisdictions` returned the UNFILTERED assignment set. The list kept
  // showing San Cristóbal / Villa Lugano / Retiro and the header kept
  // claiming "85 denuncias en total" while the UI rendered an active
  // "Localidad: Palermo" chip. A filter that says it is on and is not.
  //
  // NARROWING ONLY, and it cannot widen: the implied province is the
  // operator's OWN sole assignment, and the fence still runs the selection
  // through `jurisdictionScopeContains`, which fails closed to `[]` for
  // anything outside the mandate. Admin never reaches this path
  // (`uniqueProvinceNames` is empty for admin, so `impliedSoleProvince` is
  // null) and keeps its explicit-param contract untouched.
  const localityScopeProvince = selectedProvince ?? impliedSoleProvince;

  const selectedLocality =
    localityScopeProvince && params.locality
      ? await localityByName(localityScopeProvince.code as ProvinceCode, params.locality)
      : null;

  // The province name handed to THE FENCE. For the implied case this is the
  // STORED assignment string rather than `Province.name` from the catalog,
  // because the fence compares province names with exact equality
  // (`jurisdictionScopeContains`) while `provinceByName` NORMALISES aliases —
  // it maps "Ciudad Autónoma de Buenos Aires" onto the canonical "CABA".
  //
  // Today the two are always identical: the DB constraint
  // `govt_assignments_jurisdiction_province_canonical` restricts
  // jurisdiction_province to exactly the 24 canonical names, so no alias can
  // be stored and the round-trip is the identity. This is therefore NOT
  // load-bearing against a live hazard, and a test cannot distinguish the two
  // forms without fabricating a row the database would reject — do not read
  // the choice as evidence of one. It is written this way so that if that
  // constraint is ever relaxed, the fence narrows instead of silently emptying
  // the operator's scope. (Note the asymmetry, flagged in review 2026-08-19:
  // `constrainLocalitiesToMandate` above filters on the CATALOG name, so under
  // a relaxed constraint the switcher would go empty and no `?locality=` could
  // be produced through the UI anyway. The two halves disagree about which
  // name is authoritative; unify them if the constraint ever moves.)
  const fenceProvinceName =
    selectedProvince?.name ?? (selectedLocality ? (uniqueProvinceNames[0] ?? null) : null);

  // THE FENCE — delegated to the already-tested pure core.
  const filteredJurisdictions = resolveScopedJurisdictions({
    jurisdictions,
    role,
    selectedProvinceName: fenceProvinceName,
    selectedLocalityName: selectedLocality?.localityName ?? null,
  });

  const allowedProvinces = universal
    ? GOB_ALL_PROVINCES
    : Array.from(new Set(jurisdictions.map((j) => j.province)))
        .map((name) => ({ code: PROVINCE_ISO_MAP[name] ?? "", name }))
        .filter((p) => p.code !== "");

  const adminSelectedProvince = universal ? (selectedProvince?.name ?? null) : null;
  const adminSelectedLocality = universal ? (selectedLocality?.localityName ?? null) : null;

  return {
    selectedProvince,
    selectedLocality,
    localities,
    filteredJurisdictions,
    allowedProvinces,
    adminSelectedProvince,
    adminSelectedLocality,
  };
}

/**
 * Intersect a province's full locality catalog with a GOVT operator's
 * assignments for that province (by canonical locality name — the exact
 * strings both `jurisdictions` and the catalog's `name` carry). Any
 * whole-province assignment for the province keeps the full list (the mandate
 * legitimately covers every locality/barrio). No assignments for the province
 * at all (an out-of-mandate ?province the switcher never offers) ⇒ empty —
 * fail-closed, same posture as the fence itself.
 */
function constrainLocalitiesToMandate(
  provinceLocalities: LocalityOption[],
  jurisdictions: DashboardJurisdiction[],
  provinceName: string,
): LocalityOption[] {
  const assigned = jurisdictions.filter((j) => j.province === provinceName);
  if (assigned.some((j) => isWholeProvinceAssignment(j))) return provinceLocalities;
  const assignedNames = new Set(assigned.map((j) => j.locality));
  return provinceLocalities.filter((l) => assignedNames.has(l.name));
}

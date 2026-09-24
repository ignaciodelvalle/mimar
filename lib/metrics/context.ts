// ProjectionContext — the single argument shape for every aggregate dashboard fetcher.
//
// Both DashboardActor and DashboardJurisdiction were previously duplicated in
// lib/govt-dashboards.ts and lib/govt-home-kpis.ts. This is now the single source
// of truth. Both files import from here; their local declarations are removed.
//
// Usage:
//   const ctx = buildProjectionContext(actor, jurisdictions, period);
//   const kpi  = await fetchRabiesCoverage(ctx);

import type { AnalyticsPeriod } from "@/lib/analytics/analytics-period";
import {
  type GobReadRole,
  hasNationalReadScope,
  isWholeProvinceAssignment,
  isWholeProvinceLocality,
} from "@/lib/domain/jurisdiction-canonical";

/**
 * Who is asking: admin or national (universal read scope) or govt
 * (jurisdiction-scoped). Universality is decided by `hasNationalReadScope`
 * (lib/domain/jurisdiction-canonical.ts) — never by comparing `role` against
 * `"admin"` at a call site.
 */
export type DashboardActor = { role: GobReadRole };

/** A single jurisdiction pair as stored in govt_assignments. */
export type DashboardJurisdiction = { province: string; locality: string };

/** The scope dimension of a ProjectionContext. */
export type ProjectionScope =
  | { kind: "global" } // admin — no WHERE restriction
  | { kind: "jurisdictions"; jurisdictions: DashboardJurisdiction[] }; // govt

/**
 * The single context object every aggregate fetcher accepts.
 * Construct it ONCE at the page boundary and pass it to all tile fetchers.
 * This unlocks React.cache dedup: every fetcher that derives the same base
 * population hits the memoized result instead of re-querying.
 */
export type ProjectionContext = {
  actor: DashboardActor;
  scope: ProjectionScope;
  /** The resolved time window from resolveAnalyticsPeriod (carries {since, until}). */
  period: AnalyticsPeriod;
  /**
   * Admin province drill-down (Panorama console). Only set when
   * actor.role === "admin" and a specific province was selected via the URL
   * (?province=AR-X). Never set for govt actors — their scope is already
   * enforced by the jurisdiction pairs in scope.jurisdictions.
   *
   * When set, petsScopeClause / petEventsScopeClause append an ADDITIONAL
   * province (and optionally locality) predicate that narrows from universal
   * scope to the selected area.
   */
  adminProvince?: string;
  /**
   * Admin locality drill-down. Only meaningful when adminProvince is also set.
   * Never set for govt actors.
   */
  adminLocality?: string;
  /**
   * Panorama "solo firmado por matrícula" numerator narrowing (task #78 Part 3).
   * When true, the rabies-coverage fetchers (fetchRabiesCoverage /
   * fetchRabiesCoverageByProvince) count ONLY doses signed by a matriculated vet
   * (rabiesSignedByMatriculaCondition). It NARROWS the numerator only — it never
   * widens scope, k-anon or auth. Absent/false → every recorded dose counts.
   * Only the rabies-coverage fetchers read it; every other fetcher ignores it.
   */
  verifiedOnly?: boolean;
};

/**
 * The scope half of a ProjectionContext, on its own.
 *
 * Exists for the disclosure rule (`planProvinceDisclosure`,
 * `isOwnJurisdictionProvince`), which reads NOTHING but `scope`. A fetcher that
 * has an (actor, jurisdictions) pair but no period — `fetchRegionRanking` is the
 * one — used to have two bad options: invent a period the rule never reads, or
 * re-derive "is this province mine?" locally. The second is how a codebase ends
 * up with two scope models that disagree; this is the first one, factored out.
 *
 * `buildProjectionContext` delegates here, so there is still exactly ONE place
 * that decides admin ⇒ global / govt ⇒ jurisdictions.
 */
export function buildProjectionScope(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
): ProjectionScope {
  return hasNationalReadScope(actor.role)
    ? { kind: "global" }
    : { kind: "jurisdictions", jurisdictions };
}

/** The minimum a caller must hand the D.10 disclosure rule. Any full
 *  `ProjectionContext` satisfies it structurally. */
export type ScopedForDisclosure = Pick<ProjectionContext, "scope">;

/**
 * Build a ProjectionContext from the three values already available at any
 * dashboard page boundary:
 *  - actor       — from requireAdminOrGovtOrRedirect
 *  - jurisdictions — from getJurisdictionsCached (empty for admin)
 *  - period      — from resolveAnalyticsPeriod(searchParams)
 *
 * The optional `opts` argument accepts an `adminProvince` / `adminLocality`
 * pair for the Panorama admin drill-down. These are silently ignored for govt
 * actors (scope.kind is "jurisdictions" so the admin branch never fires in
 * the scope helpers). Never pass them from govt page code.
 */
export function buildProjectionContext(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  period: AnalyticsPeriod,
  opts?: { adminProvince?: string; adminLocality?: string; verifiedOnly?: boolean },
): ProjectionContext {
  const scope: ProjectionScope = buildProjectionScope(actor, jurisdictions);

  return {
    actor,
    scope,
    period,
    // adminProvince/adminLocality are only meaningful for admin actors; the
    // scope helpers already gate on scope.kind === "global" before reading them.
    adminProvince: opts?.adminProvince,
    adminLocality: opts?.adminLocality,
    // Numerator-only narrowing for the panorama vet-signed toggle (task #78 P3).
    verifiedOnly: opts?.verifiedOnly,
  };
}

/**
 * A stable string key for a ProjectionContext, suitable as a React.cache
 * surrogate key. Two contexts with the same scope+period+adminProvince produce
 * the same key. Admin drill-down (adminProvince) extends the key so that a
 * national admin ctx and a province-scoped admin ctx never collide in cache.
 */
export function ctxKey(ctx: ProjectionContext): string {
  const scopePart =
    ctx.scope.kind === "global"
      ? "global"
      : ctx.scope.jurisdictions
          .map((j) => `${j.province}:${j.locality}`)
          .sort()
          .join(",");
  const adminPart = ctx.adminProvince
    ? `|admin:${ctx.adminProvince}${ctx.adminLocality ? `:${ctx.adminLocality}` : ""}`
    : "";
  // verifiedOnly changes the rabies numerator — a verified and a non-verified ctx
  // must never collide in a React.cache surrogate keyed on this string.
  const verifiedPart = ctx.verifiedOnly ? "|verified" : "";
  return `${scopePart}${adminPart}${verifiedPart}|${ctx.period.since.toISOString()}|${ctx.period.until.toISOString()}`;
}

/**
 * True when the context targets a grain FINER than a whole province — an admin
 * locality drill-down, or a govt scope that includes any specific-locality
 * assignment (locality === "" means the WHOLE province, which is census grain).
 *
 * WHY this matters for per-cápita: the census denominator table
 * (`jurisdictions_census`) holds ONLY the 24 province rows (Censo 2022) — no
 * department/locality populations exist yet (the same v1 limitation documented
 * in src/modules/panorama/domain/percapita.ts, which gates the MAP's per-cápita
 * encoding to `level === "province"`). A KPI that counts a locality-scoped
 * numerator but divides by the whole-province census population UNDERSTATES the
 * rate by the province/locality population ratio (~13× for Palermo within CABA).
 * The honest response is to SUPPRESS the per-cápita rate at sub-province grain
 * and show the absolute count instead — never a fabricated rate. Callers use
 * this to gate the census-denominator KPIs, mirroring `percapitaEligibleFor`.
 */
export function isSubProvincialScope(ctx: ProjectionContext): boolean {
  if (ctx.scope.kind === "global") {
    // Admin: sub-provincial only when drilled into a specific locality.
    return !!ctx.adminLocality;
  }
  // Govt: sub-provincial when ANY assigned jurisdiction targets a grain FINER
  // than the whole province. A whole-province assignment stays census grain —
  // and that is stored TWO ways: the generic `locality === ""`, AND the two-tier
  // canonical form `{ province: "CABA", locality: "Ciudad Autónoma de Buenos
  // Aires" }` (isWholeProvinceLocality). We MUST mirror the query's own
  // subsumption (jurisdictionPairClause / petsScopeClause, which emit a
  // province-only predicate for both forms), or a whole-CABA operator — who DOES
  // have a census row and an honest per-10k rate — would be wrongly suppressed.
  return ctx.scope.jurisdictions.some(
    (j) => j.locality !== "" && !isWholeProvinceLocality(j.province, j.locality),
  );
}

/**
 * C3 (ONE VIEWSCOPE, plan-maestro-integridad §C3): the province whose
 * `jurisdictions_census` row may serve as a per-cápita DENOMINATOR for this
 * ctx — or `null` when no single census row honestly covers it. This is a
 * DIFFERENT question from `isSubProvincialScope` ("is the numerator
 * sub-provincial?") — it asks "may I divide by the census?".
 *
 * Eligibility considers the RESOLVED VIEW (ctx.scope.jurisdictions is already
 * the operator's EFFECTIVE set — every caller builds ctx from
 * `filteredJurisdictions`, the page's own URL-filter-narrowed array, never the
 * raw session assignments), not the raw assignment list:
 *
 *   - admin, drilled to a province with NO locality  → that province.
 *   - admin, national (no drill) or locality-drilled → null (no single
 *     province row applies to "todo el país"; a locality drill is finer than
 *     province grain, same principle as isSubProvincialScope).
 *   - govt, effective view covers ONE WHOLE province (at least one
 *     whole-province assignment in it) → that province.
 *   - govt, effective view spans multiple provinces, is empty, or covers only
 *     part of a province → null.
 *
 * THE PARTIAL-PROVINCE CORRECTION (demo review 2026-08-01) — read this before
 * loosening the rule again. A previous pass here reasoned that "multiple
 * assignments (even all locality-grain) aggregate into a province-wide VIEW"
 * and let a multi-barrio govt divide by the province census. It does not
 * follow, and the arithmetic says so: an operator holding 5 of CABA's 48
 * barrios has 662 registered dogs, and the tile read **0,1% del padrón sobre
 * la población canina estimada** — because the numerator was 5 barrios and the
 * denominator was all of CABA (≈3,12M inhabitants × 0.158 ≈ 493.000 dogs).
 * The honest figure for those barrios is roughly an order of magnitude higher.
 * The same gate gives fetchBitesPer10k its `percapitaEligible` flag, so the
 * "Mordeduras / 10k hab." rate was understated by the same ratio.
 *
 * "The whole scope they can SEE" is not "the whole province". Only a
 * whole-province assignment makes the numerator and the province census row
 * describe the same territory. Everything narrower now degrades to "Sin
 * estimación censal" and the absolute count — a missing estimate is a gap the
 * reader can see; a 10×-understated one is a number they will quote.
 *
 * (A govt holding every barrio of a province as separate rows is suppressed
 * too. Detecting that would need the locality catalog, and fail-closed is the
 * right side to err on: the cost is a missing co-headline, not a false one.)
 *
 * SURGICAL SCOPE: this does NOT replace `isSubProvincialScope`. A numerator
 * that is itself locality-grain (e.g. a bite count scoped to one barrio) must
 * still suppress its per-cápita rate even when the SCOPE would otherwise pass
 * this check — callers gating "is my numerator narrower than the census row I
 * want to divide by" keep using `isSubProvincialScope`. Callers gating
 * "may this VIEW use a census denominator at all" (fetchRabiesCoverage's
 * census-coverage co-headline, fetchBitesPer10k's percapitaEligible flag) use
 * THIS resolver instead — see lib/analytics/govt-home-kpis.ts.
 */
export function censusEligibleProvince(ctx: ProjectionContext): string | null {
  if (ctx.scope.kind === "global") {
    // Admin province drill (no locality) is census-eligible for that
    // province; national (no drill) and locality drills are not.
    return ctx.adminProvince && !ctx.adminLocality ? ctx.adminProvince : null;
  }

  const { jurisdictions } = ctx.scope;
  if (jurisdictions.length === 0) return null;

  const provinces = [...new Set(jurisdictions.map((j) => j.province))];
  if (provinces.length !== 1) return null; // spans multiple provinces — no single census row applies.

  // The census row describes a WHOLE province, so the view has to cover one.
  // Both storage forms of a whole-province assignment count (the generic
  // `locality === ""` and the two-tier canonical `{CABA, Ciudad Autónoma de
  // Buenos Aires}`) — isWholeProvinceAssignment mirrors the same subsumption
  // the SQL scope clauses emit.
  if (!jurisdictions.some(isWholeProvinceAssignment)) return null;

  return provinces[0];
}

// lib/ui/view-scope-caption.ts — C3 (ONE VIEWSCOPE, plan-maestro-integridad
// §C3), the PAGE-LEVEL half of the fix. `lib/ui/scope-chrome.ts` covers the
// shared layout's MANDATE claim; this covers a single page's disclosure when
// its OWN active filter narrows the view BELOW that mandate (e.g. a
// multi-locality govt operator who picked one locality, or an admin drilled
// into a single province/locality).
//
// Fed from values the page ALREADY resolved (filteredJurisdictions,
// adminProvince/adminLocality — the exact inputs buildProjectionContext takes)
// — this does not re-derive scope, it only compares the mandate against the
// effective view the ctx already carries.

import {
  type GobReadRole,
  hasNationalReadScope,
  isWholeProvinceAssignment,
} from "@/lib/domain/jurisdiction-canonical";
import { pluralizeEs } from "@/lib/utils/format";

export type ViewScopeJurisdiction = { province: string; locality: string };

/** The canonical identity of one (province, locality) pair — the key every
 *  set comparison and every stable serialization of a jurisdiction list uses.
 *  Exported so `lib/ui/view-scope-descriptor.ts` sorts by the SAME key this
 *  module compares by; two orderings of one identity would let a descriptor
 *  serialize the same view two ways. */
export function jurisdictionKey(j: ViewScopeJurisdiction): string {
  return `${j.province}|${j.locality}`;
}

/**
 * Set-equality on (province, locality) pairs. A plain LENGTH comparison is
 * not enough: a govt whose mandate is a SINGLE whole-province assignment
 * (e.g. CABA's two-tier canonical entry) drilled down to ONE specific
 * locality within it (`?locality=Palermo`) produces an effective view that is
 * still length-1 — same COUNT as the mandate, but a strictly FINER grain. Set
 * equality catches that; a bare length check does not.
 */
export function jurisdictionsEqual(
  a: readonly ViewScopeJurisdiction[],
  b: readonly ViewScopeJurisdiction[],
): boolean {
  if (a.length !== b.length) return false;
  const aKeys = new Set(a.map(jurisdictionKey));
  return b.every((j) => aKeys.has(jurisdictionKey(j)));
}

export type DescribeNarrowedViewParams = {
  role: GobReadRole;
  /** The operator's full MANDATE — raw session assignments (govt only). */
  mandateJurisdictions: readonly ViewScopeJurisdiction[];
  /**
   * The EFFECTIVE view after the page's own filter resolution — e.g.
   * `filteredJurisdictions` from `resolveJurisdictionScope`. Ignored for admin
   * (admin's mandate is universal; its narrowing is expressed via
   * adminProvince/adminLocality instead).
   */
  effectiveJurisdictions?: readonly ViewScopeJurisdiction[];
  /** Admin province drill (set only when profile.role === "admin"). */
  adminProvince?: string;
  /** Admin locality drill (only meaningful alongside adminProvince). */
  adminLocality?: string;
};

/**
 * Describe the ACTIVE VIEW when — and ONLY when — a filter has narrowed it
 * below the operator's mandate. Returns `null` when the view equals the
 * mandate (an unfiltered /gob or a national /admin), so a page renders
 * NOTHING extra in the common case — this is a disclosure for the narrowed
 * case, not a permanent second scope line competing with the mandate badge.
 */
export function describeNarrowedView(params: DescribeNarrowedViewParams): string | null {
  const {
    role,
    mandateJurisdictions,
    effectiveJurisdictions = [],
    adminProvince,
    adminLocality,
  } = params;

  if (hasNationalReadScope(role)) {
    if (!adminProvince) return null; // national — nothing narrower to disclose.
    return adminLocality ? `${adminLocality}, ${adminProvince}` : adminProvince;
  }

  // govt: narrowed when the effective (filtered) set is NOT the same set as
  // the mandate — either fewer jurisdictions in view than assigned, OR the
  // same count but a finer grain (a single whole-province mandate drilled to
  // one specific locality within it — see jurisdictionsEqual's doc comment).
  if (
    effectiveJurisdictions.length === 0 ||
    jurisdictionsEqual(mandateJurisdictions, effectiveJurisdictions)
  ) {
    return null;
  }

  if (effectiveJurisdictions.length === 1) {
    const [j] = effectiveJurisdictions;
    return isWholeProvinceAssignment(j) ? j.province : `${j.locality}, ${j.province}`;
  }

  const provinces = [...new Set(effectiveJurisdictions.map((j) => j.province))];
  const localidadesWord = pluralizeEs(effectiveJurisdictions.length, "localidad");
  return provinces.length === 1
    ? `${effectiveJurisdictions.length} ${localidadesWord} · ${provinces[0]}`
    : `${effectiveJurisdictions.length} ${localidadesWord} · ${provinces.length} provincias`;
}

export type OperativeJurisdictionScopeParams = {
  role: GobReadRole;
  /**
   * The EFFECTIVE (already-filtered) jurisdictions in view — e.g.
   * `filteredJurisdictions` from `resolveJurisdictionScope`. Ignored for
   * admin (admin's narrowing is expressed via `adminProvince` instead).
   */
  effectiveJurisdictions: readonly ViewScopeJurisdiction[];
  /** Admin province drill (set only when role === "admin" and a province was selected). */
  adminProvince?: string;
};

/**
 * True when the CURRENT effective view is narrowed to a SINGLE PROVINCE — the
 * grain PO decision 4 (2026-07-23, "Pérdidas: ubicación legible + scope
 * operativo") calls "an operative jurisdiction", i.e. where dispatch/contact
 * actually happens. False for admin's national/universal view (no province
 * drill) and for a govt view whose effective jurisdictions still span
 * MULTIPLE provinces — the two "NATIONAL/multi-province" cases the same
 * decision requires owner-identifying fields to stay hidden for.
 *
 * Deliberately keyed off the SAME resolved values a page already computes
 * for its ProjectionContext (`filteredJurisdictions`, `adminProvince`) — this
 * does not re-derive scope, it only classifies the already-resolved view
 * (C3, ONE VIEWSCOPE — mirrors `describeNarrowedView` above).
 */
export function isNarrowedToOperativeJurisdiction(
  params: OperativeJurisdictionScopeParams,
): boolean {
  if (hasNationalReadScope(params.role)) return params.adminProvince != null;
  if (params.effectiveJurisdictions.length === 0) return false;
  const provinces = new Set(params.effectiveJurisdictions.map((j) => j.province));
  return provinces.size === 1;
}

// Mandate-scoped resolution of KPI legal citations (red-team CRITICAL,
// PO-approved 2026-07): a government operator whose mandate is e.g.
// CABA + Tierra del Fuego + Santa Cruz used to see "PBA: Ley 14.107" (then
// mapped to microchip — see the registry note, that mapping was false and is
// gone) and "Ley CABA 5470" (mortality) cited on their tiles as THEIR
// legal obligation — laws of provinces NOT in their mandate. This module
// resolves a metric's legal basis against the operator's mandate provinces so
// a province's law is only ever shown to an operator whose mandate includes
// that province.
//
// Rules:
//   - National laws always apply — never province-gated.
//   - A province's laws are included ONLY when that province is in the
//     caller's mandate. Admin/national callers pass "all" and get everything.
//   - When a metric HAS provincial entries but NONE match the mandate, the
//     operator gets neutral es-AR framing ("Según la normativa provincial de
//     tu jurisdicción") — never a foreign province's law, never a blank.
//
// The citations here are the SAME strings already cited in
// lib/metrics/kpi-catalog.ts (target.source / caveats) — that catalog stays
// the canonical full national reference (admin view, info popovers); this
// module only decides WHICH of those citations a jurisdictional operator's
// tile may display. Do NOT add laws here that the catalog/docs do not already
// cite (no invented legal research).
//
// Province keys are the CANONICAL display names stored in govt_assignments'
// jurisdiction_province column (lib/domain/jurisdiction-canonical.ts →
// lib/reference/ar-provincias.ts PROVINCES): "Buenos Aires", "CABA", ….
// Lives in its own module (not kpi-catalog.ts) — the catalog is at its
// file-size ceiling.

import type { KpiId } from "./kpi-catalog";

export type MetricLegalBasis = {
  /** National anchors — always shown, never province-gated. */
  national?: string[];
  /** Canonical province display name → that province's citations. */
  byProvince?: Record<string, string[]>;
};

/**
 * The operator's mandate provinces (distinct canonical province names from
 * the auth guard's `jurisdictions`), or "all" for an admin/national caller
 * with universal scope.
 */
export type MandateProvinces = readonly string[] | "all";

// Per-metric legal basis — populated ONLY from citations that already exist
// in lib/metrics/kpi-catalog.ts today. Neither of these metrics has a
// national anchor in the repo's citations; `national` stays absent until the
// catalog cites one.
//
// microchip_penetration HAS NO ENTRY, AND MUST NOT GET ONE (legal research
// 2026-08-17, engram legal/claims-refutadas-2026-08-17). It used to map to
// `{"Buenos Aires": ["Ley Prov. 14.107"]}`, presented as PBA's microchip
// mandate. The sources refute that:
//   - Ley 14.107 (PBA) art. 8 inc. b requires identifying the dog "por medio
//     de un chip O DE UN TATUAJE", and only for potentially-dangerous breeds.
//     It permits a chip; it does not mandate one, and it does not reach the
//     general padrón this metric counts.
//   - Ley CABA 4.078 art. 6 covers PPP only and requires a collar with a
//     chapa identificatoria — it never mentions a microchip at all.
//   - SENASA states no national electronic-identification regulation exists.
// So there is no Argentine jurisdiction whose law can be sourced as mandating
// the chip, and the honest output is NO citation rather than a narrower or
// substituted one. The two statutes stay cited below for the PPP registry
// obligation, which IS what they actually regulate — do not read their
// absence here as doubt about that entry.
export const METRIC_LEGAL_BASIS: Partial<Record<KpiId, MetricLegalBasis>> = {
  ppp_registry_compliance: {
    byProvince: { CABA: ["Ley 4078"], "Buenos Aires": ["Ley Prov. 14.107"] },
  },
  mortality_disposal_traceability: {
    byProvince: { CABA: ["Ley 5470"] },
  },
};

// Short display prefix for provinces whose canonical name is long — matches
// the abbreviation the tiles already used ("PBA: Ley 14.107").
const PROVINCE_DISPLAY_PREFIX: Record<string, string> = {
  "Buenos Aires": "PBA",
};

/** Neutral es-AR fallback when the metric is province-regulated but none of
 * the mandate's provinces has a registered citation. */
export const PROVINCIAL_GAP_FALLBACK_ES = "Según la normativa provincial de tu jurisdicción";

/**
 * es-AR qualifier prepended when the VIEW is national ("all") and every
 * citation the metric has is provincial (no `national` anchor).
 *
 * WHY (demo review 2026-08-01): at national scope /gob rendered "Disposición
 * trazable — Obligación: Ley CABA 5470" and the equivalent line for the PPP
 * registry. In front of national officials that is not a copy nit, it is a
 * legal error: a provincial statute presented as the obligation of the whole
 * country.
 *
 * The fix is NOT to swap the law. Ley 5470 really is CABA's disposal law and
 * Ley 4078 / Ley 14.107 really do impose the PPP registry duty in their own
 * jurisdictions; no national equivalent is cited anywhere in kpi-catalog.ts,
 * and this module's contract forbids inventing legal research to fill the
 * gap. Suppressing THOSE citations would be worse still — the obligation
 * genuinely exists, it just does not bind uniformly. What was missing is the
 * SCOPE of the norm: say that the obligation is provincial, that it does not
 * cover the national figure on screen, and keep naming which province it
 * comes from so the reader can check it.
 *
 * That reasoning holds only where a real obligation exists. It is NOT a
 * licence to keep a citation whose underlying claim is false: the microchip
 * mapping was dropped outright (see the registry note) because no scope
 * qualifier can rescue a law that never imposed the duty being measured.
 */
export const NATIONAL_VIEW_PROVINCIAL_ONLY_ES = "normativa provincial (no nacional)";

function matchedProvinceEntries(
  basis: MetricLegalBasis,
  mandateProvinces: MandateProvinces,
): Array<[province: string, laws: string[]]> {
  const entries = Object.entries(basis.byProvince ?? {});
  if (mandateProvinces === "all") return entries;
  return entries.filter(([province]) => mandateProvinces.includes(province));
}

/**
 * Resolve the laws a caller with `mandateProvinces` may be shown for `kpiId`.
 *
 * `hasProvincialGap` is true when the metric HAS provincial entries but NONE
 * of the mandate's provinces matched — the render site should fall back to
 * national/neutral framing, never a foreign province's law.
 */
export function resolveMetricLegalBasis(
  kpiId: KpiId,
  mandateProvinces: MandateProvinces,
): { laws: string[]; hasProvincialGap: boolean } {
  const basis = METRIC_LEGAL_BASIS[kpiId];
  if (!basis) return { laws: [], hasProvincialGap: false };

  const matched = matchedProvinceEntries(basis, mandateProvinces);
  const laws = [...(basis.national ?? []), ...matched.flatMap(([, provinceLaws]) => provinceLaws)];
  const hasProvincialGap = Object.keys(basis.byProvince ?? {}).length > 0 && matched.length === 0;

  return { laws, hasProvincialGap };
}

/**
 * es-AR one-liner for tile/subtitle display, e.g. "CABA: Ley 5470",
 * "PBA: Ley Prov. 14.107", "Ley 22.953 (nacional)". When the metric is
 * province-regulated but no mandate province matched (and no national anchor
 * exists), returns the neutral fallback — NEVER a foreign province's law.
 * Returns null when the metric has no legal basis registered.
 *
 * A NATIONAL view (`"all"`) whose only citations are provincial gets them
 * prefixed with NATIONAL_VIEW_PROVINCIAL_ONLY_ES — see that constant for why
 * the answer is to disclose the norm's scope rather than to change, or drop,
 * the law being cited.
 */
export function formatMetricLegalBasis(
  kpiId: KpiId,
  mandateProvinces: MandateProvinces,
): string | null {
  const basis = METRIC_LEGAL_BASIS[kpiId];
  if (!basis) return null;
  return formatLegalBasis(basis, mandateProvinces);
}

/**
 * The pure formatter behind formatMetricLegalBasis, over a basis VALUE rather
 * than a catalog id.
 *
 * Split out because the national-anchor branch below is currently unreachable
 * through the registry: not one entry in METRIC_LEGAL_BASIS declares
 * `national` today (see the note above the registry), so a mutation deleting
 * the `nationalLaws.length === 0` condition survived the whole suite — the
 * guard was future-proofing with zero coverage, and the future KPI that
 * finally cites a national law would have been mislabelled "no nacional"
 * without a single test going red. Exported so both branches are testable
 * without mutating the shared registry object.
 */
export function formatLegalBasis(
  basis: MetricLegalBasis,
  mandateProvinces: MandateProvinces,
): string | null {
  const nationalLaws = basis.national ?? [];
  const matched = matchedProvinceEntries(basis, mandateProvinces);
  const parts: string[] = nationalLaws.map((law) => `${law} (nacional)`);
  for (const [province, laws] of matched) {
    const prefix = PROVINCE_DISPLAY_PREFIX[province] ?? province;
    parts.push(`${prefix}: ${laws.join(" / ")}`);
  }

  // The whole country in view, and nothing national to anchor the obligation
  // to. The citations still stand — they just do not reach this scope, and
  // the reader has to be told so before the province prefixes, not after.
  if (mandateProvinces === "all" && nationalLaws.length === 0 && matched.length > 0) {
    return [NATIONAL_VIEW_PROVINCIAL_ONLY_ES, ...parts].join(" · ");
  }

  if (parts.length > 0) return parts.join(" · ");
  // Province-regulated metric, no mandate match, no national anchor → neutral
  // framing (never a foreign law, never a blank).
  if (Object.keys(basis.byProvince ?? {}).length > 0) return PROVINCIAL_GAP_FALLBACK_ES;
  return null;
}

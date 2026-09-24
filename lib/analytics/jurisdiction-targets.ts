import "server-only";

// Jurisdiction-aware compliance TARGETS (jurisdiction-compliance WU4b —
// spec §7 JT1-JT5, design ADR-8; closes governance hole #10).
//
// ONE rule type (`compliance_targets`, resolutionScope 'jurisdiction-metric')
// carries a PARTIAL payload over the four legally-varying targets:
// rabies_coverage_pct / microchip_penetration_pct / sterilization_coverage_pct
// / ppp_attestation_pct. Everything else in TARGETS (adoption, reunification,
// campaign, disposal, dormant, ENO, RABIES_OBSERVATION_COMPLIANCE_PCT) is a
// national programmatic benchmark and STAYS flat by design.
//
// BOUNDARIES (JT3/JT5 — the fence lines):
//   - lib/metrics/targets.ts stays PURE (zero DB import) and remains the flat
//     default tier. Jurisdiction resolution happens ONLY here, in RSC callers'
//     request path; client Screens receive numbers, never resolve.
//   - admin/* surfaces are national BY DEFINITION and never call this module
//     (JT5 — fenced by the fs-scan in jurisdiction-targets.test.ts). Panorama
//     layers' complianceTarget is deferred to v2 (out of scope).
//
// A1 HOUSE PATTERN (same shape as the rabies_observation_window resolution at
// bite time): resolveBusinessRule → merge resolved values over the flat
// `TARGETS` defaults → clamp each to 0..100 → try/catch fallback to flat
// TARGETS on ANY read failure — a broken rules read must degrade a meta, never
// fail a dashboard page.
//
// BOUNDED BY CONSTRUCTION (T6 review M1, 2026-08-16): a try/catch catches
// REJECTIONS, not HANGS. `resolveBusinessRule` issues up to three sequential
// un-timeouted SELECTs, and every /gob caller used to await this OUTSIDE its
// `loadWithTimeout` group — so a degraded pooler hung the whole government
// dashboard with no deadline, no degraded chrome and nothing logged (the same
// incident class documented at app/(app)/mis-mascotas/[publicToken]/page.tsx).
// The deadline now lives HERE, at the single seam every caller shares, so the
// module's fail-safe claim is true wherever it is awaited.
//
// HONEST LABELING (JT4): every tile rendering an ADJUSTED value must disclose
// it (JURISDICTION_ADJUSTED_TARGET_NOTE) — no silent number swap. `adjusted`
// is per-key and only true when the resolved override actually CHANGES the
// number; catalogued OpKpi `label` strings never change (RESERVED).

import { resolveBusinessRule } from "@/lib/infra/business-rules-resolver";
import type { DashboardJurisdiction } from "@/lib/metrics/context";
import { TARGETS } from "@/lib/metrics/targets";
import { loadWithTimeout } from "./analytics-load";

/** es-AR disclosure sub-line for any tile whose meta was locally adjusted. */
export const JURISDICTION_ADJUSTED_TARGET_NOTE = "Meta ajustada por normativa jurisdiccional";

/**
 * Deadline for the targets resolution (T6 review M1). Deliberately a SUB-budget
 * of ANALYTICS_LOAD_TIMEOUT_MS (10 s): this is at most three indexed single-row
 * lookups and it runs BEFORE the page's own fetcher deadline, so it must not be
 * able to consume the whole request budget on its own. On expiry the caller
 * gets the flat national tier — a meta degrades, a dashboard never hangs.
 */
export const JURISDICTION_TARGETS_TIMEOUT_MS = 3_000;

/** The four legally-varying TARGETS keys (JT1) — the whitelist, nothing else. */
export type JurisdictionTargetKey =
  | "RABIES_COVERAGE_PCT"
  | "MICROCHIP_PENETRATION_PCT"
  | "STERILIZATION_COVERAGE_PCT"
  | "PPP_ATTESTATION_PCT";

export type JurisdictionTargetValues = Record<JurisdictionTargetKey, number>;

export type JurisdictionTargets = {
  /** Effective targets: resolved overrides merged over the flat defaults. */
  values: JurisdictionTargetValues;
  /** Per-key: true iff a resolved override actually changed the number. */
  adjusted: Record<JurisdictionTargetKey, boolean>;
  /** Convenience OR over `adjusted` for section-level disclosures. */
  anyAdjusted: boolean;
};

/** compliance_targets payload field → TARGETS key (JT1 whitelist). */
const PAYLOAD_KEY_MAP: Record<string, JurisdictionTargetKey> = {
  rabies_coverage_pct: "RABIES_COVERAGE_PCT",
  microchip_penetration_pct: "MICROCHIP_PENETRATION_PCT",
  sterilization_coverage_pct: "STERILIZATION_COVERAGE_PCT",
  ppp_attestation_pct: "PPP_ATTESTATION_PCT",
};

/** The flat national tier as a JurisdictionTargets value (nothing adjusted). */
export function flatJurisdictionTargets(): JurisdictionTargets {
  return {
    values: {
      RABIES_COVERAGE_PCT: TARGETS.RABIES_COVERAGE_PCT,
      MICROCHIP_PENETRATION_PCT: TARGETS.MICROCHIP_PENETRATION_PCT,
      STERILIZATION_COVERAGE_PCT: TARGETS.STERILIZATION_COVERAGE_PCT,
      PPP_ATTESTATION_PCT: TARGETS.PPP_ATTESTATION_PCT,
    },
    adjusted: {
      RABIES_COVERAGE_PCT: false,
      MICROCHIP_PENETRATION_PCT: false,
      STERILIZATION_COVERAGE_PCT: false,
      PPP_ATTESTATION_PCT: false,
    },
    anyAdjusted: false,
  };
}

const clampPct = (value: number): number => Math.min(100, Math.max(0, value));

/**
 * Resolve the effective compliance targets for ONE jurisdiction (JT2).
 *
 * Never throws AND never hangs: any resolver failure falls back to the flat
 * TARGETS, and a resolver that never settles is cut at
 * JURISDICTION_TARGETS_TIMEOUT_MS with the same flat fallback (the timeout is
 * logged with a correlation id by loadWithTimeout — silence was the M1 bug).
 */
export async function resolveJurisdictionTargets(jurisdiction: {
  province?: string | null;
  locality?: string | null;
}): Promise<JurisdictionTargets> {
  const load = await loadWithTimeout(
    resolveTargetsUnbounded(jurisdiction),
    JURISDICTION_TARGETS_TIMEOUT_MS,
  );
  // Fail-safe (JT2 scenario "resolver throws", plus the M1 hang path): a
  // rules-read failure or a stalled pooler must never take a gob dashboard
  // down — degrade to the flat national tier.
  return load.ok ? load.value : flatJurisdictionTargets();
}

/** The read + merge itself. Bounded by its caller; may reject, may stall. */
async function resolveTargetsUnbounded(jurisdiction: {
  province?: string | null;
  locality?: string | null;
}): Promise<JurisdictionTargets> {
  const result = flatJurisdictionTargets();
  const resolved = await resolveBusinessRule("compliance_targets", jurisdiction);
  const payload = (resolved.payload ?? {}) as Record<string, unknown>;
  for (const [payloadKey, targetKey] of Object.entries(PAYLOAD_KEY_MAP)) {
    const raw = payload[payloadKey];
    if (typeof raw !== "number" || Number.isNaN(raw)) continue;
    const clamped = clampPct(raw);
    if (clamped === result.values[targetKey]) continue; // same number — nothing to disclose
    result.values[targetKey] = clamped;
    result.adjusted[targetKey] = true;
    result.anyAdjusted = true;
  }
  return result;
}

/**
 * Resolve targets for a gob screen's EFFECTIVE jurisdiction set (the fenced
 * `filteredJurisdictions`, or the admin drill-down pair).
 *
 * Policy — resolve only when the view maps to ONE normative regime:
 *   - exactly one (province, locality) pair with a real locality → resolve at
 *     locality grain (full cascade);
 *   - one distinct province (whole-province assignment, several localities, or
 *     a multi-barrio mandate) → resolve at PROVINCE grain — a locality
 *     override outside the resolved pair must not silently govern siblings;
 *   - empty set (admin universal / national view) or MULTIPLE provinces → the
 *     flat national tier, nothing adjusted. A cross-province aggregate has no
 *     single jurisdictional meta to disclose honestly.
 */
export async function resolveJurisdictionTargetsForScope(
  jurisdictions: readonly DashboardJurisdiction[],
): Promise<JurisdictionTargets> {
  if (jurisdictions.length === 0) return flatJurisdictionTargets();
  const provinces = new Set(jurisdictions.map((j) => j.province));
  if (provinces.size !== 1) return flatJurisdictionTargets();
  const [province] = provinces;
  const soleLocality =
    jurisdictions.length === 1 && jurisdictions[0].locality !== ""
      ? jurisdictions[0].locality
      : null;
  return resolveJurisdictionTargets({ province, locality: soleLocality });
}

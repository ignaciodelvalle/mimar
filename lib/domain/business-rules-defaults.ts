// Hardcoded defaults for govt business rules (POC scope).
// Spec 2026-05-19-govt-business-rules-poc-design §4.2.
//
// The resolver in lib/business-rules-resolver.ts returns one of these when
// no per-jurisdiction override row exists. Defaults snapshot the pre-POC
// behavior so the rollout is non-breaking.

import type { RequirementLevel } from "@/db/schema";
import { POTENTIALLY_DANGEROUS_DOG_BREEDS } from "@/lib/reference/breeds";

export interface PppBreedList {
  /** Canonical breed labels (matches lib/breeds.ts entries). */
  breeds: string[];
}

export interface PppWeightThreshold {
  /** kg cutoff. null = no weight rule. */
  kg: number | null;
  /** When true, the threshold applies even to breeds NOT on ppp_breed_list. */
  appliesIfBreedNotPPP: boolean;
}

export interface PppAttestationRegistry {
  id: string;
  label: string;
  required: boolean;
}

export interface PppAttestationRequiredRegistries {
  registries: PppAttestationRegistry[];
}

export interface PhysicalCredentialProvider {
  enabled: boolean;
  providerName?: string;
  providerUrl?: string;
}

export interface PhysicalCredentialChannels {
  printable_qr: boolean;
  engraved_plate: PhysicalCredentialProvider;
  nfc_tag: PhysicalCredentialProvider;
}

export interface MicrochipRequired {
  /**
   * Whether this jurisdiction requires a microchip. Default FALSE since RG2's
   * ratification (2026-08-16): with no rule row anywhere in the cascade the
   * obligation is NOT claimed — a jurisdiction opts IN by declaring the rule
   * mandatory, never by our silence.
   */
  required: boolean;
}

// ---------------------------------------------------------------------------
// Promoted rule types (design ADR-2/ADR-4) — hardcoded operational constants
// promoted to per-jurisdiction-overridable rules. Each default snapshots the
// CURRENT constant so rollout is non-breaking (R4.2): no override anywhere
// -> resolveBusinessRule returns exactly what the old literal returned.
// ---------------------------------------------------------------------------

export interface RabiesObservationWindow {
  /** Legal rabies-observation window, in days. Was RABIES_OBSERVATION_WINDOW_DAYS. */
  days: number;
}

export interface DueSoonWindow {
  /** "Próximo a vencer" lookahead window, in days. Was DUE_SOON_WINDOW_DAYS. */
  days: number;
}

export interface ReminderWindows {
  /** Global reminder lookahead, in days. Was WINDOW_AHEAD_DAYS. */
  aheadDays: number;
}

export interface LongStayDays {
  /** Shelter long-stay threshold, in days. Was LONG_STAY_DAYS. */
  days: number;
}

// ---------------------------------------------------------------------------
// mpf_export_format (jurisdiction-compliance, 2026-07-22 "MPF export format
// cascade") — which format the welfare MPF (fiscalía) denuncia PDF export
// uses for a jurisdiction. Cascades locality > province > country > national
// default like every other rule type. Replaces the old CABA-only
// MPF_CONFIGURED_PROVINCES gate (lib/domain/mpf-jurisdiction.ts, removed):
// every jurisdiction can now export; this rule decides WHICH format they get.
//
// HONESTY CONSTRAINT: the codebase renders exactly ONE PDF shape today (the
// free-form Ley 14.346 document, decision F-D1 in lib/analytics/welfare-
// exports.ts) — so the enum ships with exactly one legal value,
// "estandar_nacional". No second fiscalía format is invented here; adding one
// later means widening MPF_EXPORT_FORMATS + the CHECK constraint + a new
// renderer branch, and the cascade (this rule type) already exists to roll it
// out per-jurisdiction when that day comes.
// ---------------------------------------------------------------------------

export const MPF_EXPORT_FORMATS = ["estandar_nacional"] as const;
export type MpfExportFormatId = (typeof MPF_EXPORT_FORMATS)[number];

export interface MpfExportFormat {
  format: MpfExportFormatId;
}

// ---------------------------------------------------------------------------
// Jurisdiction-aware compliance obligations (migration 0183, rules-engine v2).
// The obligation TIER (mandatory/recommended/not_regulated/optional) and the
// legal provenance live in dedicated govt_business_rules COLUMNS, not in
// these payloads — payloads carry only the operational parameters. Defaults
// are EMPTY: with no override row anywhere, nothing is claimed about any
// jurisdiction's law (honest-by-default; the tier resolves to "no tier
// established", never to mandatory).
// ---------------------------------------------------------------------------

export interface RabiesVaccination {
  /** Booster cadence, in months (e.g. 12 = annual). */
  frequency_months?: number;
  /**
   * The norm that fixes `frequency_months`, when one does (PO decision
   * 2026-09-18, D5). Deliberately separate from the row's `legal_basis`
   * column: that column cites the OBLIGATION, and an obligation can be law
   * while its interval is an administrative choice. With this set, a date
   * computed from the cadence is a legal deadline; without it, a suggestion.
   */
  frequency_legal_basis?: string;
  /** Minimum age at which the obligation starts, in months. */
  min_age_months?: number;
}

export interface Sterilization {
  /** Minimum age at which sterilization is allowed, in months. */
  min_age_months?: number;
  /** Age from which the obligation applies, in months. */
  mandatory_from_months?: number;
}

/**
 * Per-jurisdiction metric targets (ADR-8) — PARTIAL record over the four
 * legally-varying TARGETS keys (lib/metrics/targets.ts). Absent keys fall
 * back to the flat national default; values are percentages 0..100.
 */
export interface ComplianceTargets {
  rabies_coverage_pct?: number;
  microchip_penetration_pct?: number;
  sterilization_coverage_pct?: number;
  ppp_attestation_pct?: number;
}

/**
 * OR5 consumer gate for the microchip obligation: the resolved
 * requirement_level SUPERSEDES payload.required when set; where no tier is
 * set the boolean keeps governing, so behavior is preserved during the
 * migration window (rows and defaults without a tier act exactly as before).
 */
export function microchipObligationApplies(rule: {
  requirementLevel?: RequirementLevel | null;
  payload: { required?: boolean };
}): boolean {
  return rule.requirementLevel != null
    ? rule.requirementLevel === "mandatory"
    : rule.payload.required !== false;
}

/**
 * Effective obligation info threaded into `deriveComplianceState` (spec CS1).
 *
 * `requirementLevel` is the EFFECTIVE tier for the surface, never null: a
 * resolved row's explicit tier always wins; with no tier established the
 * fallback preserves the pre-tier surface behavior (rabies/sterilization were
 * always rendered as obligations), so dev/test environments with NULL tiers
 * everywhere see zero behavior diff until baseline rows are seeded (WU2
 * sign-off pending). Legal metadata defaults to null — the projection then
 * keeps its generic stopgap footnote instead of inventing law (CS5).
 */
export interface ObligationRuleInfo {
  requirementLevel: RequirementLevel;
  legalBasis: string | null;
  authority: string | null;
  sourceUrl: string | null;
}

type ResolvedObligationRuleLike = {
  requirementLevel?: RequirementLevel | null;
  legalBasis?: string | null;
  authority?: string | null;
  sourceUrl?: string | null;
};

export function obligationRuleInfo(
  rule: ResolvedObligationRuleLike,
  fallbackLevel: RequirementLevel = "mandatory",
): ObligationRuleInfo {
  return {
    requirementLevel: rule.requirementLevel ?? fallbackLevel,
    legalBasis: rule.legalBasis ?? null,
    authority: rule.authority ?? null,
    sourceUrl: rule.sourceUrl ?? null,
  };
}

/**
 * Microchip variant of `obligationRuleInfo` — the tier fallback follows the
 * OR5 boolean gate (`payload.required`) instead of a flat default, so
 * `requirementLevel === "mandatory"` here is EXACTLY
 * `microchipObligationApplies(rule)` (parity-tested in
 * business-rules-defaults.test.ts). The default payload is `{required: false}`
 * because no Argentine norm mandates the chip (see BUSINESS_RULES_DEFAULTS
 * below for the sources), so with no row anywhere the effective tier is
 * `not_regulated` — the obligation surfaces only where a rule row claims it,
 * which today is nowhere.
 */
export function microchipObligationRuleInfo(
  rule: ResolvedObligationRuleLike & { payload: { required?: boolean } },
): ObligationRuleInfo {
  return obligationRuleInfo(rule, microchipObligationApplies(rule) ? "mandatory" : "not_regulated");
}

/**
 * The operational half of the resolved rabies + sterilization rules, as the
 * compliance projection computes with it (T1-G1). `obligationRuleInfo` carries
 * the tier + citation; this carries the payload numbers, which until T1-G1
 * were only rendered ("refuerzo cada 12 meses") and never enforced. A value
 * the jurisdiction did not set maps to null and is then not used — the
 * defaults are empty on purpose (nothing is claimed about any jurisdiction's
 * law without a row).
 */
export interface ComplianceRuleParamsInfo {
  rabies: {
    frequencyMonths: number | null;
    minAgeMonths: number | null;
    frequencyLegalBasis: string | null;
  };
  sterilization: { minAgeMonths: number | null; mandatoryFromMonths: number | null };
}

function nonBlankOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function complianceRuleParams(
  rabies: { payload: RabiesVaccination },
  sterilization: { payload: Sterilization },
): ComplianceRuleParamsInfo {
  return {
    rabies: {
      frequencyMonths: finiteOrNull(rabies.payload.frequency_months),
      minAgeMonths: finiteOrNull(rabies.payload.min_age_months),
      frequencyLegalBasis: nonBlankOrNull(rabies.payload.frequency_legal_basis),
    },
    sterilization: {
      minAgeMonths: finiteOrNull(sterilization.payload.min_age_months),
      mandatoryFromMonths: finiteOrNull(sterilization.payload.mandatory_from_months),
    },
  };
}

export interface BusinessRulePayloadByType {
  ppp_breed_list: PppBreedList;
  ppp_weight_threshold: PppWeightThreshold;
  ppp_attestation_required_registries: PppAttestationRequiredRegistries;
  physical_credential_channels: PhysicalCredentialChannels;
  microchip_required: MicrochipRequired;
  rabies_observation_window: RabiesObservationWindow;
  due_soon_window: DueSoonWindow;
  reminder_windows: ReminderWindows;
  long_stay_days: LongStayDays;
  mpf_export_format: MpfExportFormat;
  rabies_vaccination: RabiesVaccination;
  sterilization: Sterilization;
  compliance_targets: ComplianceTargets;
}

export type BusinessRulePayload<T extends keyof BusinessRulePayloadByType> =
  BusinessRulePayloadByType[T];

export const BUSINESS_RULES_DEFAULTS: {
  [K in keyof BusinessRulePayloadByType]: BusinessRulePayloadByType[K];
} = {
  ppp_breed_list: {
    breeds: [...POTENTIALLY_DANGEROUS_DOG_BREEDS],
  },
  ppp_weight_threshold: {
    kg: null,
    appliesIfBreedNotPPP: false,
  },
  ppp_attestation_required_registries: {
    registries: [],
  },
  physical_credential_channels: {
    printable_qr: true,
    engraved_plate: { enabled: false },
    nfc_tag: { enabled: false },
  },
  // Default FALSE — RG2, PO-ratified 2026-08-16, restored 2026-08-17.
  //
  // WHY, not just what: NO ARGENTINE NORM MANDATES THE MICROCHIP. PBA Ley
  // 14.107 art. 8 inc. b admits "un chip O DE UN TATUAJE" and only for PPP
  // dogs; Ley CABA 4.078 art. 6 requires a collar with chapa and never
  // mentions a chip; SENASA states no national electronic-identification
  // regulation exists (engram legal/claims-refutadas-2026-08-17). So silence
  // in the cascade is not a gap waiting to be filled — it is the accurate
  // answer, and `{required: true}` (migration 0150's assumed-mandatory
  // default) claimed an obligation that has no source anywhere in the country.
  //
  // This flip was parked once (revert 88689beb) because /gob simultaneously
  // cited Ley 14.107 as the chip mandate, and the two would have contradicted
  // each other in front of a funcionario. The resolution was NOT to wait for a
  // baseline row that could never exist: the citation was the false half, and
  // it was removed (see lib/metrics/metric-legal-basis.ts). The park's
  // precondition — "seed the baseline first so the not_regulated window is
  // transitory" — is void, because the window is not transitory and should
  // not be: not_regulated is simply true until some jurisdiction legislates.
  //
  // Matched rows are untouched: an explicit tier still wins, and a NULL-tier
  // row still gates on its own payload.required — so the day a province does
  // mandate the chip, one row turns it on for that province alone.
  microchip_required: { required: false },
  rabies_observation_window: { days: 10 },
  due_soon_window: { days: 30 },
  reminder_windows: { aheadDays: 14 },
  long_stay_days: { days: 60 },
  // The only format the codebase renders today — see the module docblock
  // above for why the enum has exactly one member.
  mpf_export_format: { format: "estandar_nacional" },
  // Empty by design (see the section docblock): no override row anywhere
  // means no claim about any jurisdiction's law — tier + citation resolve
  // from rows, never from a hardcoded national assumption.
  rabies_vaccination: {},
  sterilization: {},
  compliance_targets: {},
};

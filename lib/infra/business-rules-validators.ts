// Zod validators per rule_type. Spec 2026-05-19 §4.4.
//
// INSERT/UPDATE of govt_business_rules MUST validate `rule_payload` against
// the schema for its `rule_type` before persisting. Garbage in → 400.

import { z } from "zod";

import type { GovtBusinessRuleType } from "@/db";
import { MPF_EXPORT_FORMATS } from "@/lib/domain/business-rules-defaults";

export const pppBreedListSchema = z
  .object({
    breeds: z.array(z.string().min(1).max(80)).min(0).max(100),
  })
  .strict();

export const pppWeightThresholdSchema = z
  .object({
    kg: z.number().min(0).max(200).nullable(),
    appliesIfBreedNotPPP: z.boolean(),
  })
  .strict();

export const pppAttestationRequiredRegistriesSchema = z
  .object({
    registries: z
      .array(
        z
          .object({
            id: z.string().min(2).max(40),
            label: z.string().min(2).max(120),
            required: z.boolean(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();

const physicalCredentialProviderSchema = z
  .object({
    enabled: z.boolean(),
    providerName: z.string().min(1).max(120).optional(),
    providerUrl: z.string().url().max(300).optional(),
  })
  .strict()
  .refine((p) => !p.enabled || (p.providerName != null && p.providerUrl != null), {
    message: "Proveedor (nombre + URL) requerido cuando el canal está habilitado.",
  });

export const physicalCredentialChannelsSchema = z
  .object({
    printable_qr: z.boolean(),
    engraved_plate: physicalCredentialProviderSchema,
    nfc_tag: physicalCredentialProviderSchema,
  })
  .strict();

export const microchipRequiredSchema = z.object({ required: z.boolean() }).strict();

// ---------------------------------------------------------------------------
// Promoted rule types (design ADR-2/ADR-4, R4.1) — see
// lib/domain/business-rules-defaults.ts for the payload shapes + rationale.
// ---------------------------------------------------------------------------

export const rabiesObservationWindowSchema = z
  .object({ days: z.number().int().min(1).max(60) })
  .strict();

export const dueSoonWindowSchema = z.object({ days: z.number().int().min(1).max(365) }).strict();

// Config-theater fix (handoff 2026-07-03 #2): the per-vaccine `cadences`
// override was removed rather than wired. It was never read by any consumer
// (runVaccineDueScan's throttle is a hardcoded per-variant cadence, unrelated
// to this field) and had no write UI — the console form always round-tripped
// it as []. There is also no structured vaccineType concept on `reminders`
// (only a free-text `title`), so making it real would mean inventing a
// vaccine taxonomy + matching heuristic in a hot cron path — out of scope for
// a config-theater fix. Reintroduce alongside its consumer + console UI if a
// per-vaccine window becomes a real requirement.
export const reminderWindowsSchema = z
  .object({
    aheadDays: z.number().int().min(1).max(90),
  })
  .strict();

export const longStayDaysSchema = z.object({ days: z.number().int().min(1).max(365) }).strict();

// mpf_export_format (jurisdiction-compliance, 2026-07-22) — see
// lib/domain/business-rules-defaults.ts for why MPF_EXPORT_FORMATS has
// exactly one member today.
export const mpfExportFormatSchema = z.object({ format: z.enum(MPF_EXPORT_FORMATS) }).strict();

// ---------------------------------------------------------------------------
// Jurisdiction-aware compliance obligations (migration 0183) — thin payloads;
// the tier + legal provenance are table COLUMNS, not payload fields. See
// lib/domain/business-rules-defaults.ts for shapes + rationale.
// ---------------------------------------------------------------------------

export const rabiesVaccinationSchema = z
  .object({
    frequency_months: z.number().int().min(1).max(120).optional(),
    // The norm that fixes the cadence (D5, PO 2026-09-18) — see
    // RabiesVaccination.frequency_legal_basis. Read only together with
    // frequency_months: a citation with no cadence to cite changes nothing.
    frequency_legal_basis: z.string().trim().min(1).max(300).optional(),
    min_age_months: z.number().int().min(0).max(60).optional(),
  })
  .strict();

export const sterilizationSchema = z
  .object({
    min_age_months: z.number().int().min(0).max(60).optional(),
    mandatory_from_months: z.number().int().min(0).max(120).optional(),
  })
  .strict();

const targetPct = z.number().min(0).max(100).optional();

export const complianceTargetsSchema = z
  .object({
    rabies_coverage_pct: targetPct,
    microchip_penetration_pct: targetPct,
    sterilization_coverage_pct: targetPct,
    ppp_attestation_pct: targetPct,
  })
  .strict();

export const BUSINESS_RULE_VALIDATORS: Record<GovtBusinessRuleType, z.ZodSchema> = {
  ppp_breed_list: pppBreedListSchema,
  ppp_weight_threshold: pppWeightThresholdSchema,
  ppp_attestation_required_registries: pppAttestationRequiredRegistriesSchema,
  physical_credential_channels: physicalCredentialChannelsSchema,
  microchip_required: microchipRequiredSchema,
  rabies_observation_window: rabiesObservationWindowSchema,
  due_soon_window: dueSoonWindowSchema,
  reminder_windows: reminderWindowsSchema,
  long_stay_days: longStayDaysSchema,
  mpf_export_format: mpfExportFormatSchema,
  rabies_vaccination: rabiesVaccinationSchema,
  sterilization: sterilizationSchema,
  compliance_targets: complianceTargetsSchema,
};

export function validateRulePayload(
  ruleType: GovtBusinessRuleType,
  payload: unknown,
): { ok: true; data: unknown } | { ok: false; error: string } {
  const validator = BUSINESS_RULE_VALIDATORS[ruleType];
  const parsed = validator.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  return { ok: true, data: parsed.data };
}

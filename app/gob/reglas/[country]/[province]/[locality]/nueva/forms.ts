// Client form-component map (design ADR-2). A rule type is "available" in
// the console iff it has an entry here — this supersedes the old
// RULE_TYPES_NOT_YET_AVAILABLE set (a rule type not listed here is simply
// absent from the map, so callers do `ruleType in RULE_FORM_REGISTRY`
// instead of checking a separate exclusion list).
//
// Adding a rule type's form = one entry here. `nueva/page.tsx` and
// `editar/[ruleId]/page.tsx` render `RULE_FORM_REGISTRY[ruleType]` instead of
// an if-ladder.

import type { ComponentType } from "react";

import type { GovtBusinessRuleType } from "@/db";
import { BUSINESS_RULES_DEFAULTS } from "@/lib/domain/business-rules-defaults";

import { ComplianceTargetsForm } from "./ComplianceTargetsForm";
import { MicrochipRequiredForm } from "./MicrochipRequiredForm";
import { MpfExportFormatForm } from "./MpfExportFormatForm";
import {
  DueSoonWindowForm,
  LongStayDaysForm,
  RabiesObservationWindowForm,
  ReminderWindowsForm,
} from "./NumericWindowRuleForm";
import { RabiesVaccinationForm, SterilizationForm } from "./ObligationRuleForm";
import { PhysicalCredentialChannelsForm } from "./PhysicalCredentialChannelsForm";
import { PppAttestationRegistriesForm } from "./PppAttestationRegistriesForm";
import { PppBreedListForm } from "./PppBreedListForm";
import { PppWeightThresholdForm } from "./PppWeightThresholdForm";

export type RuleFormProps = {
  mode: "create" | "edit";
  ruleId?: string;
  country: string;
  province: string | null;
  locality: string | null;
  /**
   * Portal prefix the post-submit redirect must stay inside
   * (portal-follows-viewer, 2026-07-02) — round-tripped through the form
   * action's `redirectTo` via a hidden `portalBase` field.
   */
  base: "/admin" | "/gob";
  // biome-ignore lint/suspicious/noExplicitAny: each form has its own initialXxx prop shape (breeds vs kg vs registries); the map is consumed via a per-ruleType switch that narrows props at the call site.
  [key: string]: any;
};

// Each concrete form component declares its OWN (narrower, non-optional)
// initialXxx props — that's the whole point of per-type forms. The shared
// map type is intentionally loose (RuleFormProps has an index signature);
// buildCreateFormExtraProps/buildEditFormExtraProps below are the single
// place responsible for supplying the right shape per ruleType, so this cast
// is safe: page.tsx never renders a form with the wrong extra props.
export const RULE_FORM_REGISTRY: Partial<
  Record<GovtBusinessRuleType, ComponentType<RuleFormProps>>
> = {
  ppp_breed_list: PppBreedListForm as ComponentType<RuleFormProps>,
  ppp_weight_threshold: PppWeightThresholdForm as ComponentType<RuleFormProps>,
  ppp_attestation_required_registries: PppAttestationRegistriesForm as ComponentType<RuleFormProps>,
  physical_credential_channels: PhysicalCredentialChannelsForm as ComponentType<RuleFormProps>,
  microchip_required: MicrochipRequiredForm as ComponentType<RuleFormProps>,
  rabies_observation_window: RabiesObservationWindowForm as ComponentType<RuleFormProps>,
  due_soon_window: DueSoonWindowForm as ComponentType<RuleFormProps>,
  reminder_windows: ReminderWindowsForm as ComponentType<RuleFormProps>,
  long_stay_days: LongStayDaysForm as ComponentType<RuleFormProps>,
  mpf_export_format: MpfExportFormatForm as ComponentType<RuleFormProps>,
  // Jurisdiction-aware compliance obligations (migration 0183, WU1).
  rabies_vaccination: RabiesVaccinationForm as ComponentType<RuleFormProps>,
  sterilization: SterilizationForm as ComponentType<RuleFormProps>,
  // ADR-8 jurisdiction-aware targets (WU4b) — shipped alongside the
  // resolveJurisdictionTargets resolver that reads these rows.
  compliance_targets: ComplianceTargetsForm as ComponentType<RuleFormProps>,
};

/**
 * Per-rule-type "create" initial props (the defaults a brand-new rule starts
 * from). Kept alongside the component map so `nueva/page.tsx` stays a single
 * `RULE_FORM_REGISTRY[ruleType]` lookup instead of an if-ladder.
 */
export function buildCreateFormExtraProps(
  ruleType: GovtBusinessRuleType,
  defaultPayload: unknown,
): Record<string, unknown> {
  const payload = (defaultPayload ?? {}) as Record<string, unknown>;
  switch (ruleType) {
    case "ppp_breed_list":
      return {
        initialBreeds: Array.isArray(payload.breeds) ? payload.breeds : [],
        initialNotes: "",
      };
    case "ppp_weight_threshold":
      // NOTE: intentionally NOT the raw default (kg: null) — the create form
      // has always suggested 25kg as a starting point (pre-registry behavior
      // preserved verbatim; the *resolver* default is still null/no-op).
      return {
        initialKg: 25,
        initialAppliesIfBreedNotPPP: false,
        initialNotes: "",
      };
    case "ppp_attestation_required_registries":
      return {
        initialRegistries: Array.isArray(payload.registries) ? payload.registries : [],
        initialNotes: "",
      };
    case "physical_credential_channels":
      return {
        initialPrintableQr: Boolean(payload.printable_qr),
        initialEngravedPlate: payload.engraved_plate ?? { enabled: false },
        initialNfcTag: payload.nfc_tag ?? { enabled: false },
        initialNotes: "",
      };
    case "microchip_required":
      return {
        // Fall back to THE default, not a re-typed `true` (T6 review MINOR 4):
        // the create form's pre-selection must follow whatever
        // BUSINESS_RULES_DEFAULTS says, so RG2's parked flip cannot land with
        // this literal still pointing the other way.
        initialRequired:
          typeof payload.required === "boolean"
            ? payload.required
            : BUSINESS_RULES_DEFAULTS.microchip_required.required,
        initialNotes: "",
      };
    case "rabies_observation_window":
    case "due_soon_window":
    case "long_stay_days":
      return {
        initialValue: typeof payload.days === "number" ? payload.days : 0,
        initialNotes: "",
      };
    case "reminder_windows":
      return {
        initialValue: typeof payload.aheadDays === "number" ? payload.aheadDays : 0,
        initialNotes: "",
      };
    case "mpf_export_format":
      return {
        initialFormat:
          typeof payload.format === "string"
            ? payload.format
            : BUSINESS_RULES_DEFAULTS.mpf_export_format.format,
        initialNotes: "",
      };
    case "rabies_vaccination":
    case "sterilization":
    case "compliance_targets":
      // These forms read their optional numeric fields off the payload record
      // directly — the defaults are {} (honest-by-default, see
      // business-rules-defaults.ts).
      return { initialPayload: payload, initialNotes: "" };
    default:
      return { initialNotes: "" };
  }
}

/** Per-rule-type "edit" initial props, read off an existing row's payload. */
export function buildEditFormExtraProps(
  ruleType: GovtBusinessRuleType,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  switch (ruleType) {
    case "ppp_breed_list":
      return { initialBreeds: Array.isArray(payload.breeds) ? (payload.breeds as string[]) : [] };
    case "ppp_weight_threshold":
      return {
        initialKg: typeof payload.kg === "number" ? payload.kg : null,
        initialAppliesIfBreedNotPPP: Boolean(payload.appliesIfBreedNotPPP),
      };
    case "ppp_attestation_required_registries":
      return {
        initialRegistries: Array.isArray(payload.registries)
          ? (payload.registries as { id: string; label: string; required: boolean }[])
          : [],
      };
    case "physical_credential_channels":
      return {
        initialPrintableQr: Boolean(payload.printable_qr),
        initialEngravedPlate: payload.engraved_plate ?? { enabled: false },
        initialNfcTag: payload.nfc_tag ?? { enabled: false },
      };
    case "microchip_required":
      return {
        initialRequired:
          typeof payload.required === "boolean"
            ? payload.required
            : BUSINESS_RULES_DEFAULTS.microchip_required.required,
      };
    case "rabies_observation_window":
    case "due_soon_window":
    case "long_stay_days":
      return { initialValue: typeof payload.days === "number" ? payload.days : 0 };
    case "reminder_windows":
      return {
        initialValue: typeof payload.aheadDays === "number" ? payload.aheadDays : 0,
      };
    case "mpf_export_format":
      return {
        initialFormat:
          typeof payload.format === "string"
            ? payload.format
            : BUSINESS_RULES_DEFAULTS.mpf_export_format.format,
      };
    case "rabies_vaccination":
    case "sterilization":
    case "compliance_targets":
      return { initialPayload: payload };
    default:
      return {};
  }
}

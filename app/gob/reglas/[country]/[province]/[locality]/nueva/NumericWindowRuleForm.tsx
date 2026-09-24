"use client";

// NumericWindowRuleForm — generic single-integer-field form shared by the 4
// "promoted" rule types (design ADR-2/ADR-4, R4.5/R4.6): rabies_observation_
// window, due_soon_window, reminder_windows (aheadDays), long_stay_days.
// They all share the exact same shape (one bounded integer + notes), so one
// parameterized component covers all 4 instead of 4 near-identical files.
//
// No impact-preview gate wired here — per decision #651 (spec R4.5 amended),
// the count-based impact-preview gate (RuleImpactBanner + rule-impact-gate)
// is required only for rule types that mutate/reclassify records
// (ppp_breed_list, ppp_weight_threshold). These 4 rule types only change
// notification timing / badge derivation, not record legal status, so they
// render explicit warning copy instead of a blocking count gate — see the
// LnAlert below.

import { useActionState, useEffect, useState } from "react";

import {
  type BusinessRuleFormState,
  createBusinessRuleAction,
  updateBusinessRuleAction,
} from "@/app/actions/business-rules";
import { LnAlert } from "@/components/ui/Alert";
import { LnField, LnInput, LnTextarea } from "@/components/ui/Field";
import { OpButton } from "@/components/ui/dashboard";
import type { GovtBusinessRuleType } from "@/db";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";
import { useKeptFields } from "@/lib/ui/use-kept-fields";

import { LegalMetadataFieldset, type LegalMetadataInitial } from "./LegalMetadataFieldset";

const initialState: BusinessRuleFormState = { error: null };

type Props = {
  mode: "create" | "edit";
  ruleId?: string;
  country: string;
  province: string | null;
  locality: string | null;
  base: "/admin" | "/gob";
  ruleType: GovtBusinessRuleType;
  /** Form field name — "days" for the 3 day-count types, "aheadDays" for reminder_windows. */
  fieldName: "days" | "aheadDays";
  fieldLabel: string;
  helperText: string;
  min: number;
  max: number;
  initialValue: number;
  initialNotes: string;
  initialLegalMetadata?: LegalMetadataInitial;
};

export function NumericWindowRuleForm({
  mode,
  ruleId,
  country,
  province,
  locality,
  base,
  ruleType,
  fieldName,
  fieldLabel,
  helperText,
  min,
  max,
  initialValue,
  initialNotes,
  initialLegalMetadata,
}: Props) {
  const action =
    mode === "edit" && ruleId
      ? updateBusinessRuleAction.bind(null, ruleId)
      : createBusinessRuleAction;
  // forms/react19-reset-data-loss-inventory: `notes` had a STATIC
  // defaultValue={initialNotes} — a rejected submit put back the row's
  // ORIGINAL notes, discarding what the operator had just typed. The numeric
  // field itself is already controlled (value+onChange) and survives on its
  // own.
  const { boundAction, kept } = useKeptFields<BusinessRuleFormState>(action);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);
  const [value, setValue] = useState(String(initialValue));

  // Router-drop workaround (verify-report #650 WARNING-1) — the action no
  // longer calls redirect() on success; do a full document navigation here
  // instead of relying on the framework's own post-action transition (see
  // lib/ui/full-page-action-nav.ts's module docblock for the full mechanism).
  useEffect(() => {
    if (state.redirectTo) navigateAfterActionSuccess(state.redirectTo);
  }, [state.redirectTo]);

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="ruleType" value={ruleType} />
      <input type="hidden" name="jurisdictionCountry" value={country} />
      <input type="hidden" name="jurisdictionProvince" value={province ?? ""} />
      <input type="hidden" name="jurisdictionLocality" value={locality ?? ""} />
      <input type="hidden" name="portalBase" value={base} />

      <p className="text-md text-ln-op-ink-2">{helperText}</p>

      <LnField label={fieldLabel}>
        {({ id, describedBy, invalid }) => (
          <LnInput
            id={id}
            name={fieldName}
            type="number"
            min={min}
            max={max}
            step={1}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-describedby={describedBy}
            invalid={invalid}
          />
        )}
      </LnField>

      <LegalMetadataFieldset initial={initialLegalMetadata} />

      <LnField label="Notas internas">
        {({ id, describedBy, invalid }) => (
          <LnTextarea
            id={id}
            name="notes"
            defaultValue={kept("notes", initialNotes)}
            rows={3}
            aria-describedby={describedBy}
            invalid={invalid}
          />
        )}
      </LnField>

      {/* No count-based impact-preview gate for this rule type (decision #651
          — only record-mutating types like ppp_breed_list/ppp_weight_threshold
          get that gate). Explicit warning copy instead, no acknowledgement
          checkbox: this change is not blocking. */}
      <LnAlert variant="warning">
        Este cambio aplica inmediatamente a toda la jurisdicción seleccionada.
      </LnAlert>

      {state.warning && <p className="text-md text-ln-op-warn">{state.warning}</p>}
      {state.error && (
        <p className="text-md text-ln-op-danger" role="alert">
          {state.error}
        </p>
      )}

      <OpButton type="submit" disabled={isPending} loading={isPending} variant="primary" block>
        {isPending ? "Guardando..." : mode === "create" ? "Crear regla" : "Guardar cambios"}
      </OpButton>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Thin per-rule-type wrappers — pre-bind the fixed config (ruleType, field
// name, labels, bounds) so RULE_FORM_REGISTRY can register a plain
// ComponentType<RuleFormProps> per type without threading that config
// through the extra-props builders.
// ---------------------------------------------------------------------------

type WrapperProps = {
  mode: "create" | "edit";
  ruleId?: string;
  country: string;
  province: string | null;
  locality: string | null;
  base: "/admin" | "/gob";
  initialValue: number;
  initialNotes: string;
  initialLegalMetadata?: LegalMetadataInitial;
};

export function RabiesObservationWindowForm(props: WrapperProps) {
  return (
    <NumericWindowRuleForm
      {...props}
      ruleType="rabies_observation_window"
      fieldName="days"
      fieldLabel="Días de observación"
      helperText="Días de observación clínica exigidos tras una mordedura, antes de descartar rabia (1-60)."
      min={1}
      max={60}
    />
  );
}

export function DueSoonWindowForm(props: WrapperProps) {
  return (
    <NumericWindowRuleForm
      {...props}
      ruleType="due_soon_window"
      fieldName="days"
      fieldLabel="Días de anticipación"
      helperText="Con cuántos días de anticipación una vacuna se marca 'próxima a vencer' (1-365)."
      min={1}
      max={365}
    />
  );
}

export function ReminderWindowsForm(props: WrapperProps) {
  return (
    <NumericWindowRuleForm
      {...props}
      ruleType="reminder_windows"
      fieldName="aheadDays"
      fieldLabel="Días de anticipación del recordatorio"
      helperText="Con cuántos días de anticipación se generan los recordatorios de vacunación (1-90). Sweep global, no jurisdiccional (resuelve a nivel país)."
      min={1}
      max={90}
    />
  );
}

export function LongStayDaysForm(props: WrapperProps) {
  return (
    <NumericWindowRuleForm
      {...props}
      ruleType="long_stay_days"
      fieldName="days"
      fieldLabel="Días de estadía"
      helperText="Días de estadía en refugio a partir de los cuales se marca 'estadía larga' (1-365)."
      min={1}
      max={365}
    />
  );
}

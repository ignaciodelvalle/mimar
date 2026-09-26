"use client";

// ObligationRuleForm — shared form for the two per-pet obligation rule types
// added by migration 0183 (jurisdiction-compliance WU1, spec OR1/OR2):
// rabies_vaccination and sterilization. Both share the same shape — a
// requirement tier + legal provenance (table COLUMNS via the shared
// LegalMetadataFieldset) plus a couple of OPTIONAL numeric payload
// parameters — so one parameterized component covers both, following the
// NumericWindowRuleForm precedent.
//
// No impact-preview gate (decision #651): these rule types change
// compliance-panel derivation, not record legal status — explicit warning
// copy instead of a blocking count gate.

import { useActionState, useEffect, useState } from "react";

import {
  type BusinessRuleFormState,
  createBusinessRuleAction,
  updateBusinessRuleAction,
} from "@/app/actions/business-rules";
import { LnAlert } from "@/components/ui/Alert";
import { LnField, LnInput, LnTextarea } from "@/components/ui/Field";
import { OpButton } from "@/components/ui/dashboard";
import type { RequirementLevel } from "@/db";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";
import { useKeptFields } from "@/lib/ui/use-kept-fields";

import { LegalMetadataFieldset, type LegalMetadataInitial } from "./LegalMetadataFieldset";
import { RulePlaceField } from "./RulePlaceField";

const initialState: BusinessRuleFormState = { error: null };

type NumericFieldConfig = {
  /** Payload field name — matches the registry's parseFromForm reads. */
  name: string;
  label: string;
  min: number;
  max: number;
};

type TextFieldConfig = {
  /** Payload field name — matches the registry's parseFromForm reads. */
  name: string;
  label: string;
  hint: string;
  maxLength: number;
};

type Props = {
  mode: "create" | "edit";
  ruleId?: string;
  country: string;
  province: string | null;
  locality: string | null;
  base: "/admin" | "/gob";
  ruleType: "rabies_vaccination" | "sterilization";
  helperText: string;
  fields: NumericFieldConfig[];
  /** Optional free-text payload parameters, rendered after the numeric ones. */
  textFields?: TextFieldConfig[];
  /** Existing row payload (edit) or the default payload (create). */
  initialPayload: Record<string, unknown>;
  initialNotes: string;
  initialLegalMetadata?: LegalMetadataInitial;
};

export function ObligationRuleForm({
  mode,
  ruleId,
  country,
  province,
  locality,
  base,
  ruleType,
  helperText,
  fields,
  textFields = [],
  initialPayload,
  initialNotes,
  initialLegalMetadata,
}: Props) {
  const action =
    mode === "edit" && ruleId
      ? updateBusinessRuleAction.bind(null, ruleId)
      : createBusinessRuleAction;
  // forms/react19-reset-data-loss-inventory: every numeric/text payload
  // field and `notes` had a STATIC defaultValue derived from
  // `initialPayload`/`initialNotes` — a rejected submit put back the row's
  // ORIGINAL values, discarding whatever the operator had just typed.
  const { boundAction, kept } = useKeptFields<BusinessRuleFormState>(action);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);
  // "" = tier not established: an honest starting point — creating a row
  // with only payload parameters claims nothing about the jurisdiction's law.
  const [level, setLevel] = useState<RequirementLevel | "">(
    initialLegalMetadata?.requirementLevel ?? "",
  );

  // Router-drop workaround (verify-report #650 WARNING-1) — see
  // lib/ui/full-page-action-nav.ts's module docblock.
  useEffect(() => {
    if (state.redirectTo) navigateAfterActionSuccess(state.redirectTo);
  }, [state.redirectTo]);

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="ruleType" value={ruleType} />
      <input type="hidden" name="jurisdictionCountry" value={country} />
      <input type="hidden" name="jurisdictionProvince" value={province ?? ""} />
      <input type="hidden" name="jurisdictionLocality" value={locality ?? ""} />
      <RulePlaceField />
      <input type="hidden" name="portalBase" value={base} />

      <p className="text-md text-ln-op-ink-2">{helperText}</p>

      <LegalMetadataFieldset
        initial={initialLegalMetadata}
        requirementLevel={{ value: level, onChange: setLevel, allowUnset: true }}
      />

      {fields.map((field) => {
        const initialValue = initialPayload[field.name];
        const initialDefault = typeof initialValue === "number" ? String(initialValue) : "";
        return (
          <LnField key={field.name} label={field.label}>
            {({ id, describedBy, invalid }) => (
              <LnInput
                id={id}
                name={field.name}
                type="number"
                min={field.min}
                max={field.max}
                step={1}
                defaultValue={kept(field.name, initialDefault)}
                aria-describedby={describedBy}
                invalid={invalid}
              />
            )}
          </LnField>
        );
      })}

      {textFields.map((field) => {
        const initialValue = initialPayload[field.name];
        const initialDefault = typeof initialValue === "string" ? initialValue : "";
        return (
          <LnField key={field.name} label={field.label} hint={field.hint}>
            {({ id, describedBy, invalid }) => (
              <LnInput
                id={id}
                name={field.name}
                type="text"
                maxLength={field.maxLength}
                defaultValue={kept(field.name, initialDefault)}
                aria-describedby={describedBy}
                invalid={invalid}
              />
            )}
          </LnField>
        );
      })}

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

      <LnAlert variant="warning">
        Este cambio aplica inmediatamente a toda la jurisdicción seleccionada — afecta el panel de
        cumplimiento de cada mascota registrada ahí.
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
// Thin per-rule-type wrappers — pre-bind the fixed config so
// RULE_FORM_REGISTRY can register a plain ComponentType<RuleFormProps> per
// type (NumericWindowRuleForm precedent). Bounds mirror the Zod validators in
// lib/infra/business-rules-validators.ts.
// ---------------------------------------------------------------------------

type WrapperProps = {
  mode: "create" | "edit";
  ruleId?: string;
  country: string;
  province: string | null;
  locality: string | null;
  base: "/admin" | "/gob";
  initialPayload: Record<string, unknown>;
  initialNotes: string;
  initialLegalMetadata?: LegalMetadataInitial;
};

export function RabiesVaccinationForm(props: WrapperProps) {
  return (
    <ObligationRuleForm
      {...props}
      ruleType="rabies_vaccination"
      helperText="Qué exige esta jurisdicción sobre la vacunación antirrábica. Los parámetros numéricos son opcionales: dejá vacío lo que la norma no fija."
      fields={[
        { name: "frequency_months", label: "Frecuencia de refuerzo (meses)", min: 1, max: 120 },
        { name: "min_age_months", label: "Edad mínima (meses)", min: 0, max: 60 },
      ]}
      textFields={[
        {
          name: "frequency_legal_basis",
          label: "Norma que fija la frecuencia de refuerzo",
          hint: "Completalo solo si una norma fija ese intervalo. Con norma, la fecha calculada cuenta como vencimiento legal; sin norma, se muestra como refuerzo sugerido.",
          maxLength: 300,
        },
      ]}
    />
  );
}

export function SterilizationForm(props: WrapperProps) {
  return (
    <ObligationRuleForm
      {...props}
      ruleType="sterilization"
      helperText="Qué exige esta jurisdicción sobre la esterilización. Los parámetros numéricos son opcionales: dejá vacío lo que la norma no fija."
      fields={[
        { name: "min_age_months", label: "Edad mínima permitida (meses)", min: 0, max: 60 },
        {
          name: "mandatory_from_months",
          label: "Edad desde la que aplica la obligación (meses)",
          min: 0,
          max: 120,
        },
      ]}
    />
  );
}

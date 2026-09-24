"use client";

// ComplianceTargetsForm — console editor for the `compliance_targets` rule
// type (jurisdiction-compliance WU4b, ADR-8 — deferred from WU1/T1.8 to ship
// alongside the resolver that reads it, resolveJurisdictionTargets).
//
// Four OPTIONAL percentage fields, one per legally-varying TARGETS key (JT1
// whitelist): an empty field means "no local override — the flat national
// default governs" (the registry's parseOptionalPctField omits it from the
// payload). Values are clamped 0..100 at read time by the resolver; the Zod
// validator bounds them at write time too.
//
// LegalMetadataFieldset rides along (RM5 — mounted on ALL rule forms) so the
// override can cite the norm that sets the local meta. The requirement tier
// is offered with allowUnset — a metric target is not an obligation, so most
// rows will honestly leave it unset.

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

const initialState: BusinessRuleFormState = { error: null };

/** Payload field name + es-AR label per JT1 target key. */
const PCT_FIELDS: Array<{ name: string; label: string }> = [
  { name: "rabies_coverage_pct", label: "Meta cobertura antirrábica (%)" },
  { name: "microchip_penetration_pct", label: "Meta penetración de microchip (%)" },
  { name: "sterilization_coverage_pct", label: "Meta cobertura de esterilización (%)" },
  { name: "ppp_attestation_pct", label: "Meta atestación PPP (%)" },
];

type Props = {
  mode: "create" | "edit";
  ruleId?: string;
  country: string;
  province: string | null;
  locality: string | null;
  base: "/admin" | "/gob";
  /** Existing row payload (edit) or the default payload (create). */
  initialPayload: Record<string, unknown>;
  initialNotes: string;
  initialLegalMetadata?: LegalMetadataInitial;
};

export function ComplianceTargetsForm({
  mode,
  ruleId,
  country,
  province,
  locality,
  base,
  initialPayload,
  initialNotes,
  initialLegalMetadata,
}: Props) {
  const action =
    mode === "edit" && ruleId
      ? updateBusinessRuleAction.bind(null, ruleId)
      : createBusinessRuleAction;
  // forms/react19-reset-data-loss-inventory: every PCT_FIELDS input and
  // `notes` had a STATIC defaultValue derived from `initialPayload`/
  // `initialNotes` — a rejected submit put back the row's ORIGINAL values,
  // discarding whatever the operator had just typed.
  const { boundAction, kept } = useKeptFields<BusinessRuleFormState>(action);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);
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
      <input type="hidden" name="ruleType" value="compliance_targets" />
      <input type="hidden" name="jurisdictionCountry" value={country} />
      <input type="hidden" name="jurisdictionProvince" value={province ?? ""} />
      <input type="hidden" name="jurisdictionLocality" value={locality ?? ""} />
      <input type="hidden" name="portalBase" value={base} />

      <p className="text-md text-ln-op-ink-2">
        Metas locales para los indicadores que la normativa jurisdiccional ajusta. Dejá vacío lo que
        no tenga meta propia: ahí rige el default nacional.
      </p>

      <LegalMetadataFieldset
        initial={initialLegalMetadata}
        requirementLevel={{ value: level, onChange: setLevel, allowUnset: true }}
      />

      {PCT_FIELDS.map((field) => {
        const initialValue = initialPayload[field.name];
        const initialDefault = typeof initialValue === "number" ? String(initialValue) : "";
        return (
          <LnField key={field.name} label={field.label}>
            {({ id, describedBy, invalid }) => (
              <LnInput
                id={id}
                name={field.name}
                type="number"
                min={0}
                max={100}
                step={0.1}
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
        Este cambio ajusta las metas de los tableros de gobierno de la jurisdicción seleccionada.
        Cada tile que use una meta ajustada lo va a divulgar junto al valor.
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

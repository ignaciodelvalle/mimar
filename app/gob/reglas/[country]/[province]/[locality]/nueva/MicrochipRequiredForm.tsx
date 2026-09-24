"use client";

// MicrochipRequiredForm — admin/govt form for the microchip_required rule
// type (E5, 2026-07-21 facades harvest). Migration 0150 widened the
// govt_business_rules CHECK constraint and the domain layer (validator,
// default, RULE_TYPE_REGISTRY entry) already shipped — only this write-side
// form was missing, so the govt read lens (owner compliance panel via
// resolveBusinessRule) could show the resolved value but no jurisdiction
// could ever override the default: true. Follows the PhysicalCredentialChannelsForm
// template — no impact-preview gate (decision #651): this rule changes
// notification/compliance-panel derivation, not record legal status.
//
// Migration 0183 (jurisdiction-compliance WU1, spec OR5): the old boolean
// checkbox became a requirement-tier select. The form writes BOTH the
// requirement_level column AND the hidden payload.required boolean — the
// select drives the boolean (required = tier === "mandatory") — so readers
// that still gate on payload.required never skew against the tier.

import { useActionState, useEffect, useState } from "react";

import {
  type BusinessRuleFormState,
  createBusinessRuleAction,
  updateBusinessRuleAction,
} from "@/app/actions/business-rules";
import { LnAlert } from "@/components/ui/Alert";
import { LnField, LnTextarea } from "@/components/ui/Field";
import { OpButton } from "@/components/ui/dashboard";
import type { RequirementLevel } from "@/db";
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
  initialRequired: boolean;
  initialNotes: string;
  initialLegalMetadata?: LegalMetadataInitial;
};

export function MicrochipRequiredForm({
  mode,
  ruleId,
  country,
  province,
  locality,
  base,
  initialRequired,
  initialNotes,
  initialLegalMetadata,
}: Props) {
  const action =
    mode === "edit" && ruleId
      ? updateBusinessRuleAction.bind(null, ruleId)
      : createBusinessRuleAction;
  // forms/react19-reset-data-loss-inventory: `notes` had a STATIC
  // defaultValue={initialNotes} — a rejected submit (a duplicate rule, a
  // validation error) put back the row's ORIGINAL notes, discarding what the
  // operator had just typed.
  const { boundAction, kept } = useKeptFields<BusinessRuleFormState>(action);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);
  // Rows created before 0183 have no tier — derive the initial selection from
  // the boolean exactly as the migration's backfill does (required=true →
  // mandatory, false → not_regulated). No "Sin definir" option here: the
  // hidden boolean below needs a well-defined tier to derive from.
  const [level, setLevel] = useState<RequirementLevel>(
    initialLegalMetadata?.requirementLevel ?? (initialRequired ? "mandatory" : "not_regulated"),
  );

  // Router-drop workaround (verify-report #650 WARNING-1) — see
  // lib/ui/full-page-action-nav.ts's module docblock.
  useEffect(() => {
    if (state.redirectTo) navigateAfterActionSuccess(state.redirectTo);
  }, [state.redirectTo]);

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="ruleType" value="microchip_required" />
      <input type="hidden" name="jurisdictionCountry" value={country} />
      <input type="hidden" name="jurisdictionProvince" value={province ?? ""} />
      <input type="hidden" name="jurisdictionLocality" value={locality ?? ""} />
      <input type="hidden" name="portalBase" value={base} />

      <p className="text-md text-ln-op-ink-2">
        Si esta jurisdicción exige la identificación por microchip. Sin una regla explícita no se
        asume ninguna obligación — esta regla permite que una jurisdicción declare la exigencia (o
        la descarte) con su respaldo legal.
      </p>

      {/* Write-both contract (spec OR5): the tier select drives this hidden
          boolean so pre-tier readers (payload.required) never disagree with
          the requirement_level column. */}
      <input type="hidden" name="required" value={level === "mandatory" ? "on" : "off"} />

      <LegalMetadataFieldset
        initial={initialLegalMetadata}
        requirementLevel={{
          value: level,
          onChange: (next) => {
            if (next !== "") setLevel(next);
          },
        }}
      />

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
        cumplimiento ("N de M al día") de cada mascota registrada ahí.
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

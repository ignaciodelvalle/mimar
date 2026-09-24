"use client";

// MpfExportFormatForm — admin/govt form for the mpf_export_format rule type
// (jurisdiction-compliance, 2026-07-22 "MPF export format cascade"). Follows
// the MicrochipRequiredForm template — no impact-preview gate (same rationale
// as decision #651): this rule changes export METADATA (which PDF format the
// fiscalía export uses), not record legal status, so there is no per-pet
// blast radius to preview.
//
// This is the write side of the change that also removed the CABA-only MPF
// export gate (lib/domain/mpf-jurisdiction.ts, deleted): every jurisdiction
// can now generate the fiscal export; this rule decides WHICH format they
// get, cascading locality > province > country > national default like every
// other govt_business_rules type.
//
// Only one format exists in the codebase today ("estandar_nacional" — see
// lib/domain/business-rules-defaults.ts's MPF_EXPORT_FORMATS docblock), so
// the select has exactly one option. Saving the only legal value is a no-op
// at the writer layer (createBusinessRuleWriter's default-equality check) —
// this form exists so the cascade's WRITE surface is real ahead of any
// second format's rollout, not because there is something meaningful to
// override yet.

import { useActionState, useEffect, useState } from "react";

import {
  type BusinessRuleFormState,
  createBusinessRuleAction,
  updateBusinessRuleAction,
} from "@/app/actions/business-rules";
import { LnAlert } from "@/components/ui/Alert";
import { LnField, LnSelect, LnTextarea } from "@/components/ui/Field";
import { OpButton } from "@/components/ui/dashboard";
import { MPF_EXPORT_FORMATS, type MpfExportFormatId } from "@/lib/domain/business-rules-defaults";
import { MPF_EXPORT_FORMAT_LABELS } from "@/lib/domain/rule-types-registry";
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
  initialFormat: MpfExportFormatId;
  initialNotes: string;
  initialLegalMetadata?: LegalMetadataInitial;
};

export function MpfExportFormatForm({
  mode,
  ruleId,
  country,
  province,
  locality,
  base,
  initialFormat,
  initialNotes,
  initialLegalMetadata,
}: Props) {
  const action =
    mode === "edit" && ruleId
      ? updateBusinessRuleAction.bind(null, ruleId)
      : createBusinessRuleAction;
  // forms/react19-reset-data-loss-inventory: `format` was a genuinely
  // controlled select (value+onChange) — never safe from the post-action
  // reset regardless (react-dom's UPDATE path never rewrites
  // `defaultSelected`, only MOUNT does). `notes` had a STATIC defaultValue.
  const { boundAction, kept } = useKeptFields<BusinessRuleFormState>(action);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);
  const [format, setFormat] = useState<MpfExportFormatId>(initialFormat);

  // Router-drop workaround (verify-report #650 WARNING-1) — see
  // lib/ui/full-page-action-nav.ts's module docblock.
  useEffect(() => {
    if (state.redirectTo) navigateAfterActionSuccess(state.redirectTo);
  }, [state.redirectTo]);

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="ruleType" value="mpf_export_format" />
      <input type="hidden" name="jurisdictionCountry" value={country} />
      <input type="hidden" name="jurisdictionProvince" value={province ?? ""} />
      <input type="hidden" name="jurisdictionLocality" value={locality ?? ""} />
      <input type="hidden" name="portalBase" value={base} />

      <p className="text-md text-ln-op-ink-2">
        Qué formato usa el PDF de denuncia formal a la fiscalía (MPF) para esta jurisdicción.
        Cascada localidad → provincia → país → default nacional, igual que el resto de las reglas.
      </p>

      <LnField label="Formato del export">
        {({ id, describedBy, invalid }) => (
          <LnSelect
            key={`format-${kept("format")}`}
            id={id}
            name="format"
            defaultValue={kept("format", format)}
            onChange={(e) => setFormat(e.target.value as MpfExportFormatId)}
            aria-describedby={describedBy}
            invalid={invalid}
          >
            {MPF_EXPORT_FORMATS.map((f) => (
              <option key={f} value={f}>
                {MPF_EXPORT_FORMAT_LABELS[f]}
              </option>
            ))}
          </LnSelect>
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

      <LnAlert variant="warning">
        Hoy existe un único formato en el sistema — guardar esta regla con el valor por defecto no
        tiene efecto (el resolver ya devuelve ese valor). Esta regla queda lista para cuando exista
        una segunda variante de formato.
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

"use client";

import { useActionState, useEffect, useMemo, useState } from "react";

import {
  type BusinessRuleFormState,
  createBusinessRuleAction,
  updateBusinessRuleAction,
} from "@/app/actions/business-rules";
import type { RuleImpactPreviewInput } from "@/app/actions/rule-impact-preview";
import { RuleImpactBanner, type RuleImpactResult } from "@/components/admin/RuleImpactBanner";
import { LnCheckbox, LnField, LnInput, LnTextarea } from "@/components/ui/Field";
import { OpButton } from "@/components/ui/dashboard";
import { canSaveWithImpactGate, requiresImpactConfirmation } from "@/lib/domain/rule-impact-gate";
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
  initialKg: number | null;
  initialAppliesIfBreedNotPPP: boolean;
  initialNotes: string;
  initialLegalMetadata?: LegalMetadataInitial;
};

export function PppWeightThresholdForm({
  mode,
  ruleId,
  country,
  province,
  locality,
  base,
  initialKg,
  initialAppliesIfBreedNotPPP,
  initialNotes,
  initialLegalMetadata,
}: Props) {
  const action =
    mode === "edit" && ruleId
      ? updateBusinessRuleAction.bind(null, ruleId)
      : createBusinessRuleAction;
  // forms/react19-reset-data-loss-inventory: `appliesIfBreedNotPPP` was
  // controlled with checked=/onChange= — the exact pair the
  // react19-form-reset-contract measures as vulnerable regardless. `notes`
  // had a STATIC defaultValue. `kg` is already controlled and survives on
  // its own.
  const { boundAction, kept, keptChecked } = useKeptFields<BusinessRuleFormState>(action);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);

  // Router-drop workaround (verify-report #650 WARNING-1) — see
  // lib/ui/full-page-action-nav.ts's module docblock.
  useEffect(() => {
    if (state.redirectTo) navigateAfterActionSuccess(state.redirectTo);
  }, [state.redirectTo]);

  // Controlled state for the two fields that drive the impact preview.
  const [kgRaw, setKgRaw] = useState<string>(initialKg !== null ? String(initialKg) : "");
  const [appliesIfBreedNotPPP, setAppliesIfBreedNotPPP] = useState(initialAppliesIfBreedNotPPP);

  // C9 impact gate (parity with PppBreedListForm) — thread the banner's
  // computed count up so the save can gate on acknowledgement.
  const [impact, setImpact] = useState<RuleImpactResult>({ status: "idle", count: null });
  const [acknowledged, setAcknowledged] = useState(false);

  // Build preview input — recomputed when kg or appliesIfBreedNotPPP changes.
  const previewInput = useMemo<RuleImpactPreviewInput | null>(() => {
    const parsed = kgRaw !== "" ? Number.parseFloat(kgRaw) : null;
    const kg = parsed !== null && !Number.isNaN(parsed) && parsed >= 0 ? parsed : null;
    // Only preview when there's a valid kg and the threshold applies broadly.
    if (kg === null || !appliesIfBreedNotPPP) return null;
    return {
      ruleType: "ppp_weight_threshold",
      kg,
      appliesIfBreedNotPPP,
      country,
      province,
      locality,
    };
  }, [kgRaw, appliesIfBreedNotPPP, country, province, locality]);

  const gateState = { status: impact.status, count: impact.count, acknowledged };
  const mustConfirm = requiresImpactConfirmation(gateState);
  const canSave = canSaveWithImpactGate(gateState);

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="ruleType" value="ppp_weight_threshold" />
      <input type="hidden" name="jurisdictionCountry" value={country} />
      <input type="hidden" name="jurisdictionProvince" value={province ?? ""} />
      <input type="hidden" name="jurisdictionLocality" value={locality ?? ""} />
      <input type="hidden" name="portalBase" value={base} />

      {/* es-AR, con tildes y voseo — como el resto del producto. Este párrafo
          decía "por tamano" (sin ñ), "Deja" (tuteo) y "vacio". Lo lee un
          funcionario antes de fijar una regla que define qué animal es PPP en
          su jurisdicción. */}
      <p className="text-md text-ln-op-ink-2">
        Define un umbral de peso por sobre el cual el animal se considera PPP por tamaño. Dejá los
        kg vacíos para no aplicar umbral (sólo la regla de razas).
      </p>

      <LnField label="Peso mínimo (kg)">
        {({ id, describedBy, invalid }) => (
          <LnInput
            id={id}
            name="kg"
            type="number"
            min={0}
            max={200}
            step="0.1"
            value={kgRaw}
            onChange={(e) => setKgRaw(e.target.value)}
            aria-describedby={describedBy}
            invalid={invalid}
          />
        )}
      </LnField>

      <LnCheckbox
        name="appliesIfBreedNotPPP"
        defaultChecked={keptChecked("appliesIfBreedNotPPP", appliesIfBreedNotPPP)}
        onChange={(e) => setAppliesIfBreedNotPPP(e.target.checked)}
      >
        Aplicar el umbral incluso a razas NO listadas en{" "}
        <span className="font-ln-mono text-sm">ppp_breed_list</span>. Si está desactivado, el umbral
        sólo agrega una segunda condición a las razas ya consideradas PPP.
      </LnCheckbox>

      {/* Impact preview — shown before submission. C9: thread the result up
          so the save can gate on acknowledgement. A new count invalidates
          any prior acknowledgement so the operator re-confirms. */}
      <RuleImpactBanner
        input={previewInput}
        onResult={(result) => {
          setImpact(result);
          setAcknowledged(false);
        }}
      />

      {/* C9: confirmation gate — required only when the rule would affect pets. */}
      {mustConfirm && impact.status === "done" && impact.count !== null && impact.count > 0 && (
        <LnCheckbox
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
          labelClassName="text-xs! text-ln-op-warn!"
        >
          Confirmo que entiendo que guardar esta regla reevaluará y notificará a{" "}
          {impact.count.toLocaleString("es-AR")} {impact.count === 1 ? "dueño" : "dueños"} de las
          mascotas afectadas.
        </LnCheckbox>
      )}

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

      {state.warning && <p className="text-md text-ln-op-warn">{state.warning}</p>}
      {state.error && (
        <p className="text-md text-ln-op-danger" role="alert">
          {state.error}
        </p>
      )}

      <OpButton
        type="submit"
        disabled={isPending || !canSave}
        loading={isPending}
        variant="primary"
        block
      >
        {isPending ? "Guardando..." : mode === "create" ? "Crear regla" : "Guardar cambios"}
      </OpButton>
    </form>
  );
}

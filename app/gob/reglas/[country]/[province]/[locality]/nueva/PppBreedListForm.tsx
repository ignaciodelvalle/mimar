"use client";

import { useActionState, useEffect, useMemo, useState } from "react";

import {
  type BusinessRuleFormState,
  createBusinessRuleAction,
  updateBusinessRuleAction,
} from "@/app/actions/business-rules";
import type { RuleImpactPreviewInput } from "@/app/actions/rule-impact-preview";
import { RuleImpactBanner, type RuleImpactResult } from "@/components/admin/RuleImpactBanner";
import { LnCheckbox } from "@/components/ui/Field";
import { LnField, LnInput, LnTextarea } from "@/components/ui/Field";
import { OpButton } from "@/components/ui/dashboard";
import { canSaveWithImpactGate, requiresImpactConfirmation } from "@/lib/domain/rule-impact-gate";
import { DOG_BREEDS, POTENTIALLY_DANGEROUS_DOG_BREEDS } from "@/lib/reference/breeds";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";
import { useKeptFields } from "@/lib/ui/use-kept-fields";

import { LegalMetadataFieldset, type LegalMetadataInitial } from "./LegalMetadataFieldset";

const initialState: BusinessRuleFormState = { error: null };

const DEFAULT_BREEDS_SET = new Set([...POTENTIALLY_DANGEROUS_DOG_BREEDS]);

type Props = {
  mode: "create" | "edit";
  ruleId?: string;
  country: string;
  province: string | null;
  locality: string | null;
  base: "/admin" | "/gob";
  initialBreeds: string[];
  initialNotes: string;
  initialLegalMetadata?: LegalMetadataInitial;
};

export function PppBreedListForm({
  mode,
  ruleId,
  country,
  province,
  locality,
  base,
  initialBreeds,
  initialNotes,
  initialLegalMetadata,
}: Props) {
  const action =
    mode === "edit" && ruleId
      ? updateBusinessRuleAction.bind(null, ruleId)
      : createBusinessRuleAction;
  // forms/react19-reset-data-loss-inventory: the `breeds` checkbox group was
  // controlled with checked=/onChange= — the exact pair the
  // react19-form-reset-contract measures as vulnerable regardless (falls
  // back to its MOUNT selection). `notes` had a STATIC defaultValue.
  const { boundAction, kept, keptChecked } = useKeptFields<BusinessRuleFormState>(action);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);
  const [breeds, setBreeds] = useState<string[]>(initialBreeds);
  const [customBreed, setCustomBreed] = useState("");

  // Router-drop workaround (verify-report #650 WARNING-1) — see
  // lib/ui/full-page-action-nav.ts's module docblock.
  useEffect(() => {
    if (state.redirectTo) navigateAfterActionSuccess(state.redirectTo);
  }, [state.redirectTo]);

  // C9: impact gate. The banner already computes the affected-pet count; we
  // thread it here (no second preview call) and require the operator to
  // acknowledge a non-zero blast radius before the save may fire.
  const [impact, setImpact] = useState<RuleImpactResult>({ status: "idle", count: null });
  const [acknowledged, setAcknowledged] = useState(false);

  // Include the live `breeds` selection so a custom breed added via addCustom
  // (below) renders as a checked checkbox AND is submitted. Without `...breeds`,
  // a custom breed lands in state but never gets a checkbox row — so it neither
  // shows (the button reads as dead) nor submits (only checkboxes carry
  // name="breeds"). QA 2026-07-08: "Agregar raza no estándar" no-op.
  const ALL_BREEDS = Array.from(new Set([...DOG_BREEDS, ...initialBreeds, ...breeds])).sort();

  function toggle(breed: string) {
    setBreeds((prev) =>
      prev.includes(breed) ? prev.filter((b) => b !== breed) : [...prev, breed],
    );
  }
  function addCustom() {
    const b = customBreed.trim();
    if (!b || breeds.includes(b)) return;
    setBreeds((prev) => [...prev, b]);
    setCustomBreed("");
  }

  // Build preview input — recomputed when the breeds selection changes.
  const previewInput = useMemo<RuleImpactPreviewInput | null>(() => {
    if (breeds.length === 0) return null;
    return {
      ruleType: "ppp_breed_list",
      breeds,
      country,
      province,
      locality,
    };
  }, [breeds, country, province, locality]);

  const gateState = {
    status: impact.status,
    count: impact.count,
    acknowledged,
  };
  const mustConfirm = requiresImpactConfirmation(gateState);
  const canSave = canSaveWithImpactGate(gateState);

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="ruleType" value="ppp_breed_list" />
      <input type="hidden" name="jurisdictionCountry" value={country} />
      <input type="hidden" name="jurisdictionProvince" value={province ?? ""} />
      <input type="hidden" name="jurisdictionLocality" value={locality ?? ""} />
      <input type="hidden" name="portalBase" value={base} />

      <p className="text-md rounded-[var(--radius-md)] border border-ln-op-warn-bd bg-ln-op-warn-bg px-4 py-3 text-ln-op-warn">
        Las mascotas con raza marcada se evalúan automáticamente al guardar. Los dueños afectados
        reciben notificación.
      </p>

      <fieldset className="space-y-2">
        <legend className="text-md font-medium text-ln-op-ink">Razas consideradas PPP</legend>
        <div className="max-h-72 overflow-y-auto rounded-[var(--radius-md)] border border-ln-op-line p-3 space-y-1.5">
          {ALL_BREEDS.map((b) => (
            <label key={b} className="flex items-center gap-2 text-md">
              <input
                type="checkbox"
                name="breeds"
                value={b}
                defaultChecked={keptChecked("breeds", breeds.includes(b), b)}
                onChange={() => toggle(b)}
              />
              <span className="text-ln-op-ink">{b}</span>
              {DEFAULT_BREEDS_SET.has(b) && (
                <span className="text-sm text-ln-op-mute">(default AR)</span>
              )}
            </label>
          ))}
        </div>
      </fieldset>

      {/* Inline add-breed row: label-less compact layout — Field not used (rule #2) */}
      <div className="space-y-1.5">
        <p className="text-sm font-semibold text-ln-op-mute">Agregar raza no estándar</p>
        <div className="flex gap-2">
          <LnInput
            id="customBreed"
            type="text"
            value={customBreed}
            onChange={(e) => setCustomBreed(e.target.value)}
            placeholder="Boxer, Cimarrón Uruguayo…"
            className="flex-1"
          />
          <OpButton type="button" onClick={addCustom} variant="ghost">
            Agregar
          </OpButton>
        </div>
      </div>

      {/* Impact preview — shown before submission. C9: thread the result up so
          the save can gate on acknowledgement. A new count invalidates any prior
          acknowledgement so the operator re-confirms the new blast radius. */}
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

      <LnField label="Notas internas (visible solo a admin/govt)">
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

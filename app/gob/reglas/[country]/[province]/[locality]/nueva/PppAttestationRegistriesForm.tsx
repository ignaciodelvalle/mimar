"use client";

import { useActionState, useEffect, useState } from "react";

import {
  type BusinessRuleFormState,
  createBusinessRuleAction,
  updateBusinessRuleAction,
} from "@/app/actions/business-rules";
import { LnCheckbox, LnField, LnInput, LnTextarea } from "@/components/ui/Field";
import { OpButton } from "@/components/ui/dashboard";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";
import { useKeptFields } from "@/lib/ui/use-kept-fields";

import { LegalMetadataFieldset, type LegalMetadataInitial } from "./LegalMetadataFieldset";
import { RulePlaceField } from "./RulePlaceField";

const initialState: BusinessRuleFormState = { error: null };

type Registry = { id: string; label: string; required: boolean };

type Props = {
  mode: "create" | "edit";
  ruleId?: string;
  country: string;
  province: string | null;
  locality: string | null;
  base: "/admin" | "/gob";
  initialRegistries: Registry[];
  initialNotes: string;
  initialLegalMetadata?: LegalMetadataInitial;
};

export function PppAttestationRegistriesForm({
  mode,
  ruleId,
  country,
  province,
  locality,
  base,
  initialRegistries,
  initialNotes,
  initialLegalMetadata,
}: Props) {
  const action =
    mode === "edit" && ruleId
      ? updateBusinessRuleAction.bind(null, ruleId)
      : createBusinessRuleAction;
  // forms/react19-reset-data-loss-inventory: `notes` had a STATIC
  // defaultValue={initialNotes} — a rejected submit put back the row's
  // ORIGINAL notes. `registriesJson` is a controlled hidden field mirroring
  // `registries` state, safe on its own.
  const { boundAction, kept } = useKeptFields<BusinessRuleFormState>(action);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);

  // Router-drop workaround (verify-report #650 WARNING-1) — see
  // lib/ui/full-page-action-nav.ts's module docblock.
  useEffect(() => {
    if (state.redirectTo) navigateAfterActionSuccess(state.redirectTo);
  }, [state.redirectTo]);

  const [registries, setRegistries] = useState<Registry[]>(initialRegistries);
  const [newId, setNewId] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newRequired, setNewRequired] = useState(true);

  function addRegistry() {
    if (!newId.trim() || !newLabel.trim()) return;
    if (registries.some((r) => r.id === newId.trim())) return;
    setRegistries((prev) => [
      ...prev,
      { id: newId.trim(), label: newLabel.trim(), required: newRequired },
    ]);
    setNewId("");
    setNewLabel("");
    setNewRequired(true);
  }
  function removeRegistry(id: string) {
    setRegistries((prev) => prev.filter((r) => r.id !== id));
  }
  function toggleRequired(id: string) {
    setRegistries((prev) => prev.map((r) => (r.id === id ? { ...r, required: !r.required } : r)));
  }

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="ruleType" value="ppp_attestation_required_registries" />
      <input type="hidden" name="jurisdictionCountry" value={country} />
      <input type="hidden" name="jurisdictionProvince" value={province ?? ""} />
      <input type="hidden" name="jurisdictionLocality" value={locality ?? ""} />
      <RulePlaceField />
      <input type="hidden" name="portalBase" value={base} />

      {/* es-AR: "dueño" con ñ, voseo, y sin el identificador inglés `required`
          suelto en una frase en castellano. */}
      <p className="text-md text-ln-op-ink-2">
        Lista de registros oficiales en los que el dueño debe registrar (atestar) a su mascota PPP.
        Marcá como obligatorios los que lo sean.
      </p>

      <fieldset className="space-y-3">
        <legend className="text-md font-medium text-ln-op-ink">Registros configurados</legend>
        {registries.length === 0 && (
          <p className="text-sm text-ln-op-mute">
            Aún no agregaste registros. Sin registros, la regla equivale al default nacional
            (ninguno requerido).
          </p>
        )}
        {/* Serialize registries as a single JSON value — reorder-safe. */}
        <input type="hidden" name="registriesJson" value={JSON.stringify(registries)} />
        {registries.map((r) => (
          <div
            key={r.id}
            className="flex items-start gap-2 rounded-[var(--radius-md)] border border-ln-op-line p-3"
          >
            <div className="flex-1 text-md">
              <p className="font-medium text-ln-op-ink">{r.label}</p>
              <p className="text-sm text-ln-op-mute">
                <span className="font-ln-mono">{r.id}</span> {"·"}{" "}
                {r.required ? "Required" : "Optional"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => toggleRequired(r.id)}
              className="text-sm font-semibold text-ln-op-azul no-underline underline-offset-4 hover:underline"
            >
              {r.required ? "Hacer opcional" : "Marcar required"}
            </button>
            <button
              type="button"
              onClick={() => removeRegistry(r.id)}
              className="text-sm font-semibold text-ln-op-danger no-underline underline-offset-4 hover:underline"
            >
              Quitar
            </button>
          </div>
        ))}
      </fieldset>

      <fieldset className="space-y-2 rounded-[var(--radius-md)] border border-dashed border-ln-op-line p-3">
        <legend className="text-md font-medium text-ln-op-ink">Agregar registro</legend>
        {/* Inline add-registry row: compact grid alongside Checkbox — Field not used (rule #2) */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <LnInput
            type="text"
            placeholder="ID (caba_4078, prov_14107…)"
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
          />
          <LnInput
            type="text"
            placeholder="Label visible"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
          />
          <LnCheckbox checked={newRequired} onChange={() => setNewRequired((v) => !v)}>
            Required
          </LnCheckbox>
        </div>
        <button
          type="button"
          onClick={addRegistry}
          className="text-sm font-semibold text-ln-op-azul no-underline underline-offset-4 hover:underline"
        >
          + Agregar registro
        </button>
      </fieldset>

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

      <OpButton type="submit" disabled={isPending} loading={isPending} variant="primary" block>
        {isPending ? "Guardando..." : mode === "create" ? "Crear regla" : "Guardar cambios"}
      </OpButton>
    </form>
  );
}

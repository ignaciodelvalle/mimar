"use client";

import { Icon } from "@/components/Icon";
import { LnField, LnInput, LnRadio, LnTextarea } from "@/components/ui/Field";
import { LnSheetBody, LnSheetHeader } from "@/components/ui/Sheet";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import { todayIsoInAr } from "@/lib/utils/format";
import type { EventFormState } from "@/src/modules/events/actions";
import { useActionState, useState } from "react";
import { AttachmentField } from "../nuevo/AttachmentField";

const initialState: EventFormState = { error: null };
type FormAction = (prev: EventFormState, formData: FormData) => Promise<EventFormState>;
const FORM_ID = "dangerous-breed-attestation-form";

type RegistryOption = { value: string; label: string; help: string };

// Static fallback — used only when the jurisdiction has no
// ppp_attestation_required_registries rule configured (admin-rules-console
// config-theater fix, handoff 2026-07-03 #1). Once a jurisdiction sets its
// own registries, this list is replaced by the resolved rule so an admin
// edit actually changes what the owner sees.
const FALLBACK_REGISTRY_OPTIONS: RegistryOption[] = [
  {
    value: "caba_4078",
    label: "CABA · Ley 4078",
    help: "Registro de la Ciudad Autónoma de Buenos Aires.",
  },
  {
    value: "prov_14107",
    label: "Provincia de Buenos Aires · Ley 14.107",
    help: "Registro provincial bonaerense.",
  },
];

const OTHER_OPTION: RegistryOption = {
  value: "other",
  label: "Otro registro",
  help: "Si la mascota está en otra provincia, indicalo en las notas.",
};

/** Resolved rule registry shape (lib/domain/rule-types-registry.ts). */
export type ResolvedAttestationRegistry = { id: string; label: string; required: boolean };

function buildRegistryOptions(resolvedRegistries: ResolvedAttestationRegistry[]): RegistryOption[] {
  const base =
    resolvedRegistries.length > 0
      ? resolvedRegistries.map((r) => ({
          value: r.id,
          label: r.label,
          help: r.required
            ? "Registro requerido en esta jurisdicción."
            : "Registro opcional en esta jurisdicción.",
        }))
      : FALLBACK_REGISTRY_OPTIONS;
  return [...base, OTHER_OPTION];
}

// ---------------------------------------------------------------------------
// Step 1 — Legal information and acknowledgements
// ---------------------------------------------------------------------------

const LEGAL_CHECKS: Array<{ id: string; label: string }> = [
  {
    id: "check_rupppa",
    label:
      "Entiendo que debo inscribir a mi mascota en el registro RUPPPA (o provincial equivalente) y mantener la inscripción vigente.",
  },
  {
    id: "check_muzzle",
    label: "Me comprometo a que la mascota use bozal y correa corta en todo espacio público.",
  },
  {
    id: "check_insurance",
    label: "Asumo la responsabilidad civil por los daños que pueda causar la mascota.",
  },
  {
    id: "check_id",
    label: "Confirmo que la mascota lleva identificación visible permanente (placa + microchip).",
  },
];

function Step1({ onContinue }: { onContinue: () => void }) {
  const [checked, setChecked] = useState<Record<string, boolean>>({});

  const allChecked = LEGAL_CHECKS.every((c) => checked[c.id]);

  function toggle(id: string) {
    setChecked((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  return (
    <>
      <LnSheetHeader
        tone="warn"
        icon={<Icon name="alerta" decorative />}
        title="Atestar raza peligrosa"
        subtitle="Paso 1 de 2 · Información legal"
      />
      <LnSheetBody>
        <div className="space-y-[16px]">
          {/* Legal context */}
          <div className="rounded-[var(--radius-sm)] border border-[var(--color-ln-warn-050)] bg-[var(--color-ln-warn-025)] px-3.5 py-3 space-y-[8px]">
            <p className="font-semibold text-md text-[var(--color-ln-warn)]">
              Régimen de Animales Potencialmente Peligrosos
            </p>
            <p className="text-md text-[var(--color-ln-warn)]">
              Las leyes CABA 4078 y Prov. BA 14.107 establecen obligaciones específicas para
              tenedores de razas consideradas potencialmente peligrosas. La atestación que vas a
              registrar queda anclada a tu DNI y a la jurisdicción de tu domicilio.
            </p>
            <p className="text-sm text-[var(--color-ln-warn)]">
              Este registro es inmutable e integra la libreta sanitaria oficial de la mascota.
            </p>
          </div>

          {/* Acknowledgement checkboxes */}
          <fieldset className="space-y-[10px] border-0 p-0 m-0">
            <legend className="font-ln-mono text-xs uppercase tracking-[.1em] font-semibold text-[var(--color-ln-mute)] mb-1.5">
              Confirmaciones requeridas
            </legend>
            {LEGAL_CHECKS.map((c) => (
              <label key={c.id} className="flex items-start gap-2.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  className="mt-0.5 h-[14px] w-[14px] flex-shrink-0 rounded-[var(--radius-xs)] accent-[var(--color-ln-warn)]"
                  checked={!!checked[c.id]}
                  onChange={() => toggle(c.id)}
                />
                <span className="text-md text-[var(--color-ln-ink-2)] leading-[1.5]">
                  {c.label}
                </span>
              </label>
            ))}
          </fieldset>
        </div>
      </LnSheetBody>
      {/* Step 1 footer — advance only when all boxes are checked */}
      <div className="border-t border-[var(--color-ln-line)] px-5 py-4">
        <button
          type="button"
          disabled={!allChecked}
          onClick={onContinue}
          className="w-full rounded-[var(--radius-sm)] bg-[var(--color-ln-warn)] px-4 py-3 font-ln-sans text-md font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Continuar con la atestación →
        </button>
        {!allChecked && (
          <p className="mt-2 text-center font-ln-mono text-sm text-[var(--color-ln-mute)]">
            Confirmá todas las obligaciones para continuar
          </p>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Attestation data form
// ---------------------------------------------------------------------------

function Step2({
  action,
  onBack,
  registryOptions,
}: {
  action: FormAction;
  onBack: () => void;
  registryOptions: RegistryOption[];
}) {
  // The registry radio group was controlled via `checked`/`onChange` — the
  // exact shape the react19-form-reset-contract measures as vulnerable
  // regardless of the pair: a reset restores a radio to its mount value
  // (none ticked, here), which for a required field the person cannot
  // resubmit without noticing — but they lost the pick they already made.
  const { boundAction, keptChecked } = useKeptFields<EventFormState>(action);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);
  // N3 redirect contract: the action returns `redirectTo` on success and the
  // form performs the full document navigation (see lib/ui/use-action-redirect.ts).
  useActionRedirect(state.redirectTo, state);
  const today = todayIsoInAr();

  // Controlled field state — preserves typed input on validation error.
  const [registryId, setRegistryId] = useState("");
  const [attestedAt, setAttestedAt] = useState(today);
  const [notes, setNotes] = useState("");

  return (
    <>
      <LnSheetHeader
        tone="warn"
        icon={<Icon name="alerta" decorative />}
        title="Atestar raza peligrosa"
        subtitle="Paso 2 de 2 · Datos del registro"
      />
      <LnSheetBody>
        <form id={FORM_ID} action={formAction} className="contents">
          {/* Registry radio group */}
          <div className="flex flex-col gap-1.5">
            <p className="font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-[var(--color-ln-mute)]">
              Registro{" "}
              <span className="text-[var(--color-ln-seal)]" aria-hidden="true">
                *
              </span>
            </p>
            <div className="flex flex-col gap-1.5">
              {registryOptions.map((opt) => (
                <LnRadio
                  key={opt.value}
                  name="registry"
                  value={opt.value}
                  required
                  defaultChecked={keptChecked("registry", false, opt.value)}
                >
                  <span className="flex flex-col gap-px">
                    {opt.label}
                    <span className="text-sm text-[var(--color-ln-mute)]">{opt.help}</span>
                  </span>
                </LnRadio>
              ))}
            </div>
          </div>

          <LnField label="Nº de registro / expediente">
            {({ id, describedBy, invalid }) => (
              <LnInput
                id={id}
                name="registryId"
                type="text"
                value={registryId}
                onChange={(e) => setRegistryId(e.target.value)}
                placeholder="Si tenés el número a mano"
                aria-describedby={describedBy}
                invalid={invalid}
                mono
              />
            )}
          </LnField>
          <LnField label="Fecha de atestación" required>
            {({ id, describedBy, invalid }) => (
              <LnInput
                id={id}
                name="attestedAt"
                type="date"
                required
                mono
                value={attestedAt}
                onChange={(e) => setAttestedAt(e.target.value)}
                aria-describedby={describedBy}
                invalid={invalid}
              />
            )}
          </LnField>
          <LnField label="Notas">
            {({ id, describedBy, invalid }) => (
              <LnTextarea
                id={id}
                name="notes"
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Detalles, si querés agregar"
                aria-describedby={describedBy}
                invalid={invalid}
              />
            )}
          </LnField>
          <AttachmentField />
          {state.error && (
            <p className="font-ln-mono text-sm text-[var(--color-ln-err)]" role="alert">
              {state.error}
            </p>
          )}
        </form>
      </LnSheetBody>
      <div className="border-t border-[var(--color-ln-line)] px-5 py-4 space-y-[8px]">
        <button
          type="submit"
          form={FORM_ID}
          disabled={isPending}
          className="w-full rounded-[var(--radius-sm)] bg-[var(--color-ln-warn)] px-4 py-3 font-ln-sans text-md font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isPending ? "Registrando..." : "Registrar atestación"}
        </button>
        <button
          type="button"
          onClick={onBack}
          disabled={isPending}
          className="w-full rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] px-4 py-2.5 font-ln-sans text-md font-medium text-[var(--color-ln-ink-2)] transition-colors hover:bg-[var(--color-ln-stripe)] disabled:opacity-40"
        >
          ← Volver al paso anterior
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Wizard root — orchestrates the 2-step flow
// ---------------------------------------------------------------------------

export function DangerousBreedAttestationForm({
  action,
  resolvedRegistries,
}: {
  action: FormAction;
  /** Resolved ppp_attestation_required_registries payload for the pet's jurisdiction. */
  resolvedRegistries: ResolvedAttestationRegistry[];
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const registryOptions = buildRegistryOptions(resolvedRegistries);

  if (step === 1) {
    return <Step1 onContinue={() => setStep(2)} />;
  }
  return <Step2 action={action} onBack={() => setStep(1)} registryOptions={registryOptions} />;
}

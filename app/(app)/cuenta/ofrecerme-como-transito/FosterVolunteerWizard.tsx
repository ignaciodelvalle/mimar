"use client";

// FosterVolunteerWizard — 3-step wizard wrapping the previous FosterVolunteerForm.
// Trilogy unification handoff §3 PR-023.
//
// Steps:
//   1. Tu disponibilidad — status banner + L1 jurisdiction + max duration.
//      CTA: Continuar.
//   2. Qué podés recibir — species, sizes, ages, conditions. CTA: Continuar.
//   3. Contexto del hogar — household tri-state + notes.
//      CTA on enrol: "Inscribirme (sumar slot)"; on update: "Guardar preferencias".
//
// The status controls (Pausar / Reactivar / Salir del pool) live OUTSIDE the
// wizard at the top — they don't fit the linear flow and the user often
// reaches the page just to pause without touching preferences (handoff D2).
//
// All state is controlled — same shape as the previous form. Splitting into
// step components would require lifting state and bouncing setter props
// around; keeping them all here is simpler than the controlled-uncontrolled
// hybrid that DenunciaWizard / MarkLostWizard use.

import { useState, useTransition } from "react";

import { LocalityPickerAcross } from "@/components/LocalityPickerAcross";
import { LnCheckbox } from "@/components/ui/Field";
import { LnWizardShell } from "@/components/ui/WizardShell";
import { provinceByName } from "@/lib/reference/ar-provincias";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";
import {
  upsertFosterVolunteerAction,
  withdrawFosterVolunteerAction,
} from "@/src/modules/foster/actions";
import type { UpsertFosterVolunteerInput } from "@/src/modules/foster/domain/types";

type InitialState = {
  status: "active" | "paused" | "withdrawn";
  availableSlots: number;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  acceptsDogs: boolean;
  acceptsCats: boolean;
  acceptsOtherSpecies: boolean;
  acceptsSizeSmall: boolean;
  acceptsSizeMedium: boolean;
  acceptsSizeLarge: boolean;
  acceptsPuppies: boolean;
  acceptsSeniors: boolean;
  acceptsChronicConditions: boolean;
  acceptsDangerousBreeds: boolean;
  maxDurationWeeks: number | null;
  householdOtherPets: boolean | null;
  householdKids: boolean | null;
  notes: string | null;
};

const TOTAL_STEPS = 3;
const STEP_LABELS = ["Tu disponibilidad", "Qué podés recibir", "Contexto del hogar"];

export function FosterVolunteerWizard({ initial }: { initial: InitialState | null }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [okMessage, setOkMessage] = useState<string | null>(null);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const [step, setStep] = useState(1);

  const isWithdrawn = initial?.status === "withdrawn";
  const isNew = !initial || isWithdrawn;

  const [acceptsDogs, setAcceptsDogs] = useState(initial?.acceptsDogs ?? true);
  const [acceptsCats, setAcceptsCats] = useState(initial?.acceptsCats ?? true);
  const [acceptsOtherSpecies, setAcceptsOtherSpecies] = useState(
    initial?.acceptsOtherSpecies ?? false,
  );
  const [acceptsSizeSmall, setAcceptsSizeSmall] = useState(initial?.acceptsSizeSmall ?? true);
  const [acceptsSizeMedium, setAcceptsSizeMedium] = useState(initial?.acceptsSizeMedium ?? true);
  const [acceptsSizeLarge, setAcceptsSizeLarge] = useState(initial?.acceptsSizeLarge ?? false);
  const [acceptsPuppies, setAcceptsPuppies] = useState(initial?.acceptsPuppies ?? false);
  const [acceptsSeniors, setAcceptsSeniors] = useState(initial?.acceptsSeniors ?? true);
  const [acceptsChronicConditions, setAcceptsChronicConditions] = useState(
    initial?.acceptsChronicConditions ?? false,
  );
  const [acceptsDangerousBreeds, setAcceptsDangerousBreeds] = useState(
    initial?.acceptsDangerousBreeds ?? false,
  );
  const [maxDurationWeeks, setMaxDurationWeeks] = useState(
    initial?.maxDurationWeeks?.toString() ?? "",
  );
  const [province, setProvince] = useState(initial?.jurisdictionProvince ?? "");
  const [locality, setLocality] = useState(initial?.jurisdictionLocality ?? "");
  const [householdOtherPets, setHouseholdOtherPets] = useState<boolean | null>(
    initial?.householdOtherPets ?? null,
  );
  const [householdKids, setHouseholdKids] = useState<boolean | null>(
    initial?.householdKids ?? null,
  );
  const [notes, setNotes] = useState(initial?.notes ?? "");

  function submit(mode: "enroll" | "update_preferences_only", status: "active" | "paused") {
    setError(null);
    setOkMessage(null);
    const input: UpsertFosterVolunteerInput = {
      mode,
      status,
      jurisdictionProvince: province.trim() || null,
      jurisdictionLocality: locality.trim() || null,
      acceptsDogs,
      acceptsCats,
      acceptsOtherSpecies,
      acceptsSizeSmall,
      acceptsSizeMedium,
      acceptsSizeLarge,
      acceptsPuppies,
      acceptsSeniors,
      acceptsChronicConditions,
      acceptsDangerousBreeds,
      maxDurationWeeks: maxDurationWeeks.trim()
        ? Math.max(0, Number.parseInt(maxDurationWeeks, 10) || 0)
        : null,
      householdOtherPets,
      householdKids,
      notes: notes.trim() || null,
    };
    startTransition(async () => {
      const result = await upsertFosterVolunteerAction(input);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOkMessage(`Listo. Tenés ${result.availableSlots} slot(s) disponible(s).`);
      // Full document reload: the status banner + slot count above the wizard
      // are SSR (pool matching reads the volunteer snapshot), and a partial
      // refresh can leave wizard step state inconsistent with DB status.
      // router.refresh() is banned — see lib/ui/full-page-action-nav.ts.
      navigateAfterActionSuccess(window.location.pathname);
    });
  }

  function withdraw() {
    setError(null);
    setOkMessage(null);
    startTransition(async () => {
      const result = await withdrawFosterVolunteerAction();
      if ("error" in result) {
        setError(result.error);
        setConfirmWithdraw(false);
        return;
      }
      setConfirmWithdraw(false);
      setOkMessage("Saliste del pool. Podés volver a inscribirte cuando quieras.");
      // Same full-reload rationale as submit() above.
      navigateAfterActionSuccess(window.location.pathname);
    });
  }

  return (
    <div className="space-y-6">
      {/* Status banner + pause/withdraw lives above the wizard — these are
          "out of band" actions that don't fit a linear flow. */}
      {initial && initial.status === "active" && (
        <div className="rounded-[var(--radius-sm)] border border-[var(--color-ln-ok)] bg-[var(--color-ln-ok-050)] p-3 text-sm flex flex-wrap items-center justify-between gap-3">
          <p className="text-[var(--color-ln-ok)]">
            Estás inscripto · <strong>{initial.availableSlots}</strong> slot(s) disponible(s)
          </p>
          <div className="flex flex-col gap-2 items-end">
            {confirmWithdraw ? (
              <div className="flex flex-col items-end gap-2">
                <p className="text-xs text-[var(--color-ln-ink-2)]">
                  ¿Seguro? Tus propuestas pendientes se cancelan.
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={withdraw}
                    disabled={pending}
                    className="px-3 py-1.5 rounded-[var(--radius-pill)] text-xs bg-[var(--color-ln-seal)] text-white hover:opacity-90 disabled:opacity-60 transition-colors"
                  >
                    {pending ? "Saliendo…" : "Confirmar salida"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmWithdraw(false)}
                    disabled={pending}
                    className="px-3 py-1.5 rounded-[var(--radius-pill)] text-xs border border-[var(--color-ln-line-strong)] hover:bg-[var(--color-ln-stripe)] disabled:opacity-60 transition-colors"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => submit("update_preferences_only", "paused")}
                  disabled={pending}
                  className="px-3 py-1.5 rounded-[var(--radius-pill)] text-xs border border-[var(--color-ln-line-strong)] hover:bg-[var(--color-ln-stripe)] transition-colors"
                >
                  Pausar
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmWithdraw(true)}
                  disabled={pending}
                  className="px-3 py-1.5 rounded-[var(--radius-pill)] text-xs border border-[var(--color-ln-seal)] text-[var(--color-ln-seal)] hover:bg-[var(--color-ln-err-050)] transition-colors"
                >
                  Salir del pool
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      {initial && initial.status === "paused" && (
        <div className="rounded-[var(--radius-sm)] border border-[var(--color-ln-warn)] bg-[var(--color-ln-warn-050)] p-3 text-sm flex flex-wrap items-center justify-between gap-3">
          <p className="text-[var(--color-ln-warn)]">
            Tu inscripción está <strong>pausada</strong>. No recibís propuestas nuevas.
          </p>
          <button
            type="button"
            onClick={() => submit("update_preferences_only", "active")}
            disabled={pending}
            className="px-3 py-1.5 rounded-[var(--radius-pill)] text-xs bg-[var(--color-ln-ok)] text-white hover:opacity-90 transition-colors"
          >
            Reactivar
          </button>
        </div>
      )}
      {isWithdrawn && (
        <div className="rounded-[var(--radius-sm)] border border-[var(--color-ln-warn)] bg-[var(--color-ln-warn-050)] p-3 text-sm text-[var(--color-ln-warn)]">
          Saliste del pool antes. Re-inscribirte va a sumar un slot fresh.
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(isNew ? "enroll" : "update_preferences_only", "active");
        }}
      >
        <LnWizardShell
          currentStep={step}
          totalSteps={TOTAL_STEPS}
          stepLabels={STEP_LABELS}
          onBack={step > 1 ? () => setStep((s) => s - 1) : undefined}
        >
          {/* Step 1 — Disponibilidad */}
          <section
            className={step === 1 ? "space-y-5" : "sr-only"}
            aria-hidden={step !== 1}
            inert={step !== 1 ? true : undefined}
          >
            <div className="space-y-2">
              <p className="text-sm text-[var(--color-ln-ink-2)]">
                ¿Dónde estás y por cuánto tiempo podés alojar un animal?
              </p>
            </div>

            <div>
              <label
                htmlFor="fv-locality"
                className="block text-sm font-medium text-[var(--color-ln-ink)]"
              >
                Localidad
              </label>
              <LocalityPickerAcross
                id="fv-locality"
                defaultValue={{
                  provinceCode: provinceByName(province)?.code ?? null,
                  provinceName: province || null,
                  localityName: locality || null,
                }}
                onSelect={(result) => {
                  setProvince(result?.provinceName ?? "");
                  setLocality(result?.localityName ?? "");
                }}
                onDeselect={() => {
                  setProvince("");
                  setLocality("");
                }}
              />
              <p className="mt-1 text-xs text-[var(--color-ln-mute)]">
                La provincia se deduce de la localidad que elijas.
              </p>
            </div>

            <div className="space-y-2">
              <label
                htmlFor="fv-max-duration"
                className="block text-sm font-medium text-[var(--color-ln-ink)]"
              >
                Duración máxima (semanas)
              </label>
              <input
                id="fv-max-duration"
                type="number"
                min={0}
                value={maxDurationWeeks}
                onChange={(e) => setMaxDurationWeeks(e.target.value)}
                placeholder="Ej: 8"
                className="w-32 px-3 py-2 rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] outline-none focus:border-[var(--color-ln-azul)] focus:shadow-[0_0_0_3px_var(--color-ln-celeste-050)]"
              />
              <p className="text-xs text-[var(--color-ln-mute)]">
                Dejalo vacío si podés acompañar el tránsito hasta el fin.
              </p>
            </div>

            <button
              type="button"
              onClick={() => setStep(2)}
              className="w-full px-4 py-3 rounded-[var(--radius-pill)] bg-[var(--color-ln-azul)] text-white font-medium hover:bg-[var(--color-ln-azul-700)] transition-colors"
            >
              Continuar
            </button>
          </section>

          {/* Step 2 — Preferencias */}
          <section
            className={step === 2 ? "space-y-5" : "sr-only"}
            aria-hidden={step !== 2}
            inert={step !== 2 ? true : undefined}
          >
            <fieldset className="space-y-3">
              <legend className="text-sm font-medium text-[var(--color-ln-ink)]">
                Especies que aceptás
              </legend>
              <CheckboxRow label="Perros" checked={acceptsDogs} onChange={setAcceptsDogs} />
              <CheckboxRow label="Gatos" checked={acceptsCats} onChange={setAcceptsCats} />
              <CheckboxRow
                label="Otras especies"
                checked={acceptsOtherSpecies}
                onChange={setAcceptsOtherSpecies}
              />
            </fieldset>

            <fieldset className="space-y-3">
              <legend className="text-sm font-medium text-[var(--color-ln-ink)]">
                Tamaño (solo aplica a perros)
              </legend>
              <CheckboxRow
                label="Chico (<10 kg)"
                checked={acceptsSizeSmall}
                onChange={setAcceptsSizeSmall}
              />
              <CheckboxRow
                label="Mediano (10–25 kg)"
                checked={acceptsSizeMedium}
                onChange={setAcceptsSizeMedium}
              />
              <CheckboxRow
                label="Grande (>25 kg)"
                checked={acceptsSizeLarge}
                onChange={setAcceptsSizeLarge}
              />
            </fieldset>

            <fieldset className="space-y-3">
              <legend className="text-sm font-medium text-[var(--color-ln-ink)]">Edad</legend>
              <CheckboxRow
                label="Cachorros (<4 meses)"
                checked={acceptsPuppies}
                onChange={setAcceptsPuppies}
              />
              <CheckboxRow
                label="Adultos mayores (>7 años)"
                checked={acceptsSeniors}
                onChange={setAcceptsSeniors}
              />
            </fieldset>

            <fieldset className="space-y-3">
              <legend className="text-sm font-medium text-[var(--color-ln-ink)]">
                Otras condiciones
              </legend>
              <CheckboxRow
                label="Animales con condiciones crónicas"
                checked={acceptsChronicConditions}
                onChange={setAcceptsChronicConditions}
              />
              <CheckboxRow
                label="Razas potencialmente peligrosas (PPP)"
                checked={acceptsDangerousBreeds}
                onChange={setAcceptsDangerousBreeds}
              />
              {acceptsDangerousBreeds && (
                <p className="text-xs text-[var(--color-ln-ink-2)] pl-6">
                  Aclaración: la responsabilidad civil por daños permanece en quien ejerce custodia
                  mientras el animal esté en tránsito.
                </p>
              )}
            </fieldset>

            <button
              type="button"
              onClick={() => setStep(3)}
              className="w-full px-4 py-3 rounded-[var(--radius-pill)] bg-[var(--color-ln-azul)] text-white font-medium hover:bg-[var(--color-ln-azul-700)] transition-colors"
            >
              Continuar
            </button>
          </section>

          {/* Step 3 — Hogar + Submit */}
          <section
            className={step === 3 ? "space-y-5" : "sr-only"}
            aria-hidden={step !== 3}
            inert={step !== 3 ? true : undefined}
          >
            <fieldset className="space-y-3">
              <legend className="text-sm font-medium text-[var(--color-ln-ink)]">
                Hogar (opcional)
              </legend>
              <TriStateRow
                label="¿Tenés otros animales en casa?"
                value={householdOtherPets}
                onChange={setHouseholdOtherPets}
              />
              <TriStateRow
                label="¿Tenés chicos en casa?"
                value={householdKids}
                onChange={setHouseholdKids}
              />
            </fieldset>

            <div>
              <label
                htmlFor="fv-notes"
                className="block text-sm font-medium text-[var(--color-ln-ink)]"
              >
                Notas para el refugio
              </label>
              <textarea
                id="fv-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                placeholder="Algo que quieras que sepan: experiencia previa, horarios, etc."
                className="w-full px-3 py-2 rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] outline-none focus:border-[var(--color-ln-azul)] focus:shadow-[0_0_0_3px_var(--color-ln-celeste-050)]"
              />
            </div>

            {error && <output className="block text-sm text-[var(--color-ln-err)]">{error}</output>}
            {okMessage && (
              <output className="block text-sm text-[var(--color-ln-ok)]">{okMessage}</output>
            )}

            <button
              type="submit"
              disabled={pending}
              className="w-full px-4 py-3 rounded-[var(--radius-pill)] bg-[var(--color-ln-ok)] text-white font-medium hover:opacity-90 disabled:opacity-50 transition-colors"
            >
              {pending
                ? "Guardando..."
                : isNew
                  ? "Inscribirme (sumar slot)"
                  : "Guardar preferencias"}
            </button>
          </section>
        </LnWizardShell>
      </form>
    </div>
  );
}

// Thin adapter over the Poncho <Checkbox>: keeps the ergonomic boolean onChange
// the wizard's controlled state expects, while delegating all styling to the
// design-system primitive.
function CheckboxRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <LnCheckbox checked={checked} onChange={(e) => onChange(e.target.checked)}>
      {label}
    </LnCheckbox>
  );
}

function TriStateRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean | null;
  onChange: (v: boolean | null) => void;
}) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="flex-1 text-[var(--color-ln-ink)]">{label}</span>
      <div className="flex gap-2">
        {(
          [
            { v: true, l: "Sí" },
            { v: false, l: "No" },
            { v: null, l: "Prefiero no decir" },
          ] as const
        ).map((opt) => (
          <button
            key={opt.l}
            type="button"
            onClick={() => onChange(opt.v)}
            className={`px-2 py-1 rounded-[var(--radius-pill)] border text-xs transition-colors ${
              value === opt.v
                ? "border-[var(--color-ln-azul)] bg-[var(--color-ln-azul)] text-white"
                : "border-[var(--color-ln-line-strong)] hover:bg-[var(--color-ln-stripe)]"
            }`}
          >
            {opt.l}
          </button>
        ))}
      </div>
    </div>
  );
}

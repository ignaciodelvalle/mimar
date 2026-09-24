"use client";

// ServiceOfferingForm — 3-step wizard for new service offering.
// Trilogy unification handoff §5 PR-046.
//
// Steps:
//   1. Tipo — kind + display name + description. CTA Continuar.
//   2. Capacidad — duration + slot capacity + price. CTA Continuar.
//   3. Elegibilidad — species + age range + submit. CTA Crear servicio.
//
// The handoff's third step was 'ubicación L2'; the current data model
// inherits location from the parent org so this PR keeps the 3 steps
// as content/capacity/eligibility instead. L2 per-offering location is
// deferred until the schema gains the field.

import { useActionState, useState } from "react";

import type { ServiceOfferingFormState } from "@/app/actions/service-offerings";
import { LnCheckbox, LnInput, LnSelect, LnTextarea } from "@/components/ui/Field";
import { LnWizardShell } from "@/components/ui/WizardShell";
import { OpButton } from "@/components/ui/dashboard";
import type { ServiceKindDef } from "@/lib/reference/service-kinds";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useKeptFields } from "@/lib/ui/use-kept-fields";

const INITIAL_STATE: ServiceOfferingFormState = { error: null };

const TOTAL_STEPS = 3;
const STEP_LABELS = ["Tipo", "Capacidad", "Elegibilidad"];

export function ServiceOfferingForm({
  serviceKinds,
  createAction,
  orgToken,
}: {
  serviceKinds: readonly ServiceKindDef[];
  createAction: (
    prev: ServiceOfferingFormState,
    formData: FormData,
  ) => Promise<ServiceOfferingFormState>;
  orgToken: string;
}) {
  // THE WORST OPERATOR-SIDE LOSS WE FOUND: a three-step wizard, every single
  // field DOM-owned, and React 19 resets a `<form action>` the moment its action
  // settles — a refusal settles it. One complaint from the server on step 3 took
  // the type, the name, the description, the duration, the capacity, the price,
  // both age bounds and the species ticks with it. The wizard stays on step 3,
  // which is the mean part: the two steps that were just emptied are the two the
  // operator cannot see, so the only honest way to find out was to walk back.
  // `useKeptFields` re-seeds each field from the form's own submitted `FormData`
  // (contract: `__tests__/react19-form-reset-contract.test.tsx`).
  //
  // The two that need a fallback ARGUMENT rather than a bare `kept()` are the
  // ones that ship with a value: `durationMinutes` and `slotCapacity` reset to
  // 15 and 1, which LOOKS like a filled form and is why this was easy to miss.
  // `kept(...) || "15"` keeps the seeded default before the first submit and the
  // operator's own number after it.
  const { boundAction: keptAction, kept, keptChecked } = useKeptFields(createAction);
  const [state, formAction, isPending] = useActionState(keptAction, INITIAL_STATE);
  // N3: the action returns where to go and this navigates. It used to
  // redirect() server-side, a transition the App Router drops in production —
  // the write committed and the screen never moved.
  useActionRedirect(state.redirectTo, state);
  const [step, setStep] = useState(1);

  return (
    <form action={formAction}>
      {/* WHICH organization this service belongs to. The form knew it all along
          (it is in the URL, and the Cancelar link below uses it) but never SENT
          it, so the action fell back to the session-default membership — for a
          member of several organizations, that is a different one. Same hidden
          field AgendaRuleForm already carries. See the action for the full
          story. */}
      <input type="hidden" name="orgToken" value={orgToken} />
      <LnWizardShell
        currentStep={step}
        totalSteps={TOTAL_STEPS}
        stepLabels={STEP_LABELS}
        onBack={step > 1 ? () => setStep((s) => s - 1) : undefined}
      >
        {state.error && (
          <p className="text-md rounded-[var(--radius-md)] border border-ln-op-danger bg-ln-op-danger-bg px-3 py-2 text-ln-op-danger">
            {state.error}
          </p>
        )}

        {/* Step 1 — Tipo + nombre + descripción */}
        <section
          className={step === 1 ? "space-y-4" : "sr-only"}
          aria-hidden={step !== 1}
          inert={step !== 1 ? true : undefined}
        >
          <div className="space-y-1">
            <label htmlFor="serviceKind" className="block text-md font-medium text-ln-op-ink">
              Tipo de servicio <span className="text-ln-op-danger">*</span>
            </label>
            {/* The `key` is load-bearing, not decoration: a select is restored
                from its options' `selected` ATTRIBUTE, which react-dom writes
                only on mount, so a `defaultValue` that changes on an update
                moves nothing and the reset drops back to the placeholder.
                Keying on the kept value remounts the select in the settle
                render and puts the write back on the mount path. Measured in
                `__tests__/react19-form-reset-contract.test.tsx`. */}
            <LnSelect
              key={`serviceKind-${kept("serviceKind")}`}
              id="serviceKind"
              name="serviceKind"
              defaultValue={kept("serviceKind")}
              required
            >
              <option value="">— Seleccioná un tipo —</option>
              {serviceKinds.map((k) => (
                <option key={k.code} value={k.code}>
                  {k.label}
                </option>
              ))}
            </LnSelect>
          </div>

          <div className="space-y-1">
            <label htmlFor="displayName" className="block text-md font-medium text-ln-op-ink">
              Nombre del servicio <span className="text-ln-op-danger">*</span>
            </label>
            <LnInput
              id="displayName"
              name="displayName"
              defaultValue={kept("displayName")}
              type="text"
              required
              minLength={3}
              maxLength={120}
              placeholder="Ej: Vacunación antirrábica — campaña junio 2026"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="description" className="block text-md font-medium text-ln-op-ink">
              Descripción <span className="text-ln-op-mute font-normal">(opcional)</span>
            </label>
            <LnTextarea
              id="description"
              name="description"
              defaultValue={kept("description")}
              maxLength={500}
              rows={3}
              placeholder="Información adicional para quienes reserven el turno."
              className="resize-none"
            />
          </div>

          <OpButton variant="primary" block onClick={() => setStep(2)}>
            Continuar
          </OpButton>
        </section>

        {/* Step 2 — Capacidad */}
        <section
          className={step === 2 ? "space-y-4" : "sr-only"}
          aria-hidden={step !== 2}
          inert={step !== 2 ? true : undefined}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1">
              <label htmlFor="durationMinutes" className="block text-md font-medium text-ln-op-ink">
                Duración (minutos) <span className="text-ln-op-danger">*</span>
              </label>
              <LnInput
                id="durationMinutes"
                name="durationMinutes"
                type="number"
                required
                min={5}
                max={480}
                defaultValue={kept("durationMinutes") || 15}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="slotCapacity" className="block text-md font-medium text-ln-op-ink">
                Capacidad por turno <span className="text-ln-op-danger">*</span>
              </label>
              <LnInput
                id="slotCapacity"
                name="slotCapacity"
                type="number"
                required
                min={1}
                max={100}
                defaultValue={kept("slotCapacity") || 1}
              />
            </div>
          </div>

          <div className="space-y-1">
            <label htmlFor="priceArs" className="block text-md font-medium text-ln-op-ink">
              Precio (ARS){" "}
              <span className="text-ln-op-mute font-normal">— vacío para campaña gratuita</span>
            </label>
            <LnInput
              id="priceArs"
              name="priceArs"
              defaultValue={kept("priceArs")}
              type="number"
              min={0}
              step="0.01"
              placeholder="0.00"
            />
          </div>

          <OpButton variant="primary" block onClick={() => setStep(3)}>
            Continuar
          </OpButton>
        </section>

        {/* Step 3 — Elegibilidad + submit */}
        <section
          className={step === 3 ? "space-y-4" : "sr-only"}
          aria-hidden={step !== 3}
          inert={step !== 3 ? true : undefined}
        >
          <div className="space-y-1">
            <span className="block text-md font-medium text-ln-op-ink">Especies elegibles</span>
            <div className="flex gap-4">
              {/* Both boxes share ONE name, so this is the multi-value case the
                  hook had to learn: `keptChecked` asks "was MY value among the
                  ones submitted", and the fallback is `true` because both ship
                  ticked and a pre-submit form must not look untouched. */}
              <LnCheckbox
                name="eligibilitySpecies"
                value="dog"
                defaultChecked={keptChecked("eligibilitySpecies", true, "dog")}
              >
                Perros
              </LnCheckbox>
              <LnCheckbox
                name="eligibilitySpecies"
                value="cat"
                defaultChecked={keptChecked("eligibilitySpecies", true, "cat")}
              >
                Gatos
              </LnCheckbox>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1">
              <label
                htmlFor="eligibilityAgeMinMonths"
                className="block text-md font-medium text-ln-op-ink"
              >
                Edad mínima (meses) <span className="text-ln-op-mute font-normal">(opcional)</span>
              </label>
              <LnInput
                id="eligibilityAgeMinMonths"
                name="eligibilityAgeMinMonths"
                defaultValue={kept("eligibilityAgeMinMonths")}
                type="number"
                min={0}
                max={360}
                placeholder="Sin mínimo"
              />
            </div>
            <div className="space-y-1">
              <label
                htmlFor="eligibilityAgeMaxMonths"
                className="block text-md font-medium text-ln-op-ink"
              >
                Edad máxima (meses) <span className="text-ln-op-mute font-normal">(opcional)</span>
              </label>
              <LnInput
                id="eligibilityAgeMaxMonths"
                name="eligibilityAgeMaxMonths"
                defaultValue={kept("eligibilityAgeMaxMonths")}
                type="number"
                min={0}
                max={360}
                placeholder="Sin máximo"
              />
            </div>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <OpButton type="submit" variant="primary" className="flex-1" disabled={isPending}>
              {isPending ? "Enviando…" : "Crear servicio"}
            </OpButton>
            <a
              href={`/org/${orgToken}/servicios`}
              className="text-sm text-ln-op-azul hover:underline"
            >
              Cancelar
            </a>
          </div>
        </section>
      </LnWizardShell>
    </form>
  );
}

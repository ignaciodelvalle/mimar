"use client";

// ProposeReturnForm — 3-step wizard for proposing return-to-owner.
// Trilogy unification handoff §5 PR-044 (scoped).
//
// Steps:
//   1. Identidad — read-only confirmation of the pet being returned.
//      CTA Continuar.
//   2. Punto y momento de entrega — optional notes about where/when the
//      handover will happen. CTA Continuar.
//   3. Confirmación final — review + textbox for notes to the owner + send.
//      CTA Confirmar propuesta.
//
// On success → SuccessScreen "Propuesta enviada. Esperando confirmación del
// dueño". The owner gets a notification with an accept link.
//
// Scope note: the handoff describes a more elaborate flow (microchip
// cross-check + owner photo + L2 meeting location + signature + custody_
// transferred event with ownerships flip). The current server action only
// emits a proposal — actual transfer happens when the owner confirms. This
// PR wraps the existing action in a wizard with placeholders for the heavier
// fields; full identity-verification + meeting-coords + signature land later
// when the action signature evolves.

import { useActionState, useState } from "react";

import { proposeReturnToOwnerFormAction } from "@/app/actions/return-to-owner-form";
import { LnSuccessScreen } from "@/components/ui/SuccessScreen";
import { LnWizardShell } from "@/components/ui/WizardShell";
import { OpButton, OpTextarea } from "@/components/ui/dashboard";
import { useKeptFields } from "@/lib/ui/use-kept-fields";

export type ProposeReturnFormState = {
  error: string | null;
  success?: boolean;
};

const initialState: ProposeReturnFormState = { error: null };

const TOTAL_STEPS = 3;
const STEP_LABELS = ["Identidad", "Entrega", "Confirmar"];

export function ProposeReturnForm({
  orgToken,
  petPublicToken,
  petName,
}: {
  orgToken: string;
  petPublicToken: string;
  petName?: string;
}) {
  const action = proposeReturnToOwnerFormAction.bind(null, orgToken, petPublicToken);
  // forms/react19-reset-data-loss-inventory: "notes" is a bare uncontrolled
  // field — a rejected submit wipes it, and this wizard's step 3 is the ONLY
  // place it's rendered, so the org loses it right when they're about to send.
  const { boundAction, kept } = useKeptFields<ProposeReturnFormState>(action);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);
  const [step, setStep] = useState(1);

  if (state.success) {
    return (
      <LnSuccessScreen
        title={`Propuesta enviada${petName ? ` para ${petName}` : ""}`}
        description="El dueño recibió una notificación para confirmar la devolución. La custodia sigue con tu org hasta que acepte."
        next={[
          {
            label: "Volver al panel de la organización",
            href: `/org/${orgToken}`,
          },
          {
            label: petName ? `Ver ficha de ${petName}` : "Ver ficha",
            href: `/org/${orgToken}/mascotas/${petPublicToken}`,
            variant: "secondary",
          },
        ]}
      />
    );
  }

  return (
    <form action={formAction}>
      <LnWizardShell
        currentStep={step}
        totalSteps={TOTAL_STEPS}
        stepLabels={STEP_LABELS}
        onBack={step > 1 ? () => setStep((s) => s - 1) : undefined}
      >
        {/* Step 1 — Identidad */}
        <section
          className={step === 1 ? "space-y-4" : "sr-only"}
          aria-hidden={step !== 1}
          inert={step !== 1 ? true : undefined}
        >
          <div className="rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card p-4">
            <p className="text-sm uppercase tracking-wider text-ln-op-mute">Vas a devolver</p>
            <p className="mt-1 text-lg font-semibold text-ln-op-ink">{petName ?? "Esta mascota"}</p>
            <p className="mt-2 text-sm text-ln-op-mute">
              Token: <span className="font-ln-mono">{petPublicToken}</span>
            </p>
          </div>
          <p className="text-md text-ln-op-ink-2">
            Confirmá que esta es la mascota correcta. Si tenés acceso al chip o foto del dueño, te
            recomendamos hacer el cross-check antes de continuar.
          </p>
          <OpButton type="button" onClick={() => setStep(2)} block>
            Continuar
          </OpButton>
        </section>

        {/* Step 2 — Entrega */}
        <section
          className={step === 2 ? "space-y-4" : "sr-only"}
          aria-hidden={step !== 2}
          inert={step !== 2 ? true : undefined}
        >
          <p className="text-md text-ln-op-ink-2">
            Coordiná lugar y momento de entrega con el dueño antes de enviar la propuesta. Podés
            anotar detalles abajo (opcional) — el dueño los ve cuando recibe la notificación.
          </p>
          <div className="rounded-[var(--radius-md)] border border-ln-op-warn-bd bg-ln-op-warn-bg p-3 text-sm text-ln-op-warn">
            Sugerencia: si no es posible reunirse, dejá un teléfono o canal de contacto en las notas
            de la próxima pantalla.
          </div>
          <OpButton type="button" onClick={() => setStep(3)} block>
            Continuar
          </OpButton>
        </section>

        {/* Step 3 — Confirmar + notes */}
        <section
          className={step === 3 ? "space-y-4" : "sr-only"}
          aria-hidden={step !== 3}
          inert={step !== 3 ? true : undefined}
        >
          <div className="space-y-1">
            <label htmlFor="notes" className="block text-sm font-medium text-ln-op-ink-2">
              Notas para el dueño (opcional)
            </label>
            <OpTextarea
              id="notes"
              name="notes"
              rows={4}
              maxLength={1000}
              defaultValue={kept("notes")}
              placeholder="Ej: El animal está en buen estado, coordinamos horario de búsqueda…"
              className="resize-y"
            />
          </div>

          {state.error && (
            <p className="text-sm rounded-[var(--radius-md)] border border-ln-op-danger-bd bg-ln-op-danger-bg px-3 py-2 text-ln-op-danger">
              {state.error}
            </p>
          )}

          <OpButton type="submit" disabled={isPending} variant="ok" block>
            {isPending ? "Enviando…" : "Confirmar propuesta"}
          </OpButton>
        </section>
      </LnWizardShell>
    </form>
  );
}

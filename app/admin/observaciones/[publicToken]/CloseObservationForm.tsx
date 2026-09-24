"use client";

import { useActionState, useState } from "react";

import { LnCheckbox, LnField, LnInput, LnSelect, LnTextarea } from "@/components/ui/Field";
import { OpButton } from "@/components/ui/dashboard";
import {
  POSITIVE_RABIES_OUTCOME,
  RABIES_CONFIRMATION_WORD,
  canSubmitObservationClose,
} from "@/lib/domain/destructive-confirmation";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import type { ProfessionalCloseResult } from "@/src/modules/surveillance/actions";

type FormAction = (formData: FormData) => Promise<ProfessionalCloseResult>;

/**
 * What a settled submit leaves behind. `navigating` is the success case: the
 * close committed and the page is on its way out, so the button must not flip
 * back to idle (see the note in the action below).
 */
type CloseFormState = { error: string | null; navigating: boolean };

const INITIAL_STATE: CloseFormState = { error: null, navigating: false };

export function CloseObservationForm({
  action,
  negativeLockedUntil,
  deadLockedUntil,
  withholdLostToFollowup = false,
}: {
  action: FormAction;
  /**
   * Set when THIS closer may not record a negative yet: a veterinarian before
   * the observation window ends (PO decision 2026-09-18). It is the date the
   * negative becomes available, already worded by the server.
   *
   * The server refuses that close on its own — this only keeps the form from
   * offering, as if it were available, something that would bounce. The State's
   * closers never pass it: they keep the power to close negative early.
   */
  negativeLockedUntil?: string;
  /**
   * Veterinary door only (PO D1, 2026-09-18): the date a bare "Fallecido"
   * close becomes available here. Before it, the vet records the death itself
   * with "Registrar muerte durante la observación" (PO D8), which closes the
   * observation and alerts the authority; the server refuses the bare close.
   */
  deadLockedUntil?: string;
  /**
   * Veterinary door only (PO D1): "sin seguimiento" is never offered — the
   * animal is at the clinic, so the server refuses it at any time. The option
   * is removed and the hint says why.
   */
  withholdLostToFollowup?: boolean;
}) {
  const [outcome, setOutcome] = useState("");
  const [typedConfirmation, setTypedConfirmation] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);

  // React 19 resets a `<form action>` when the action settles, errors included:
  // the outcome select fell back to "Elegí un resultado" and the closing notes
  // were wiped, so an operator whose close bounced lost what they had written
  // about the animal. useKeptFields re-seeds both from what was submitted.
  const { boundAction, kept } = useKeptFields<CloseFormState>(async (_prev, formData) => {
    const result = await action(formData);
    if (result.error) {
      // THE POSITIVE-RABIES CONFIRMATION IS ASKED AGAIN after a failed close.
      // The checkbox cannot be kept — the reset puts a controlled checkbox back
      // to its value at mount (measured in the reset contract test) — and a
      // state that still said "acknowledged" under an unticked box would enable
      // the button behind the operator's back. Both halves reset together so the
      // gate reads the same as the screen.
      setTypedConfirmation("");
      setAcknowledged(false);
      return { error: result.error, navigating: false };
    }
    // The action does not redirect on its own (the App Router drops a server
    // action's redirect in production — lib/ui/full-page-action-nav.ts); it
    // hands the destination back and the client navigates here. `navigating`
    // keeps the button busy across the navigation so the form never flips back
    // to idle after a close that already committed. QA ronda 5 (2026-07-16): the
    // close worked, the form stayed put, and the operator had no way to tell it
    // had worked.
    if (result.redirectTo) {
      navigateAfterActionSuccess(result.redirectTo);
      return { error: null, navigating: true };
    }
    return { error: null, navigating: false };
  });
  const [state, formAction, isPending] = useActionState(boundAction, INITIAL_STATE);
  const busy = isPending || state.navigating;

  const isPositiveRabies = outcome === POSITIVE_RABIES_OUTCOME;
  const canSubmit = canSubmitObservationClose({ outcome, typedConfirmation, acknowledged });
  const keptOutcome = kept("outcome");

  // Why an option is disabled or missing, in the words the server would use.
  // Joined into the one field hint so the reasons read where the choice is made.
  const outcomeHint = [
    negativeLockedUntil
      ? `El resultado negativo se habilita cuando termina el período de observación, el ${negativeLockedUntil}: los signos de rabia pueden aparecer hasta el último día.`
      : null,
    deadLockedUntil
      ? `Si el animal murió durante la observación, usá “Registrar muerte durante la observación”, más abajo: registra el fallecimiento, cierra la observación y avisa de urgencia a la autoridad sanitaria. “Fallecido” sin registrar la muerte se habilita desde el ${deadLockedUntil}.`
      : null,
    withholdLostToFollowup
      ? "“Sin seguimiento” no se registra desde la clínica: el animal está con vos. Si el dueño deja de traerlo, avisá a la autoridad sanitaria de tu localidad."
      : null,
  ]
    .filter((line): line is string => line !== null)
    .join(" ");

  return (
    <form action={formAction} className="space-y-4">
      <LnField label="Resultado" required hint={outcomeHint || undefined}>
        {({ id, describedBy, invalid }) => (
          <LnSelect
            // The key REMOUNTS the select when a submit settles with a new
            // value: only the mount path writes the `selected` attribute the
            // reset restores from (see useKeptFields).
            key={`outcome-${keptOutcome}`}
            id={id}
            name="outcome"
            required
            defaultValue={keptOutcome}
            onChange={(e) => {
              setOutcome(e.target.value);
              // Reset the friction gate when the operator changes outcome.
              setTypedConfirmation("");
              setAcknowledged(false);
            }}
            aria-describedby={describedBy}
            invalid={invalid}
          >
            <option value="" disabled>
              Elegí un resultado
            </option>
            <option value="negative" disabled={negativeLockedUntil !== undefined}>
              {negativeLockedUntil
                ? `Negativo — disponible desde el ${negativeLockedUntil}`
                : "Negativo — animal sano tras observación"}
            </option>
            <option value="positive_rabies">
              {"POSITIVO — rabia confirmada o fuertemente sospechada"}
            </option>
            <option value="dead" disabled={deadLockedUntil !== undefined}>
              {deadLockedUntil
                ? `Fallecido — disponible desde el ${deadLockedUntil}`
                : "Fallecido — fallecimiento durante la observación"}
            </option>
            {!withholdLostToFollowup && (
              <option value="lost_to_followup">
                {"Sin seguimiento — animal perdido o sin contacto"}
              </option>
            )}
          </LnSelect>
        )}
      </LnField>

      {/* C6 — typed confirmation for the public-health critical outcome. */}
      {isPositiveRabies && (
        <div className="space-y-3 rounded-[var(--radius-md)] border border-ln-op-danger-bd bg-ln-op-danger-bg p-3">
          <p className="text-sm font-semibold text-ln-op-danger">
            {"Confirmar rabia positiva dispara notificaciones de salud pública."}
          </p>
          <LnField
            label={`Escribí "${RABIES_CONFIRMATION_WORD}" para confirmar`}
            hint="O marcá la casilla de reconocimiento de impacto."
          >
            {({ id, describedBy }) => (
              <LnInput
                id={id}
                value={typedConfirmation}
                onChange={(e) => setTypedConfirmation(e.target.value)}
                placeholder={RABIES_CONFIRMATION_WORD}
                aria-describedby={describedBy}
                autoComplete="off"
              />
            )}
          </LnField>
          <LnCheckbox
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            labelClassName="text-xs! text-ln-op-danger!"
          >
            {
              "Entiendo que confirmar un resultado positivo de rabia notifica a las autoridades de salud pública y al dueño."
            }
          </LnCheckbox>
        </div>
      )}

      <LnField label="Notas de cierre">
        {({ id, describedBy, invalid }) => (
          <LnTextarea
            id={id}
            name="closureNotes"
            rows={4}
            defaultValue={kept("closureNotes")}
            placeholder="Ej: confirmación clínica negativa tras examen y sin síntomas a día 10."
            aria-describedby={describedBy}
            invalid={invalid}
          />
        )}
      </LnField>

      {state.error && (
        <p className="text-sm text-ln-op-danger" role="alert">
          {state.error}
        </p>
      )}

      {/* Non-silent gate: the positive-rabies close stays disabled until the
          operator clears the friction step above. Without this hint the disabled
          button reads as a silent no-op (nothing happens, no explanation). */}
      {isPositiveRabies && !canSubmit && (
        <output className="block text-xs text-ln-op-danger">
          {`Para habilitar el cierre POSITIVO, escribí "${RABIES_CONFIRMATION_WORD}" o marcá la casilla de reconocimiento de arriba.`}
        </output>
      )}

      <OpButton type="submit" disabled={busy || !canSubmit} variant="primary" block>
        {busy ? "Cerrando..." : "Cerrar observación"}
      </OpButton>
    </form>
  );
}

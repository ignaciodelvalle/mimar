"use client";

// VisitCard — "Iniciar atención" / "Terminar atención" (vet-visit-record).
//
// The explicit door to a visit. It is a convenience, never a gate: any Atender
// writer opens the signer's visit on its own (en la clínica, or the linked
// appointment's modality) when none is open, so a vet who skips this card
// loses nothing but the choice of modality. What it adds is exactly that
// choice — en la clínica o a domicilio — plus the appointment being attended,
// both fixed BEFORE the first record (the modality freezes once the visit
// carries an event).
//
// Server-rendered data only: the page resolves the open visit and the pet's
// appointments around now; both actions arrive bound, the visit id as an
// argument, never as a form field.

import { useActionState } from "react";

import { LnField, LnRadio, LnRadioGroup, LnSelect } from "@/components/ui/Field";
import { OpButton, OpCard, OpCardBody, OpCardHead } from "@/components/ui/dashboard";
import { VISIT_MODALITY_LABELS } from "@/lib/domain/visit-labels";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import type { EventFormState } from "@/src/modules/events/actions";

type FormAction = (prev: EventFormState, formData: FormData) => Promise<EventFormState>;
const initialState: EventFormState = { error: null };

export type VisitCardVisit = {
  modality: "clinic" | "home";
  /** Preformatted in AR time by the page ("10:32"). */
  openedAtLabel: string;
};

export type VisitCardAppointment = {
  id: string;
  /** Preformatted by the page ("Consulta · 10:30 · A domicilio"). */
  label: string;
  modality: "clinic" | "home";
};

export function VisitCard({
  visit,
  appointments,
  startAction,
  closeAction,
}: {
  visit: VisitCardVisit | null;
  appointments: VisitCardAppointment[];
  startAction: FormAction;
  /** Null when there is no open visit to close. */
  closeAction: FormAction | null;
}) {
  // A refused start keeps what was picked (React 19 resets a form after its
  // action): the radios and the select re-seed from the submission.
  const { boundAction, kept, keptChecked } = useKeptFields<EventFormState>(startAction);
  const [startState, start, starting] = useActionState(boundAction, initialState);
  const [closeState, close, closing] = useActionState(
    closeAction ?? (async () => initialState),
    initialState,
  );
  // Both actions answer `redirectTo` and the page reloads as a full document
  // (N3 contract): revalidating the route the card sits on never commits in a
  // production build, and the button stayed disabled forever.
  const startNavigating = useActionRedirect(startState.redirectTo, startState);
  const closeNavigating = useActionRedirect(closeState.redirectTo, closeState);

  if (visit && closeAction) {
    return (
      <OpCard>
        <OpCardHead title="Atención en curso" />
        <OpCardBody>
          <form action={close} className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-ln-op-ink-2">
              {VISIT_MODALITY_LABELS[visit.modality]} · desde las {visit.openedAtLabel}. Todo lo que
              registres queda agrupado en esta atención.
            </p>
            <OpButton type="submit" variant="ghost" size="sm" loading={closing || closeNavigating}>
              Terminar atención
            </OpButton>
          </form>
          {closeState.error && (
            <p role="alert" className="mt-2 text-sm text-ln-op-danger">
              {closeState.error}
            </p>
          )}
        </OpCardBody>
      </OpCard>
    );
  }

  // A linked appointment already says where the care is; default to it.
  const defaultModality = appointments[0]?.modality ?? "clinic";

  return (
    <OpCard>
      <OpCardHead title="Iniciar atención" />
      <OpCardBody>
        <form action={start} className="space-y-4">
          <LnRadioGroup
            key={`modality-${kept("modality")}`}
            legend="¿Dónde es la atención?"
            required
            optionsClassName="flex flex-wrap gap-4"
          >
            {(Object.keys(VISIT_MODALITY_LABELS) as Array<"clinic" | "home">).map((m) => (
              <LnRadio
                key={m}
                name="modality"
                value={m}
                defaultChecked={keptChecked("modality", m === defaultModality, m)}
              >
                {VISIT_MODALITY_LABELS[m]}
              </LnRadio>
            ))}
          </LnRadioGroup>
          {appointments.length > 0 && (
            <LnField label="Turno que estás atendiendo">
              {({ id, describedBy, invalid }) => (
                <LnSelect
                  key={`appointmentId-${kept("appointmentId")}`}
                  id={id}
                  name="appointmentId"
                  defaultValue={kept("appointmentId", appointments[0]?.id ?? "")}
                  aria-describedby={describedBy}
                  invalid={invalid}
                >
                  <option value="">Sin turno</option>
                  {appointments.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </LnSelect>
              )}
            </LnField>
          )}
          {startState.error && (
            <p role="alert" className="text-sm text-ln-op-danger">
              {startState.error}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <OpButton
              type="submit"
              variant="primary"
              size="sm"
              loading={starting || startNavigating}
            >
              Iniciar atención
            </OpButton>
            <p className="text-xs text-ln-op-mute">
              Si no la iniciás, se abre sola en la clínica con el primer registro.
            </p>
          </div>
        </form>
      </OpCardBody>
    </OpCard>
  );
}

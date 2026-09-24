"use client";

import { useActionState, useState } from "react";

import { type UpgradeFormState, requestVetUpgradeAction } from "@/app/actions/upgrade";
import { LocationFields } from "@/components/LocationFields";
import { LnField, LnInput } from "@/components/ui/Field";

const initialState: UpgradeFormState = { error: null };

// DNI_PREREQ_URL: canonical ?next= pattern so the user lands back here after
// declaring their DNI. Kept here so it matches the server-action value exactly.
const DNI_PREREQ_URL = "/cuenta/verificar-dni?next=/cuenta/upgrade";

type Props = {
  /**
   * Whether the current user has already declared their DNI.
   * Passed from the server page — checked before rendering the form so the
   * requirement is visible BEFORE the user fills any fields.
   */
  dniVerified: boolean;
};

export function VetUpgradeForm({ dniVerified }: Props) {
  const [state, formAction, pending] = useActionState(requestVetUpgradeAction, initialState);

  // Controlled field values — preserved across server-side validation errors so
  // the user doesn't lose what they typed when e.g. the matrícula format fails.
  const [matriculaNumber, setMatriculaNumber] = useState("");
  const [matriculaJurisdiccion, setMatriculaJurisdiccion] = useState("");
  const [especialidad, setEspecialidad] = useState("");
  const [anosExperiencia, setAnosExperiencia] = useState("");

  if (state.ok) {
    return (
      <p className="text-sm rounded-[var(--radius-sm)] border border-[var(--color-ln-warn)] bg-[var(--color-ln-warn-050)] px-3 py-2 text-[var(--color-ln-warn)]">
        Solicitud enviada — pendiente de revisión por el equipo de miMAR.
      </p>
    );
  }

  // Show requirement UP FRONT: if DNI is not declared, gate the form entirely.
  // The server action also checks this, but surfacing it here avoids making the
  // user fill the form only to discover the blocker on submit.
  const missingDni = !dniVerified || (state.missingPrereq === "dni" && Boolean(state.prereqUrl));

  if (missingDni) {
    return (
      <div className="space-y-3">
        {/* Requirements panel */}
        <div className="rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] px-4 py-3">
          <p className="text-sm font-semibold uppercase tracking-[.08em] text-[var(--color-ln-mute)]">
            Requisitos para convertirte en profesional
          </p>
          <ul className="mt-2 space-y-1.5">
            <li className="flex items-center gap-2 text-md text-[var(--color-ln-ink-2)]">
              {/* X — not met */}
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="shrink-0 text-[var(--color-ln-err)]"
                aria-hidden="true"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
              DNI declarado
            </li>
          </ul>
        </div>

        {/* CTA */}
        <div className="rounded-[var(--radius-sm)] border border-[var(--color-ln-warn)] bg-[var(--color-ln-warn-050)] p-4 space-y-2">
          <p className="text-sm font-medium text-[var(--color-ln-warn)]">
            Antes de enviar tu solicitud, declará tu DNI.
          </p>
          <p className="text-xs text-[var(--color-ln-warn)]">
            miMAR requiere que declares tu DNI antes de procesar solicitudes de rol profesional.
          </p>
          <a
            href={state.prereqUrl ?? DNI_PREREQ_URL}
            className="inline-block mt-1 px-4 py-2 rounded-[var(--radius-pill)] bg-[var(--color-ln-warn)] text-white text-sm font-medium hover:opacity-90 transition-colors"
          >
            Declarar DNI →
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Requirements met indicator */}
      <div className="rounded-[var(--radius-sm)] border border-[var(--color-ln-ok-100)] bg-[var(--color-ln-ok-050)] px-4 py-3">
        <p className="text-sm font-semibold uppercase tracking-[.08em] text-[var(--color-ln-mute)]">
          Requisitos para convertirte en profesional
        </p>
        <ul className="mt-2 space-y-1.5">
          <li className="flex items-center gap-2 text-md text-[var(--color-ln-ink-2)]">
            {/* Checkmark — met */}
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="shrink-0 text-[var(--color-ln-ok)]"
              aria-hidden="true"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
            DNI declarado
          </li>
        </ul>
      </div>

      <form action={formAction} className="space-y-4">
        <LnField
          label="Número de matrícula"
          required
          hint="Tal como figura en tu credencial profesional. Ej: MN-12345"
        >
          {({ id, describedBy, invalid }) => (
            <LnInput
              id={id}
              name="matriculaNumber"
              type="text"
              required
              aria-describedby={describedBy}
              invalid={invalid}
              value={matriculaNumber}
              onChange={(e) => setMatriculaNumber(e.target.value)}
            />
          )}
        </LnField>
        <LnField
          label="Provincia de la matrícula"
          required
          hint="Dónde fue emitida tu matrícula. Ej: CABA, Buenos Aires, Córdoba"
        >
          {({ id, describedBy, invalid }) => (
            <LnInput
              id={id}
              name="matriculaJurisdiccion"
              type="text"
              required
              aria-describedby={describedBy}
              invalid={invalid}
              value={matriculaJurisdiccion}
              onChange={(e) => setMatriculaJurisdiccion(e.target.value)}
            />
          )}
        </LnField>
        <div className="space-y-1.5">
          {/* Single label owned by LocationFields (l1Label) — no redundant
              outer heading (#43 item 4). Free text is normalized against the
              INDEC catalog server-side; the picker assists selection. */}
          <LocationFields mode="l1" l1Label="Localidad donde ejercés" required cascade />
          <p className="text-xs text-[var(--color-ln-mute)]">
            Para enrutar tu verificación al gobierno correspondiente. Requerido.
          </p>
        </div>
        <LnField label="Especialidad (opcional)" hint="Ej: Clínica, cirugía, exóticos.">
          {({ id, describedBy, invalid }) => (
            <LnInput
              id={id}
              name="especialidad"
              type="text"
              aria-describedby={describedBy}
              invalid={invalid}
              value={especialidad}
              onChange={(e) => setEspecialidad(e.target.value)}
            />
          )}
        </LnField>
        <LnField label="Años de experiencia (opcional)">
          {({ id, describedBy, invalid }) => (
            <LnInput
              id={id}
              name="anosExperiencia"
              type="number"
              inputMode="numeric"
              aria-describedby={describedBy}
              invalid={invalid}
              value={anosExperiencia}
              onChange={(e) => setAnosExperiencia(e.target.value)}
            />
          )}
        </LnField>

        {state.error && (
          <p className="text-sm text-[var(--color-ln-err)]" role="alert">
            {state.error}
          </p>
        )}

        <button
          type="submit"
          disabled={pending}
          className="w-full px-4 py-3 rounded-[var(--radius-pill)] bg-[var(--color-ln-azul)] text-white font-medium hover:bg-[var(--color-ln-azul-700)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {pending ? "Enviando solicitud..." : "Enviar solicitud de verificación"}
        </button>
      </form>
    </div>
  );
}

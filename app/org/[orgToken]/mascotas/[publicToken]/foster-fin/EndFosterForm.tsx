"use client";

// Ending a foster stay closes a custody arrangement and lands an append-only
// event — irreversible, so it gates behind a ConfirmDialog that states the
// consequence (D.3 clase 1, 2026-07-30: until then this fired straight off the
// submit button). The button keeps the verb of the act, "Cerrar tránsito".
//
// The dialog gates the SUBMIT, not the action: the real <form action> +
// useActionState wiring is untouched, and confirming calls requestSubmit() on
// it. Keeping the form as the single submission path means the server action,
// its pending state and its error rendering behave exactly as before.

import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { OpButton, OpTextarea } from "@/components/ui/dashboard";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import { type EndFosterFormState, endFosterAction } from "@/src/modules/foster/actions";
import { useActionState, useRef, useState } from "react";

const initialState: EndFosterFormState = { error: null };

const ENDED_BY_OPTIONS = [
  { value: "shelter", label: "Decisión del refugio" },
  { value: "foster_returned", label: "El tránsito devolvió al animal" },
  { value: "other", label: "Otro motivo" },
] as const;

export function EndFosterForm({
  orgToken,
  publicToken,
  fosterName,
}: {
  orgToken: string;
  publicToken: string;
  fosterName: string | null;
}) {
  const action = endFosterAction.bind(null, orgToken, publicToken);
  // THE RESET MISATTRIBUTES THE ACT. React 19 resets a `<form action>` when
  // the action settles, error included, and this radio group falls back to
  // `shelter`. So an operator who recorded that the FOSTER family ended the
  // arrangement gets it quietly reassigned to the organisation — on an event
  // this form itself calls immutable a few lines below. Nobody reads a radio
  // twice; they read the error and press the button again.
  //
  // T4-F1 batch 2: `reason` below had NO defaultValue at all (a bare
  // uncontrolled field) and shared the same reset — the "motivo" the operator
  // typed vanished right alongside the misattributed radio.
  const { boundAction, kept, keptChecked } = useKeptFields(action);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);
  const [confirming, setConfirming] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <form ref={formRef} action={formAction} className="space-y-4">
      <p className="text-md text-ln-op-ink-2">
        Vas a cerrar el tránsito{fosterName ? ` de ${fosterName}` : ""}. El animal vuelve a figurar
        solo en custodia del refugio. Esta acción queda en el historial como evento inmutable.
      </p>

      <fieldset className="space-y-1">
        <legend className="text-sm font-medium text-ln-op-ink">¿Quién finalizó el tránsito?</legend>
        <div className="flex flex-col gap-1 text-md text-ln-op-ink-2">
          {ENDED_BY_OPTIONS.map((option) => (
            <label key={option.value} className="flex items-center gap-2">
              <input
                type="radio"
                name="endedBy"
                value={option.value}
                defaultChecked={keptChecked("endedBy", option.value === "shelter", option.value)}
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>

      {/* Explicit htmlFor rather than wrapping: the control is a component now,
          so implicit association is invisible to static analysis (and to some
          AT/browser combinations that only follow the explicit link). */}
      <div className="space-y-1">
        <label className="block text-sm text-ln-op-mute" htmlFor="end-foster-reason">
          Motivo (opcional)
        </label>
        <OpTextarea
          id="end-foster-reason"
          name="reason"
          rows={3}
          maxLength={500}
          defaultValue={kept("reason")}
          placeholder="Notas para el historial. El tránsito recibe el mensaje."
        />
      </div>

      {state.error && (
        <p className="text-sm rounded-[var(--radius-md)] border border-ln-op-danger-bd bg-ln-op-danger-bg px-3 py-2 text-ln-op-danger">
          {state.error}
        </p>
      )}

      <OpButton
        ref={triggerRef}
        type="button"
        disabled={isPending}
        variant="danger"
        onClick={() => setConfirming(true)}
      >
        {isPending ? "Cerrando…" : "Cerrar tránsito"}
      </OpButton>

      <ConfirmDialog
        open={confirming}
        onClose={() => !isPending && setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          formRef.current?.requestSubmit();
        }}
        title="Cerrar el tránsito"
        description={`Esto cierra el tránsito${fosterName ? ` de ${fosterName}` : ""}: el animal vuelve a figurar solo en custodia del refugio y el cierre queda en el historial como evento inmutable.`}
        confirmLabel="Cerrar tránsito"
        tone="danger"
        pending={isPending}
        triggerRef={triggerRef}
      />
    </form>
  );
}

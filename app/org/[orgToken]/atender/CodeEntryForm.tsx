"use client";

// Walk-in DIM code entry. The vet types the code printed on the physical
// credential the owner shows; on success the action returns `redirectTo` the
// signing surface (full-document nav, N3 redirect contract).

import { useActionState, useEffect, useRef, useState } from "react";

import { OpField, OpFormAlert, OpInput, OpSubmitButton } from "@/components/ui/dashboard/OpField";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import type { EventFormState } from "@/src/modules/events/actions";

type FormAction = (prev: EventFormState, formData: FormData) => Promise<EventFormState>;

const initialState: EventFormState = { error: null };

export function CodeEntryForm({ action }: { action: FormAction }) {
  // forms/react19-reset-data-loss-inventory: "code" is a bare uncontrolled
  // field — a rejected lookup (e.g. code not found) wipes what the vet typed.
  const { boundAction, kept } = useKeptFields<EventFormState>(action);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);
  useActionRedirect(state.redirectTo, state);

  // A3: clear the previous attempt's error the moment the operator edits the
  // code (onChange), so a fresh lookup starts clean instead of showing a stale
  // failure under a new code. Each submission returns a NEW result object, so a
  // fresh result re-arms the alert — keyed on result identity (not on isPending,
  // which React can batch away when an action resolves synchronously).
  const [errorDismissed, setErrorDismissed] = useState(false);
  const lastResultRef = useRef(state);
  useEffect(() => {
    if (lastResultRef.current !== state) {
      lastResultRef.current = state;
      setErrorDismissed(false);
    }
  }, [state]);

  const showError = Boolean(state.error) && !errorDismissed && !isPending;

  // C1 (cursor citizen UX, 2026-07-24): the success branch used to render
  // NOTHING — the redirect happens via a client effect (N3), so any hiccup in
  // the assign left the vet on a blank same-page with zero feedback. A visible
  // "opening" line makes success observable even while the navigation lands.
  const showSuccess = Boolean(state.redirectTo) && !state.error && !isPending;

  return (
    <form action={formAction} className="space-y-4">
      {showError && <OpFormAlert>{state.error}</OpFormAlert>}
      {showSuccess && (
        <output className="block text-sm text-ln-op-ink-2">
          Mascota encontrada — abriendo la libreta…
        </output>
      )}
      <OpField
        label="Código de la credencial (DIM-XXXX-XXXX)"
        hint="Ingresá el código de la credencial que te muestra el dueño para registrar un evento clínico."
        required
      >
        {({ id, describedBy }) => (
          <OpInput
            id={id}
            name="code"
            required
            autoFocus
            autoComplete="off"
            spellCheck={false}
            defaultValue={kept("code")}
            placeholder="DIM-XXXX-XXXX"
            className="font-ln-mono uppercase tracking-wider"
            aria-describedby={describedBy}
            aria-invalid={showError || undefined}
            onChange={() => setErrorDismissed(true)}
          />
        )}
      </OpField>
      <OpSubmitButton pending={isPending} pendingLabel="Buscando…">
        Buscar mascota
      </OpSubmitButton>
    </form>
  );
}

"use client";

import { useActionState, useState } from "react";

import { type DniVerifyFormState, verifyDniAction } from "@/app/actions/dni-verification";
import { LnField, LnInput } from "@/components/ui/Field";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";

const initialState: DniVerifyFormState = { error: null };

export function DniVerifyForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState(verifyDniAction, initialState);
  useActionRedirect(state.ok ? state.next : null, state);
  // forms/react19-reset-data-loss-inventory: `dni` had NO defaultValue at
  // all — a rejected submit (a bad checksum, an already-declared number)
  // wiped whatever the person had typed. Only field on this form, so a
  // controlled input (survives the React 19 post-action reset on its own)
  // is simpler than wiring the whole useKeptFields hook for one field.
  const [dni, setDni] = useState("");

  if (state.ok) {
    return (
      <p className="text-sm rounded-[var(--radius-sm)] border border-[var(--color-ln-ok)] bg-[var(--color-ln-ok-050)] px-3 py-2 text-[var(--color-ln-ok)]">
        DNI declarado. Redirigiendo...
      </p>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      {/* Hidden field passes the validated `next` value through the form cycle. */}
      <input type="hidden" name="next" value={next} />

      {/* TODO(mi-argentina): this form is a placeholder until the real Mi Argentina OAuth
          integration is available. When that lands, this page becomes the OAuth callback
          landing — the user never types their DNI manually. */}
      <LnField
        label="Número de DNI"
        hint="7 u 8 dígitos sin puntos ni espacios."
        error={state.error ?? undefined}
        required
      >
        {({ id, describedBy, invalid }) => (
          <LnInput
            id={id}
            name="dni"
            type="text"
            inputMode="numeric"
            required
            placeholder="Ej: 34567890"
            value={dni}
            onChange={(e) => setDni(e.target.value)}
            aria-describedby={describedBy}
            invalid={invalid}
          />
        )}
      </LnField>

      <button
        type="submit"
        disabled={pending}
        className="w-full px-4 py-3 rounded-[var(--radius-pill)] bg-[var(--color-ln-azul)] text-white font-medium hover:bg-[var(--color-ln-azul-700)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {pending ? "Guardando..." : "Declarar DNI"}
      </button>
    </form>
  );
}

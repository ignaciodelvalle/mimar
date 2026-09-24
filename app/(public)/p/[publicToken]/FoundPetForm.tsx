"use client";

import { type PublicActionState, notifyOwnerOfFoundPetAction } from "@/app/actions/public";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import { useActionState } from "react";

const initialState: PublicActionState = { ok: false, error: null };

export function FoundPetForm({ publicToken }: { publicToken: string }) {
  // ALL THREE FIELDS WERE LOST ON A VALIDATION ERROR, which on this form is all
  // of them: React 19 resets a `<form action>` when its action settles, error
  // included, and none of these were controlled. The person on the other side
  // is a stranger holding somebody's lost dog, with no session and no reason to
  // type it a second time. `useKeptFields` re-seeds from the form's own
  // submitted `FormData`; the measured contract is in
  // `__tests__/react19-form-reset-contract.test.tsx`.
  const { boundAction: keptAction, kept } = useKeptFields(
    notifyOwnerOfFoundPetAction.bind(null, publicToken),
  );
  const [state, formAction, isPending] = useActionState(keptAction, initialState);

  if (state.ok) {
    return (
      <output
        aria-live="polite"
        className="block rounded-lg border border-ln-ok bg-ln-ok/10 p-4 text-sm text-ln-ok"
      >
        <p className="font-medium">¡Gracias!</p>
        <p className="mt-1 text-xs">
          Le avisamos al dueño. Mientras tanto, cuidala lo mejor que puedas.
        </p>
      </output>
    );
  }

  const inputClass =
    "w-full px-3 py-2 rounded-lg border border-ln-warn bg-ln-card text-ln-ink text-sm focus:outline-none focus:ring-2 focus:ring-ln-warn focus:border-transparent";

  // B-2: stable id for the error paragraph so required inputs can reference it
  const errorId = "found-pet-form-error";

  return (
    <form action={formAction} className="space-y-3">
      {/* PO 2026-07-24: name + contact are OPTIONAL (anonymous report allowed)
          — lowering the barrier matters more than a guaranteed callback. One
          explanatory line says why leaving a contact helps, without forcing it. */}
      <div className="space-y-1">
        <label htmlFor="finderName" className="block text-xs font-medium text-ln-warn">
          Tu nombre (opcional)
        </label>
        <input
          id="finderName"
          name="finderName"
          defaultValue={kept("finderName")}
          type="text"
          autoComplete="name"
          placeholder="Nombre y apellido"
          aria-describedby={state.error ? errorId : undefined}
          className={inputClass}
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="finderContact" className="block text-xs font-medium text-ln-warn">
          Cómo te contactamos (opcional)
        </label>
        {/* UX 3.5 item 8a: combined phone-or-email field. inputMode="email"
            surfaces "@"/"." while keeping digits reachable — the best single
            keyboard for either input — without forcing type=tel/email (which
            would reject the other value). Server contract stays one field. */}
        <input
          id="finderContact"
          name="finderContact"
          defaultValue={kept("finderContact")}
          type="text"
          inputMode="email"
          autoComplete="email"
          placeholder="Teléfono o email"
          aria-describedby={state.error ? errorId : undefined}
          className={inputClass}
        />
        <p className="text-xs text-ln-mute">
          Dejar un contacto ayuda a coordinar la entrega, pero no es obligatorio.
        </p>
      </div>

      <div className="space-y-1">
        <label htmlFor="message" className="block text-xs font-medium text-ln-warn">
          Mensaje (opcional)
        </label>
        <textarea
          id="message"
          name="message"
          defaultValue={kept("message")}
          rows={3}
          placeholder="¿Dónde la encontraste? ¿Cómo está?"
          className={inputClass}
        />
      </div>

      {/* B-2: stable id so required inputs above can reference via aria-describedby */}
      {state.error && (
        <p id={errorId} className="text-xs text-ln-err" role="alert">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="w-full px-4 py-2 rounded-lg bg-ln-warn text-white text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {isPending ? "Enviando..." : "Avisar al dueño"}
      </button>
    </form>
  );
}

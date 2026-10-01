"use client";

import { type PublicActionState, notifyOwnerOfFoundPetAction } from "@/app/actions/public";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import { FINDER_CONTACT_REQUIRED, hasReachableContact } from "@/lib/utils/contact-parts";
import { useActionState, useState } from "react";

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
  // The contact is REQUIRED (PO 2026-10-01) and the action refuses without it;
  // this check only spares the finder a round trip. `kept` re-seeds the fields
  // after the server answers, but a client refusal never reaches the action,
  // so nothing is reset and nothing needs re-seeding.
  const [clientError, setClientError] = useState<string | null>(null);
  const shownError = clientError ?? state.error;

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    const contact = new FormData(e.currentTarget).get("finderContact");
    if (!hasReachableContact(typeof contact === "string" ? contact : "")) {
      e.preventDefault();
      setClientError(FINDER_CONTACT_REQUIRED);
      return;
    }
    setClientError(null);
  }

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
    <form action={formAction} onSubmit={handleSubmit} className="space-y-3">
      {/* The name is OPTIONAL (PO 2026-07-24). The contact is REQUIRED (PO
          2026-10-01): without it the owner learned the pet was found and had
          no way to reach whoever found it. */}
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
          aria-describedby={shownError ? errorId : undefined}
          className={inputClass}
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="finderContact" className="block text-xs font-medium text-ln-warn">
          Cómo te contactamos
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
          // aria-required, not `required`: the native bubble speaks the
          // BROWSER's language and fires before handleSubmit, so the es-AR
          // message below would never show for an empty field.
          aria-required="true"
          aria-invalid={clientError ? true : undefined}
          aria-describedby={shownError ? errorId : undefined}
          className={inputClass}
        />
        <p className="text-xs text-ln-mute">
          Es la única forma de que el dueño pueda coordinar la entrega con vos.
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
      {shownError && (
        <p id={errorId} className="text-xs text-ln-err" role="alert">
          {shownError}
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

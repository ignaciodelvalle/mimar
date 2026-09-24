"use client";

// Neutral finder-tip form for a custody-disputed pet (PO decision 2026-07-24).
// Everything except the free-text "¿qué viste?" is optional — the finder can
// stay fully anonymous. Submission is appended to the open dispute case for
// the reviewing authority; it never notifies (and is never shown to) either
// disputing party — the copy says so explicitly, and the server action
// enforces it (see report-dispute-tip.ts).
//
// Styling is deliberately calm/neutral (ln-line borders, azul submit) — this
// is not the urgent amber "found" form: no one is being contacted.

import { LnButton } from "@/components/ui/Button";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import type { PublicActionState } from "@/src/modules/pets/application/public/types";
import { useActionState } from "react";
import { reportDisputeTipAction } from "./dispute-tip-action";

const initialState: PublicActionState = { ok: false, error: null };

export function DisputeTipForm({ publicToken }: { publicToken: string }) {
  // EVERY FIELD HERE WAS LOST ON A VALIDATION ERROR until 2026-09-16, all four
  // of them, from somebody who is not logged in and has no reason to come back.
  // React 19 resets a `<form action>` when its action settles — error included —
  // and none of these were controlled, so the reset emptied the lot. The
  // measured contract is pinned in `__tests__/react19-form-reset-contract.test.tsx`.
  const { boundAction: keptAction, kept } = useKeptFields(
    reportDisputeTipAction.bind(null, publicToken),
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
          Tu información quedó registrada para la autoridad que revisa el caso.
        </p>
      </output>
    );
  }

  const inputClass =
    "w-full px-3 py-2 rounded-lg border border-ln-line-strong bg-ln-card text-ln-ink text-sm focus:outline-none focus:ring-2 focus:ring-ln-azul focus:border-transparent";

  // Stable id so inputs can reference the error paragraph (B-2 pattern).
  const errorId = "dispute-tip-form-error";

  return (
    <form action={formAction} className="space-y-3">
      {/* Says who reads it, never why the routing changed — see
          lib/ui/dispute-copy.ts. "Nadie más" is literally true: the use-case
          inserts a finder_tip case event and CaseDetailView filters those away
          from every non-authority viewer, including both disputing parties. */}
      <p className="text-xs text-ln-mute">
        Esta información la lee solamente la autoridad que revisa la credencial. Nadie más la ve.
      </p>

      <div className="space-y-1">
        <label htmlFor="disputeTipInfo" className="block text-xs font-medium text-ln-ink-2">
          ¿Qué viste?<span className="text-ln-err ml-0.5">*</span>
        </label>
        <textarea
          id="disputeTipInfo"
          name="info"
          defaultValue={kept("info")}
          rows={3}
          required
          maxLength={1000}
          placeholder="Contanos qué viste o qué sabés de esta mascota."
          aria-describedby={state.error ? errorId : undefined}
          className={inputClass}
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="disputeTipLocation" className="block text-xs font-medium text-ln-ink-2">
          ¿Dónde? (opcional)
        </label>
        <input
          id="disputeTipLocation"
          name="locationText"
          defaultValue={kept("locationText")}
          type="text"
          maxLength={200}
          placeholder="Barrio, calle o punto de referencia"
          className={inputClass}
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="disputeTipName" className="block text-xs font-medium text-ln-ink-2">
          Tu nombre (opcional)
        </label>
        <input
          id="disputeTipName"
          name="finderName"
          defaultValue={kept("finderName")}
          type="text"
          autoComplete="name"
          maxLength={80}
          placeholder="Nombre y apellido"
          className={inputClass}
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="disputeTipContact" className="block text-xs font-medium text-ln-ink-2">
          Contacto (opcional)
        </label>
        <input
          id="disputeTipContact"
          name="finderContact"
          defaultValue={kept("finderContact")}
          type="text"
          inputMode="email"
          autoComplete="email"
          maxLength={120}
          placeholder="Teléfono o email"
          className={inputClass}
        />
        <p className="text-xs text-ln-mute">
          Solo la autoridad puede verlo, por si necesita más información.
        </p>
      </div>

      {state.error && (
        <p id={errorId} className="text-xs text-ln-err" role="alert">
          {state.error}
        </p>
      )}

      <LnButton type="submit" variant="primary" block disabled={isPending} className="min-h-11">
        {isPending ? "Enviando..." : "Enviar a la autoridad"}
      </LnButton>
    </form>
  );
}

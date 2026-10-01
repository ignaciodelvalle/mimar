"use client";

// Cancel a trip (viajes-fase-2, task 5.3). Posts to cancelTripAction — a
// correction through amendEvent ({cancelled: true}), the same use-case
// `POST /api/v1/pets/{publicToken}/travel` `cancel_trip` runs.
//
// Two steps, because a cancelled trip cannot be switched back on from here:
// the first press asks, the second confirms.
//
// The form carries two hidden fields and no typed answer, so a React 19 reset
// has nothing to lose (hidden inputs are safe to lint:kept-fields as written).

import { useActionState, useState } from "react";

import { LnButton } from "@/components/ui/Button";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import type { TravelFormState } from "@/src/modules/pets/application/travel/types";

const initialState: TravelFormState = { error: null };

type FormAction = (prev: TravelFormState, formData: FormData) => Promise<TravelFormState>;

export function CancelTripButton({
  action,
  tripEventId,
  tripLabel,
  idempotencyKey,
}: {
  action: FormAction;
  tripEventId: string;
  /** e.g. "Chile, 12/11/2026" — named in the question. */
  tripLabel: string;
  idempotencyKey: string;
}) {
  const [state, formAction, isPending] = useActionState(action, initialState);
  const [confirming, setConfirming] = useState(false);
  // The page reloads as a full document without the trip (N3 contract).
  const navigating = useActionRedirect(state.redirectTo, state);
  const busy = isPending || navigating;

  if (!confirming) {
    return (
      <LnButton type="button" variant="ghost" size="sm" onClick={() => setConfirming(true)}>
        Cancelar este viaje
      </LnButton>
    );
  }

  return (
    <form
      action={formAction}
      className="flex flex-col gap-2.5 rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] p-3"
    >
      <input type="hidden" name="tripEventId" value={tripEventId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <p className="text-sm">
        ¿Cancelar el viaje a {tripLabel}? Deja de figurar en esta pantalla y en el semáforo.
      </p>
      {state.error && (
        <p className="font-ln-mono text-sm text-[var(--color-ln-err)]" role="alert">
          {state.error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <LnButton type="submit" variant="seal" size="sm" loading={busy}>
          Confirmar cancelación
        </LnButton>
        <LnButton
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => setConfirming(false)}
        >
          Volver
        </LnButton>
      </div>
    </form>
  );
}

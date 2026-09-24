"use client";

// The titular's two levers over a caretaker grant.
//
// They are DIFFERENT FACTS and the component keeps them apart on purpose:
//
//   - `pending`  → CANCEL. Nothing ever started; no spine event is written and
//     nobody lost access, because nobody had any.
//   - `active`   → REVOKE. A real arrangement ends, `caretaker_ended` is
//     appended with `outcome='revoked_by_owner'`, and another person's access
//     disappears without their consent. The spec grants the titular exactly
//     that power; the confirmation step is what keeps it from firing by
//     accident.
//
// THE CONFIRMATION COPY IS LOAD-BEARING. Ending the grant ends ACCESS. The
// animal may still be at the caretaker's house, and a titular who reads
// "finalizar" as "get my pet back" has been misled by their own credential. The
// dialog says which of the two just happened.

import { useState, useTransition } from "react";

import { LnButton } from "@/components/ui/Button";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";
import {
  cancelCaretakerGrantAction,
  revokeCaretakerGrantAction,
} from "@/src/modules/caretakers/actions";

type Props = {
  petPublicToken: string;
  petName: string;
  grantToken: string;
  /** Display name of the caretaker, or the invited email while pending. */
  caretakerLabel: string;
  kind: "active" | "pending";
};

export function CaretakerGrantControls({
  petPublicToken,
  petName,
  grantToken,
  caretakerLabel,
  kind,
}: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  function run() {
    setError(null);
    startTransition(async () => {
      const result =
        kind === "active"
          ? await revokeCaretakerGrantAction({ petPublicToken, grantToken })
          : await cancelCaretakerGrantAction({ petPublicToken, grantToken });
      if ("error" in result) {
        setError(result.error);
        setConfirming(false);
        return;
      }
      // Full document reload so this page's SSR caretaker state matches the DB
      // (router.refresh() is banned — lib/ui/full-page-action-nav.ts).
      navigateAfterActionSuccess(window.location.href);
    });
  }

  const triggerLabel = kind === "active" ? "Finalizar el cuidado ahora" : "Retirar la invitación";
  const confirmLabel = kind === "active" ? "Confirmar la finalización" : "Confirmar el retiro";

  return (
    <div className="space-y-3">
      {error && <output className="block text-sm text-[var(--color-ln-err)]">{error}</output>}

      {confirming ? (
        <div className="space-y-3 rounded-[var(--radius-sm)] border border-[var(--color-ln-seal)] bg-[var(--color-ln-err-050)] p-4">
          {kind === "active" ? (
            <p className="m-0 text-md leading-snug text-[var(--color-ln-ink-2)]">
              {caretakerLabel} pierde el acceso a {petName} en este momento y deja de recibir los
              avisos. Si {petName} sigue en su casa, esto no la trae de vuelta: vas a tener que
              coordinar la devolución igual.
            </p>
          ) : (
            <p className="m-0 text-md leading-snug text-[var(--color-ln-ink-2)]">
              La invitación a {caretakerLabel} se retira y el link deja de servir. Nunca tuvo acceso
              a {petName}, así que no pierde nada; si querés, después podés invitarla de nuevo.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <LnButton variant="seal" onClick={run} disabled={pending}>
              {pending ? "Procesando…" : confirmLabel}
            </LnButton>
            <LnButton variant="ghost" onClick={() => setConfirming(false)} disabled={pending}>
              Volver
            </LnButton>
          </div>
        </div>
      ) : (
        <LnButton variant="seal" onClick={() => setConfirming(true)}>
          {triggerLabel}
        </LnButton>
      )}
    </div>
  );
}

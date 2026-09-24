"use client";

// ReactivateAccountCard — the control that makes the deactivated state a
// decision rather than a dead end.
//
// It replaces the "Zona de riesgo" block on /cuenta while the account is off,
// and the swap is deliberate: offering "Desactivar mi cuenta" to somebody whose
// account is already deactivated is a button that can only tell them no, and
// the one thing they came here to do would not be on the page at all.
//
// NO CONFIRMATION DIALOG, and the asymmetry with DeactivateAccountDialog is the
// point. That one demands a written motivo because it takes something away and
// the person cannot undo it without finding this screen. This one gives it
// back, its worst case is that somebody reactivates an account they meant to
// leave off — which they can switch off again, two rows below, in one click.
// A confirmation step here would be friction charged for the safe direction.
//
// Copy tone: this is not an error state and must never read as one. The person
// did this on purpose, and the card tells them so before it offers the way out.

import { useState, useTransition } from "react";

import { selfReactivatePersonalAccountAction } from "@/app/actions/profile-self-service";
import { LnButton } from "@/components/ui/Button";
import { LnCard, LnCardBody, LnCardHead } from "@/components/ui/Card";

export function ReactivateAccountCard() {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleReactivate() {
    setError(null);
    startTransition(async () => {
      const result = await selfReactivatePersonalAccountAction();
      if ("error" in result) {
        setError(result.error);
        return;
      }
      // Full reload rather than a router refresh: the deactivated state is read
      // in the LAYOUT (the shell banner) as well as on this page, and the
      // layout's profile read is request-cached. A hard navigation is the
      // honest way to make every surface agree on the new state at once.
      window.location.replace("/cuenta");
    });
  }

  return (
    <LnCard className="mb-8 border-[var(--color-ln-warn)]">
      <LnCardHead title="Tu cuenta está desactivada" />
      <LnCardBody>
        <p className="text-md text-[var(--color-ln-ink-2)]">
          Vos la desactivaste. Tus mascotas y tu historial siguen guardados y podés seguir
          mirándolos, pero mientras esté desactivada no vamos a registrar cambios: ni eventos
          nuevos, ni traspasos, ni turnos.
        </p>
        <p className="mt-2.5 text-md text-[var(--color-ln-ink-2)]">
          Cuando quieras volver, activala de nuevo acá mismo. No hace falta que escribas a nadie.
        </p>
        {/* LnButton, not a hand-rolled <button>. The first draft wrote the
            azul, the pill radius and the sizing by hand and tripped two
            ratchets in a row — the design-token one on an off-scale `py-[9px]`,
            then `check-raw-buttons` on the element itself. Both are the same
            defect: the variant map already holds this exact appearance, and a
            second copy of it drifts the day somebody changes the first. */}
        <LnButton
          type="button"
          size="lg"
          className="mt-4"
          onClick={handleReactivate}
          disabled={isPending}
          loading={isPending}
        >
          {isPending ? "Activando\u2026" : "Activar mi cuenta"}
        </LnButton>
        {error && <p className="mt-2.5 text-sm text-[var(--color-ln-err)]">{error}</p>}
      </LnCardBody>
    </LnCard>
  );
}

"use client";

// ReverseAdoptionAction — org-side "Revertir adopción" trigger, rendered on
// the org pet ficha's "ya no está bajo tu custodia" fallback (PO-locked
// semantics, 2026-07-21). Mirrors CancelTransferAction.tsx's ConfirmDialog
// pattern (Wave 3 rule, tier 1: a single confirm step naming the consequence
// is enough weight for this action — no mandatory reason field). The server
// action + use-case are the real gate (only the finalizing org/admin, only a
// genuinely-finalized + not-yet-reversed adoption); this component only
// renders when the ficha page already determined it is offered.

import { useRef, useState, useTransition } from "react";

import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { notifySaved } from "@/lib/ui/action-feedback";
import { reverseAdoptionAction } from "@/src/modules/adoption/actions";

export function ReverseAdoptionAction({
  orgToken,
  petPublicToken,
  petName,
}: {
  orgToken: string;
  petPublicToken: string;
  petName: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  function handleReverse() {
    setError(null);
    startTransition(async () => {
      const result = await reverseAdoptionAction({ orgToken, petPublicToken });
      if ("error" in result) {
        setError(result.error);
        setConfirming(false);
        return;
      }
      // revalidatePath fires server-side — the ficha re-renders under custody.
      setConfirming(false);
      setDone(true);
      notifySaved("Adopción revertida");
    });
  }

  if (done) {
    return (
      <p className="text-sm text-ln-op-ok font-medium">
        Adopción revertida. {petName} volvió a la custodia de la organización, sin publicar.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap gap-2 pt-1">
      {error && <output className="block w-full text-sm text-ln-op-danger">{error}</output>}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setConfirming(true)}
        className="rounded-[var(--radius-op-btn,6px)] border border-ln-op-danger px-3 py-1.5 text-sm font-semibold text-ln-op-danger transition-colors hover:bg-ln-op-danger hover:text-white focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--color-ln-op-celeste-050)]"
      >
        Revertir adopción
      </button>

      <ConfirmDialog
        open={confirming}
        onClose={() => !pending && setConfirming(false)}
        onConfirm={handleReverse}
        title="Revertir adopción"
        description={`Esto devuelve la custodia de ${petName} a la organización y lo saca del listado; para volver a darlo en adopción hay que re-publicarlo.`}
        confirmLabel="Revertir adopción"
        tone="danger"
        pending={pending}
        triggerRef={triggerRef}
      />
    </div>
  );
}

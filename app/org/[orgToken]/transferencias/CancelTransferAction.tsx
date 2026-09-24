"use client";

// CancelTransferAction — sender-side cancel of a pending cross-org custody
// transfer (E4, 2026-07-21 facades harvest). cancelCrossOrgTransferAction
// (src/modules/transfers/actions.ts) was fully modeled — use-case, audit log,
// receiver notification — with zero UI callers; this is the minimal trigger.
// Mirrors IncomingTransferActions.tsx's ConfirmDialog pattern (same
// consequence-copy convention, Wave 3 rule): a plain trigger button (OpButton
// forwards no ref) + ConfirmDialog with danger tone.

import { useRef, useState, useTransition } from "react";

import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { notifySaved } from "@/lib/ui/action-feedback";
import { cancelCrossOrgTransferAction } from "@/src/modules/transfers/actions";

export function CancelTransferAction({
  senderOrgToken,
  casePublicCode,
  petName,
}: {
  senderOrgToken: string;
  casePublicCode: string;
  petName: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  function handleCancel() {
    setError(null);
    startTransition(async () => {
      const result = await cancelCrossOrgTransferAction({
        senderOrgToken,
        casePublicCode,
      });
      if ("error" in result) {
        setError(result.error);
        setConfirming(false);
        return;
      }
      // revalidatePath fires server-side — the list re-renders automatically.
      setConfirming(false);
      setDone(true);
      notifySaved("Transferencia cancelada");
    });
  }

  if (done) {
    return <p className="text-sm text-ln-op-ok font-medium">Transferencia cancelada.</p>;
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
        Cancelar transferencia
      </button>

      <ConfirmDialog
        open={confirming}
        onClose={() => !pending && setConfirming(false)}
        onConfirm={handleCancel}
        title="Cancelar propuesta de transferencia"
        description={`Esto cancela la propuesta de transferir la custodia de ${petName} y notifica a la organización receptora. Esta acción no se puede deshacer.`}
        confirmLabel="Cancelar transferencia"
        // "Cancelar" would sit next to "Cancelar transferencia" and mean the
        // opposite of it — the one dialog in the app where the default dismiss
        // label is a homograph of the act. "Volver" keeps the two apart.
        cancelLabel="Volver"
        tone="danger"
        pending={pending}
        triggerRef={triggerRef}
      />
    </div>
  );
}

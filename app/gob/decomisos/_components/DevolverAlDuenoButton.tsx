"use client";

// DevolverAlDuenoButton -- triggers returnCustodyToOwnerAction for a
// custody_episode still in the OPENING govt org's direct custody.
//
// This is the terminal path that closes the episode by returning the
// animal to its immediate former owner (reactivating their SAME ownership
// row, "nunca se le fue") rather than handing off to a refugio. It restores
// the former owner's FULL access to the pet, so it requires an explicit
// confirmation before firing.

import { useRef, useState, useTransition } from "react";

import { returnCustodyToOwnerAction } from "@/app/actions/decomiso";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";

type DevolverAlDuenoButtonProps = {
  casePublicCode: string;
};

export function DevolverAlDuenoButton({ casePublicCode }: DevolverAlDuenoButtonProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Delivery warning: the return SUCCEEDED but one or more notifications could
  // not be handed over. We do not navigate away then — the reload would wipe the
  // only message telling the funcionario that the former owner was never told
  // their animal is theirs again.
  const [notice, setNotice] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // OpButton forwards no ref (see scripts/check-raw-buttons.mjs baseline note),
  // so the trigger stays a plain HTML button to give ConfirmDialog a
  // focus-restore target — same pattern as LeaveOrgButton/RemoveMemberButton.
  const triggerRef = useRef<HTMLButtonElement>(null);

  function handleConfirm() {
    setError(null);
    startTransition(async () => {
      const result = await returnCustodyToOwnerAction({ casePublicCode });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      if (result.warning) {
        setNotice(result.warning);
        return;
      }
      setOpen(false);
      // Full document reload so the SSR page reflects the mutation
      // (router.refresh() is banned - see lib/ui/full-page-action-nav.ts).
      navigateAfterActionSuccess(window.location.href);
    });
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-[var(--radius-sm)] border border-ln-op-line px-3 py-1.5 text-sm font-medium text-ln-op-ink transition-colors hover:bg-ln-op-stripe"
      >
        Devolver al dueño
      </button>
      <ConfirmDialog
        open={open}
        onClose={() => !isPending && setOpen(false)}
        onConfirm={handleConfirm}
        title={`Devolver al dueño — ${casePublicCode}`}
        // "Esta acción no se puede deshacer" was the same overclaim the execute
        // form carried (PO fix list 2026-08-17): the episode closes, but nothing
        // stops this authority from executing a new decomiso on the same animal.
        // What is true — and more useful — is that this hands legal
        // responsibility back, so the honest warning names the consequence
        // instead of inventing finality.
        description="Esto cierra el episodio de custodia y le restituye al dueño anterior el acceso completo sobre la mascota — una transferencia real de responsabilidad legal. Para volver a intervenir haría falta un decomiso nuevo, con su propia evidencia."
        confirmLabel="Devolver al dueño"
        tone="neutral"
        pending={isPending}
        triggerRef={triggerRef}
      >
        {error && (
          <p className="px-5 pb-3 text-sm text-ln-op-danger" role="alert">
            {error}
          </p>
        )}
        {notice && <output className="block px-5 pb-3 text-sm text-ln-op-warn">{notice}</output>}
      </ConfirmDialog>
    </>
  );
}

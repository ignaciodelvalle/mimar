"use client";

// IncomingTransferActions — accept/reject an incoming cross-org custody
// transfer. Both actions gate behind ConfirmDialog with matching friction
// (audit-3-feedback §C2 asymmetry #3, 2026-07-21): this file previously used
// an inline mode-switch panel for BOTH actions — internally symmetric, so
// not a safety bug, but lighter confirmation weight than the citizen-facing
// equivalent (AcceptTransferActions.tsx's ConfirmDialog) for a custody
// change that is at least as consequential. Reject keeps its optional
// reason/message fields, rendered inside the dialog via ConfirmDialog's
// `children` slot.

import { useRef, useState, useTransition } from "react";

import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { OpTextarea } from "@/components/ui/dashboard/OpField";
import { notifySaved } from "@/lib/ui/action-feedback";
import {
  acceptCrossOrgTransferAction,
  rejectCrossOrgTransferAction,
} from "@/src/modules/transfers/actions";

export function IncomingTransferActions({
  receiverOrgToken,
  casePublicCode,
  petName,
  permanentOwnership,
}: {
  receiverOrgToken: string;
  casePublicCode: string;
  petName: string;
  /**
   * The proposal's destination role is `owner`, not `shelter_custody` — i.e.
   * accepting makes THIS organisation the pet's permanent legal owner (closing
   * report L1, 2026-08-22).
   *
   * REQUIRED on purpose, not optional-with-a-default. A default would let the
   * next caller forget the field and silently show temporary-custody copy for a
   * permanent handover, which is the exact defect being fixed; required means
   * tsc refuses a caller that never read it.
   */
  permanentOwnership: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<"accept" | "reject" | null>(null);
  // Which ConfirmDialog is open, or null when neither is. OpButton forwards
  // no ref (see scripts/check-raw-buttons.mjs baseline note), so the two
  // trigger buttons below are plain HTML buttons styled to match OpButton —
  // same workaround already used by ReasignarButton/DevolverAlDuenoButton/
  // RemoveMemberButton to give ConfirmDialog a focus-restore target.
  const [confirming, setConfirming] = useState<"accept" | "reject" | null>(null);
  const acceptTriggerRef = useRef<HTMLButtonElement>(null);
  const rejectTriggerRef = useRef<HTMLButtonElement>(null);

  // Reject-only fields (action supports reason + message)
  const [rejectReason, setRejectReason] = useState("");
  const [rejectMessage, setRejectMessage] = useState("");

  function handleAccept() {
    setError(null);
    startTransition(async () => {
      const result = await acceptCrossOrgTransferAction({
        receiverOrgToken,
        casePublicCode,
      });
      if ("error" in result) {
        setError(result.error);
        setConfirming(null);
        return;
      }
      // revalidatePath fires server-side — the list re-renders automatically.
      // No page reload here, so the toast (not a reload) is the confirmation
      // — mutation-feedback convention, lib/ui/action-feedback.ts.
      setConfirming(null);
      setDone("accept");
      notifySaved("Transferencia aceptada");
    });
  }

  function handleReject() {
    setError(null);
    startTransition(async () => {
      const result = await rejectCrossOrgTransferAction({
        receiverOrgToken,
        casePublicCode,
        reason: rejectReason.trim() || null,
        message: rejectMessage.trim() || null,
      });
      if ("error" in result) {
        setError(result.error);
        setConfirming(null);
        return;
      }
      setConfirming(null);
      setDone("reject");
      notifySaved("Transferencia rechazada");
    });
  }

  if (done) {
    return (
      <p className="text-sm text-ln-op-ok font-medium">
        {done === "accept" ? "Transferencia aceptada." : "Transferencia rechazada."}
      </p>
    );
  }

  return (
    <div className="flex flex-wrap gap-2 pt-1">
      {error && <output className="block w-full text-sm text-ln-op-danger">{error}</output>}
      <button
        ref={acceptTriggerRef}
        type="button"
        onClick={() => setConfirming("accept")}
        className="rounded-[var(--radius-op-btn,6px)] border border-ln-op-ok bg-ln-op-ok px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--color-ln-op-celeste-050)]"
      >
        Aceptar
      </button>
      <button
        ref={rejectTriggerRef}
        type="button"
        onClick={() => setConfirming("reject")}
        className="rounded-[var(--radius-op-btn,6px)] border border-ln-op-danger bg-ln-op-danger px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--color-ln-op-celeste-050)]"
      >
        Rechazar
      </button>

      <ConfirmDialog
        open={confirming === "accept"}
        onClose={() => !pending && setConfirming(null)}
        onConfirm={handleAccept}
        title={
          permanentOwnership
            ? "Aceptar la titularidad permanente"
            : "Aceptar transferencia entre organizaciones"
        }
        // The two cases are NOT the same act, and the receiver had no way to
        // tell them apart: this dialog said "transfiere la custodia" for both.
        // The sender's own form distinguishes them, and so does the
        // notification this org already received ("custodia temporal" / "dueño
        // permanente", transfer-custody.ts) — the inbox was the odd one out.
        // Vocabulary matched to those two surfaces on purpose.
        description={
          permanentOwnership
            ? `Tu organización queda como dueño permanente de ${petName}: pasa a ser la responsable legal del animal, sin fecha de fin. No es una custodia temporal. Esta acción no se puede deshacer.`
            : `Esto transfiere la custodia de ${petName} a tu organización. Esta acción no se puede deshacer.`
        }
        confirmLabel={permanentOwnership ? "Aceptar la titularidad" : "Aceptar transferencia"}
        tone="warn"
        pending={pending}
        triggerRef={acceptTriggerRef}
      />

      <ConfirmDialog
        open={confirming === "reject"}
        onClose={() => {
          if (pending) return;
          setConfirming(null);
          setRejectReason("");
          setRejectMessage("");
        }}
        onConfirm={handleReject}
        title="Rechazar transferencia entre organizaciones"
        description={`Esto rechaza la transferencia de ${petName} y notifica a la organización remitente.`}
        confirmLabel="Rechazar transferencia"
        tone="danger"
        pending={pending}
        triggerRef={rejectTriggerRef}
      >
        <div className="space-y-2 px-5 pb-1">
          <OpTextarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            rows={2}
            placeholder="Motivo del rechazo (opcional)"
          />
          <OpTextarea
            value={rejectMessage}
            onChange={(e) => setRejectMessage(e.target.value)}
            rows={2}
            placeholder="Mensaje para la organización remitente (opcional)"
          />
        </div>
      </ConfirmDialog>
    </div>
  );
}

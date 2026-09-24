"use client";

// Receiver-side accept/reject UI for an incoming decomiso (court-ordered state
// seizure under Ley 14.346). Mirrors IncomingTransferActions but wires the
// decomiso-specific actions:
//   acceptDecomisoHandoffAction — receiver org takes custody (new custody_episode).
//   rejectDecomisoHandoffAction — receiver declines; govt retains the open episode.
//
// Both actions revalidate server-side; we also do a full document reload so
// the row's status flips immediately (custody episodes change hands here —
// SSR custody state must match the DB, and router.refresh() is banned; see
// lib/ui/full-page-action-nav.ts).
//
// CONFIRMATION (D.3, 2026-07-30): both acts gate behind ConfirmDialog, exactly
// like the sibling IncomingTransferActions. That file's own header documents
// the audit-3-feedback §C2 asymmetry #3 fix — an inline mode-switch panel is
// lighter confirmation weight than the citizen-facing equivalent for a custody
// change at least as consequential — but the fix never propagated HERE, where
// the custody at stake is STATE custody under Ley 14.346, i.e. strictly graver
// than the cross-org transfer that motivated the original fix. The buttons
// carry the verb of the act ("Aceptar custodia" / "Rechazar custodia"), never
// "Confirmar". Reject keeps its optional reason field, rendered inside the
// dialog via ConfirmDialog's `children` slot.

import { useRef, useState, useTransition } from "react";

import { acceptDecomisoHandoffAction, rejectDecomisoHandoffAction } from "@/app/actions/decomiso";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { OpButton, OpTextarea } from "@/components/ui/dashboard";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";

export function DecomisoHandoffActions({
  receiverOrgToken,
  casePublicCode,
  petName,
}: {
  receiverOrgToken: string;
  casePublicCode: string;
  petName: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Delivery warning: the act SUCCEEDED but one or more notifications could not
  // be handed over. We deliberately do NOT navigate away in that case — the
  // reload would wipe the only message telling this operator that the other side
  // was never informed. An in-app row is the whole notification instrument in
  // this product (no email channel exists), so a silent loss means nobody knows.
  const [notice, setNotice] = useState<string | null>(null);
  // Which ConfirmDialog is open, or null when neither is. The trigger refs are
  // ConfirmDialog's focus-restore targets (OpButton takes a ref as of
  // 2026-07-30, so these stay OpButtons instead of the hand-styled raw buttons
  // the sibling files still use).
  const [confirming, setConfirming] = useState<"accept" | "reject" | null>(null);
  const acceptTriggerRef = useRef<HTMLButtonElement>(null);
  const rejectTriggerRef = useRef<HTMLButtonElement>(null);

  // Reject-only field — optional reason recorded on the rejection note.
  const [rejectReason, setRejectReason] = useState("");

  function handleAccept() {
    setError(null);
    startTransition(async () => {
      const result = await acceptDecomisoHandoffAction({
        receiverOrgToken,
        casePublicCode,
      });
      if ("error" in result) {
        setError(result.error);
        setConfirming(null);
        return;
      }
      if (result.warning) {
        setNotice(result.warning);
        setConfirming(null);
        return;
      }
      navigateAfterActionSuccess(window.location.href);
    });
  }

  function handleReject() {
    setError(null);
    startTransition(async () => {
      const result = await rejectDecomisoHandoffAction({
        receiverOrgToken,
        casePublicCode,
        reason: rejectReason.trim() || null,
      });
      if ("error" in result) {
        setError(result.error);
        setConfirming(null);
        return;
      }
      if (result.warning) {
        setNotice(result.warning);
        setConfirming(null);
        return;
      }
      navigateAfterActionSuccess(window.location.href);
    });
  }

  return (
    <div className="flex flex-wrap gap-2 pt-1">
      {error && <output className="block w-full text-sm text-ln-op-danger">{error}</output>}
      {notice && <output className="block w-full text-sm text-ln-op-warn">{notice}</output>}
      <OpButton
        ref={acceptTriggerRef}
        type="button"
        size="sm"
        variant="ok"
        onClick={() => setConfirming("accept")}
      >
        Aceptar custodia
      </OpButton>
      <OpButton
        ref={rejectTriggerRef}
        type="button"
        size="sm"
        variant="danger"
        onClick={() => setConfirming("reject")}
      >
        Rechazar
      </OpButton>

      <ConfirmDialog
        open={confirming === "accept"}
        onClose={() => !pending && setConfirming(null)}
        onConfirm={handleAccept}
        title="Aceptar la custodia estatal"
        description={`Tu organización asume la custodia de ${petName} bajo Ley 14.346 y pasa a ser responsable del animal. Esta acción no se puede deshacer.`}
        confirmLabel="Aceptar custodia"
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
        }}
        onConfirm={handleReject}
        title="Rechazar la custodia estatal"
        description={`Esto devuelve el decomiso de ${petName} al organismo derivante, que mantiene la custodia transitoria del animal.`}
        confirmLabel="Rechazar custodia"
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
        </div>
      </ConfirmDialog>
    </div>
  );
}

"use client";

// ReasignarButton -- triggers the reassignDecomisoToAnotherReceiverAction
// for pending custody_episode cases.
//
// Spec DC9: when the current receiver rejects, or the govt wants to
// reassign proactively, this button opens a mini-form to select a new
// receiver and optionally enter a reason.

import { useRef, useState, useTransition } from "react";

import { reassignDecomisoToAnotherReceiverAction } from "@/app/actions/decomiso";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { OpSelect, OpTextarea } from "@/components/ui/dashboard/OpField";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";

type ReceiverOrgOption = {
  id: string;
  displayName: string;
  orgType: string;
};

const ORG_TYPE_LABEL: Record<string, string> = {
  shelter: "Refugio",
  rescue_network: "Red de rescate",
};

type ReasignarButtonProps = {
  casePublicCode: string;
  currentReceiverName: string;
  /** Excluded from the picker — reassigning to the same org is a no-op the
   * server already rejects, but there's no reason to offer it. */
  currentReceiverOrgId: string | null;
  /** Verified + active shelter/rescue_network orgs (same eligibility gate as
   * validateReceiverOrg) — display-only convenience; submit re-validates. */
  receiverOrgs: ReceiverOrgOption[];
};

export function ReasignarButton({
  casePublicCode,
  currentReceiverName,
  currentReceiverOrgId,
  receiverOrgs,
}: ReasignarButtonProps) {
  const [open, setOpen] = useState(false);
  const [newReceiverId, setNewReceiverId] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Delivery warning: the reassignment SUCCEEDED but one or more notifications
  // could not be handed over. We do not navigate away in that case — the reload
  // would wipe the only message telling the funcionario that the new refugio was
  // never actually informed, and an in-app row is the whole instrument (this
  // product has no email channel).
  const [notice, setNotice] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // OpButton forwards no ref (see scripts/check-raw-buttons.mjs baseline note),
  // so the trigger stays a plain HTML button to give ConfirmDialog a
  // focus-restore target — same pattern as LeaveOrgButton/RemoveMemberButton.
  const triggerRef = useRef<HTMLButtonElement>(null);

  const availableReceivers = receiverOrgs.filter((r) => r.id !== currentReceiverOrgId);

  function handleSubmit() {
    if (!newReceiverId) {
      setError("Elegí el nuevo refugio destinatario.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await reassignDecomisoToAnotherReceiverAction({
        casePublicCode,
        newReceiverOrgId: newReceiverId,
        reason: reason.trim() || null,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      if (result.warning) {
        setNotice(result.warning);
        return;
      }
      setOpen(false);
      setNewReceiverId("");
      setReason("");
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
        Reasignar
      </button>
      <ConfirmDialog
        open={open}
        onClose={() => !isPending && setOpen(false)}
        onConfirm={handleSubmit}
        title={`Reasignar decomiso — ${casePublicCode}`}
        description={`Esto transfiere la custodia del caso a otro refugio/red de rescate verificado. ${currentReceiverName} deja de ser responsable del caso.`}
        confirmLabel="Reasignar"
        tone="neutral"
        pending={isPending}
        triggerRef={triggerRef}
      >
        <div className="px-5 pb-4 space-y-4">
          <div className="space-y-1">
            <label htmlFor="newReceiverId" className="block text-sm font-medium text-ln-op-ink">
              Nuevo refugio destinatario
            </label>
            <OpSelect
              id="newReceiverId"
              value={newReceiverId}
              onChange={(e) => setNewReceiverId(e.target.value)}
              disabled={availableReceivers.length === 0}
            >
              <option value="">Elegí una organización verificada…</option>
              {availableReceivers.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.displayName} · {ORG_TYPE_LABEL[r.orgType] ?? r.orgType}
                </option>
              ))}
            </OpSelect>
            <p className="text-sm text-ln-op-mute">
              {availableReceivers.length === 0
                ? "No hay refugios verificados disponibles para reasignar."
                : "Solo aparecen refugios/redes de rescate verificados y activos."}
            </p>
          </div>

          <div className="space-y-1">
            <label htmlFor="reassignReason" className="block text-sm font-medium text-ln-op-ink">
              Motivo de reasignacion (opcional)
            </label>
            <OpTextarea
              id="reassignReason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="Por ej: el refugio anterior rechazo por falta de espacio."
              className="resize-none"
            />
          </div>

          {error && (
            <p className="text-md text-ln-op-danger" role="alert">
              {error}
            </p>
          )}

          {notice && <output className="block text-md text-ln-op-warn">{notice}</output>}
        </div>
      </ConfirmDialog>
    </>
  );
}

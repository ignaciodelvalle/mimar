"use client";

// Accepting a transfer ends on a receipt (L-13), and THIS ISLAND MUST STAY
// MOUNTED FOR THAT RECEIPT TO PAINT. acceptPetTransferAction calls
// revalidatePath, so Next ships the page's re-rendered RSC tree back with the
// action's response — the transfer is 'accepted' by then. When the page gated
// this component on `status === "pending"`, that re-render unmounted it and a
// local success flag ran against a component that was already gone (the exact
// trap documented in app/(app)/cuidado/[grantToken]/CaretakerInvitationActions.tsx).
// So the page renders this component UNCONDITIONALLY, in the same slot, and it
// decides: the receipt if it just accepted, the controls while pending, nothing
// otherwise. Same type, same position → React keeps the local state across the
// refresh.

import { useRef, useState, useTransition } from "react";

import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { LnSuccessScreen } from "@/components/ui/SuccessScreen";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";
import {
  acceptPetTransferAction,
  cancelPetTransferAction,
  rejectPetTransferAction,
} from "@/src/modules/transfers/actions";

export function AcceptTransferActions({
  transferToken,
  isPending,
  isRecipient,
  isSender,
  petToken,
  petName,
}: {
  transferToken: string;
  /** The transfer is still `pending` — the only state with controls. */
  isPending: boolean;
  isRecipient: boolean;
  isSender: boolean;
  petToken: string;
  petName: string;
}) {
  const [pending, startTransition] = useTransition();
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRejectReason, setShowRejectReason] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);
  // Accepting a transfer is IRREVERSIBLE (ownership changes hands, no undo) —
  // it must be gated behind the same confirmation weight as rejecting.
  // Previously accept fired on a single click while reject asked for a
  // reason + a second confirm click — backwards (audit finding, safety pass
  // 2026-07-19).
  // Accepting twice is impossible from here: the success replaces the controls
  // in the same render that ends the transition.
  const busy = pending;
  const [confirmAccept, setConfirmAccept] = useState(false);
  const acceptTriggerRef = useRef<HTMLButtonElement>(null);

  function handleAccept() {
    startTransition(async () => {
      const result = await acceptPetTransferAction(transferToken);
      if ("error" in result) {
        setError(result.error);
        setConfirmAccept(false);
        return;
      }
      // Ownership just changed. The receipt replaces the controls; the pet's
      // libreta (the old redirect target) is its first action. The action
      // revalidated /mis-mascotas/{token}, so that navigation renders fresh.
      setConfirmAccept(false);
      setAccepted(true);
    });
  }

  if (accepted) {
    return (
      <LnSuccessScreen
        title="Transferencia aceptada"
        description={`Ahora sos titular de ${petName}. Su libreta ya está en Mis mascotas, a tu nombre, y quien te la transfirió ya no la administra.`}
        next={[
          { label: `Ver la libreta de ${petName}`, href: `/mis-mascotas/${petToken}` },
          { label: "Ir a mis mascotas", href: "/mis-mascotas" },
        ]}
      />
    );
  }

  if (!isPending) return null;

  if (isRecipient) {
    return (
      <div className="space-y-3">
        {error && (
          <p className="text-sm text-[var(--color-ln-err)]" role="alert">
            {error}
          </p>
        )}
        {showRejectReason ? (
          <div className="space-y-2 rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] p-3">
            <label
              htmlFor="reject-reason"
              className="block text-xs font-medium text-[var(--color-ln-ink)]"
            >
              Motivo (opcional)
            </label>
            <input
              id="reject-reason"
              type="text"
              maxLength={500}
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              className="w-full rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] px-2 py-1 text-sm outline-none focus:border-[var(--color-ln-azul)] focus:shadow-[0_0_0_3px_var(--color-ln-celeste-050)]"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowRejectReason(false)}
                className="flex-1 rounded-[var(--radius-pill)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] px-3 py-1.5 text-xs font-medium text-[var(--color-ln-ink)]"
              >
                Atrás
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  startTransition(async () => {
                    const result = await rejectPetTransferAction({
                      transferToken,
                      reason: rejectReason || null,
                    });
                    if ("error" in result) {
                      setError(result.error);
                      return;
                    }
                    // Full reload so the SSR transfer page shows the rejected
                    // state (router.refresh() is banned — see
                    // lib/ui/full-page-action-nav.ts).
                    navigateAfterActionSuccess(window.location.href);
                  });
                }}
                className="flex-1 rounded-[var(--radius-pill)] bg-[var(--color-ln-seal)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {busy ? "Enviando…" : "Confirmar rechazo"}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => setShowRejectReason(true)}
              className="flex-1 rounded-[var(--radius-pill)] border border-[var(--color-ln-seal)] bg-[var(--color-ln-card)] px-3 py-2 text-sm font-medium text-[var(--color-ln-seal)] hover:bg-[var(--color-ln-err-050)] disabled:opacity-50"
            >
              Rechazar
            </button>
            <button
              ref={acceptTriggerRef}
              type="button"
              disabled={busy}
              onClick={() => setConfirmAccept(true)}
              className="flex-1 rounded-[var(--radius-pill)] bg-[var(--color-ln-ok)] px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              Aceptar
            </button>
          </div>
        )}
        <ConfirmDialog
          open={confirmAccept}
          onClose={() => !busy && setConfirmAccept(false)}
          onConfirm={handleAccept}
          title="Aceptar transferencia de titularidad"
          description={`Vas a aceptar la transferencia de titularidad de ${petName}. Esta acción no se puede deshacer.`}
          confirmLabel="Aceptar transferencia"
          tone="warn"
          pending={busy}
          triggerRef={acceptTriggerRef}
        />
      </div>
    );
  }

  if (isSender) {
    return (
      <div className="space-y-3">
        {error && (
          <p className="text-sm text-[var(--color-ln-err)]" role="alert">
            {error}
          </p>
        )}
        <p className="text-sm text-[var(--color-ln-ink-2)]">Esperando respuesta del receptor.</p>
        {confirmCancel ? (
          <div className="rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] p-3 space-y-2">
            <p className="text-sm text-[var(--color-ln-ink-2)]">
              Si después querés transferir de nuevo tenés que iniciar otra propuesta.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  startTransition(async () => {
                    const result = await cancelPetTransferAction(transferToken);
                    if ("error" in result) {
                      setError(result.error);
                      setConfirmCancel(false);
                      return;
                    }
                    // Full reload so the SSR transfer page shows the cancelled
                    // state (router.refresh() is banned — see
                    // lib/ui/full-page-action-nav.ts).
                    navigateAfterActionSuccess(window.location.href);
                  });
                }}
                className="flex-1 rounded-[var(--radius-pill)] bg-[var(--color-ln-seal)] px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {pending ? "Cancelando…" : "Confirmar cancelación"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmCancel(false)}
                className="flex-1 rounded-[var(--radius-pill)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] px-3 py-2 text-sm font-medium text-[var(--color-ln-ink)] hover:bg-[var(--color-ln-stripe)] disabled:opacity-50"
              >
                Atrás
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            disabled={pending}
            onClick={() => setConfirmCancel(true)}
            className="w-full rounded-[var(--radius-pill)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] px-3 py-2 text-sm font-medium text-[var(--color-ln-ink)] hover:bg-[var(--color-ln-stripe)] disabled:opacity-50"
          >
            Cancelar transferencia
          </button>
        )}
      </div>
    );
  }

  return null;
}

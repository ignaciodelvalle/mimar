"use client";

import { useState, useTransition } from "react";

import { withdrawApprovalRequestAction } from "@/app/actions/approval-requests";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";

type Props = {
  requestId: string;
};

export function WithdrawButton({ requestId }: Props) {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleConfirm() {
    setError(null);
    startTransition(async () => {
      const result = await withdrawApprovalRequestAction(requestId);
      if ("error" in result) {
        setError(result.error);
        setConfirming(false);
        return;
      }
      // Full document reload so the SSR request list drops the withdrawn row
      // (router.refresh() is banned — see lib/ui/full-page-action-nav.ts).
      navigateAfterActionSuccess(window.location.href);
    });
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="inline-flex items-center px-3 py-1.5 rounded-[var(--radius-pill)] border border-[var(--color-ln-line-strong)] text-xs font-medium text-[var(--color-ln-ink-2)] bg-[var(--color-ln-card)] hover:bg-[var(--color-ln-stripe)] transition-colors"
      >
        Retirar solicitud
      </button>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <p className="m-0 text-right text-xs text-[var(--color-ln-mute)]">
        ¿Seguro que querés retirar esta solicitud?
      </p>
      {error && (
        <p role="alert" className="m-0 text-right text-xs text-[var(--color-ln-err)]">
          {error}
        </p>
      )}
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={handleConfirm}
          disabled={pending}
          className="rounded-[var(--radius-pill)] bg-[var(--color-ln-seal)] px-3 py-1.5 text-xs font-semibold text-white transition-colors disabled:opacity-60"
        >
          {pending ? "Retirando…" : "Retirar solicitud"}
        </button>
        <button
          type="button"
          onClick={() => {
            setConfirming(false);
            setError(null);
          }}
          disabled={pending}
          className="rounded-[var(--radius-pill)] border border-[var(--color-ln-line-strong)] px-3 py-1.5 text-xs font-medium text-[var(--color-ln-ink)] transition-colors hover:bg-[var(--color-ln-stripe)] disabled:opacity-60"
        >
          Cancelar
        </button>
      </div>
    </div>
  );
}

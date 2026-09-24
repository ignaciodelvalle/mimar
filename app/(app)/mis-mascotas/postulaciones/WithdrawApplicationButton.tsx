"use client";

// WithdrawApplicationButton — applicant retracts a still-pending adoption
// application. Inline 2-step confirm (same pattern as LeaveMembershipButton);
// full page reload on success so the row re-derives out of "pending".

import { useState, useTransition } from "react";

import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";
import { withdrawAdoptionApplicationAction } from "@/src/modules/adoption/actions";

type Props = {
  applicationEventId: string;
};

export function WithdrawApplicationButton({ applicationEventId }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  function handleWithdraw() {
    setError(null);
    startTransition(async () => {
      const result = await withdrawAdoptionApplicationAction({ applicationEventId });
      if ("error" in result) {
        setError(result.error);
        setConfirming(false);
        return;
      }
      // Full document reload so the SSR list re-derives the row's status
      // (router.refresh() is banned — see lib/ui/full-page-action-nav.ts).
      navigateAfterActionSuccess(window.location.href);
    });
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="rounded-[var(--radius-pill)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] px-2.5 py-[5px] font-ln-sans text-sm font-medium text-[var(--color-ln-err)] transition-colors hover:bg-[var(--color-ln-stripe)]"
      >
        Retirar postulación
      </button>
    );
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
      <p className="m-0 text-sm text-[var(--color-ln-mute)]">
        ¿Confirmás que querés retirar esta postulación? No se puede deshacer.
      </p>
      {error && (
        <p className="m-0 text-sm text-[var(--color-ln-err)]" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={handleWithdraw}
          disabled={pending}
          className="rounded-[var(--radius-pill)] bg-[var(--color-ln-err)] px-2.5 py-[5px] font-ln-sans text-sm font-semibold text-white transition-colors disabled:opacity-60"
        >
          {pending ? "Retirando..." : "Sí, retirar"}
        </button>
        <button
          type="button"
          onClick={() => {
            setConfirming(false);
            setError(null);
          }}
          disabled={pending}
          className="rounded-[var(--radius-pill)] border border-[var(--color-ln-line-strong)] px-2.5 py-[5px] font-ln-sans text-sm font-medium text-[var(--color-ln-ink)] transition-colors hover:bg-[var(--color-ln-stripe)] disabled:opacity-60"
        >
          Cancelar
        </button>
      </div>
    </div>
  );
}

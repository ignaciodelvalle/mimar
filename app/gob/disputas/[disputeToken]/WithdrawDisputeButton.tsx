"use client";

import { useState, useTransition } from "react";

import { withdrawDisputeAction } from "@/app/actions/custody-disputes";
import { OpButton, OpTextarea } from "@/components/ui/dashboard";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";

export function WithdrawDisputeButton({ disputeToken }: { disputeToken: string }) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  function cancel() {
    setOpen(false);
    setReason("");
    setError(null);
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await withdrawDisputeAction({
        disputeToken,
        reason: reason.trim() || null,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      // Full document reload so the SSR page reflects the mutation
      // (router.refresh() is banned - see lib/ui/full-page-action-nav.ts).
      navigateAfterActionSuccess(window.location.href);
    });
  }

  if (!open) {
    return (
      <OpButton type="button" onClick={() => setOpen(true)} variant="danger" size="sm">
        Retirar disputa
      </OpButton>
    );
  }

  return (
    <div className="space-y-3 rounded-[var(--radius-md)] border border-ln-op-danger p-4">
      <p className="text-md font-medium text-ln-op-danger">Retirar disputa</p>
      <p className="text-sm text-ln-op-mute">
        Esto cierra la disputa sin resolución y desbloquea la mascota para transferencias.
      </p>
      <div>
        <label htmlFor="withdraw-reason" className="block text-sm text-ln-op-mute mb-1">
          Motivo del retiro (opcional)
        </label>
        {/* The old hand-rolled chrome focused to a RED border because the panel
            around it is danger-toned. Dropped on purpose: this field is
            optional and always valid, and red-on-focus is the app's error
            signal (`aria-[invalid=true]` in OpTextarea's base). The panel
            already carries the destructive framing. */}
        <OpTextarea
          id="withdraw-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          placeholder="Motivo (opcional)."
        />
      </div>

      {error && <output className="block text-md text-ln-op-danger">{error}</output>}

      <div className="flex gap-2">
        <OpButton
          type="button"
          onClick={submit}
          disabled={pending}
          variant="danger"
          className="px-4 py-2"
        >
          {pending ? "Retirando..." : "Retirar disputa"}
        </OpButton>
        <OpButton
          type="button"
          onClick={cancel}
          disabled={pending}
          variant="ghost"
          className="px-3 py-2"
        >
          Cancelar
        </OpButton>
      </div>
    </div>
  );
}

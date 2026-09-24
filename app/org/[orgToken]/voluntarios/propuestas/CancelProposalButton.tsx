"use client";

import { useState, useTransition } from "react";

import { OpButton } from "@/components/ui/dashboard";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";
import { cancelFosterProposalAction } from "@/src/modules/foster/actions";

export function CancelProposalButton({ proposalPublicToken }: { proposalPublicToken: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  function cancel() {
    setError(null);
    startTransition(async () => {
      const result = await cancelFosterProposalAction({
        proposalPublicToken,
        cancellationReason: "org_cancelled",
      });
      if ("error" in result) {
        setError(result.error);
        setConfirming(false);
        return;
      }
      // Full document reload so the SSR proposal list drops/updates the row
      // (router.refresh() is banned — see lib/ui/full-page-action-nav.ts).
      navigateAfterActionSuccess(window.location.href);
    });
  }

  if (!confirming) {
    return (
      <div className="text-right">
        <OpButton variant="danger" size="sm" onClick={() => setConfirming(true)} disabled={pending}>
          Cancelar
        </OpButton>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <p className="text-sm text-ln-op-ink-2">El voluntario va a recibir aviso.</p>
      {error && (
        <output role="alert" className="text-sm text-ln-op-danger">
          {error}
        </output>
      )}
      <div className="flex gap-2">
        <OpButton variant="danger" size="sm" onClick={cancel} disabled={pending}>
          {pending ? "Cancelando..." : "Confirmar cancelación"}
        </OpButton>
        <OpButton
          variant="ghost"
          size="sm"
          onClick={() => {
            setConfirming(false);
            setError(null);
          }}
          disabled={pending}
        >
          No, volver
        </OpButton>
      </div>
    </div>
  );
}

"use client";

// "Marcar recibido" for one ENO outbox row (PO S3, 2026-09-26).
//
// While no real receiver exists, a notice leaves "pendiente" only when a
// person of the receiving authority confirms it arrived. The act is recorded
// with who and when (audit_log `eno_notification_received`), so the button
// asks once before it writes.
//
// Same feedback contract as RetryOutboxButton: a pending label while the
// action runs, then a full-document reload of the list so the status pill,
// the breach banner and the count agree with the outcome; an error stays on
// the page, inline.

import { useState, useTransition } from "react";

import { OpButton } from "@/components/ui/dashboard";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";
import { markOutboxReceivedAction } from "@/src/modules/surveillance/actions";

export function MarkOutboxReceivedButton({ rowId, overdue }: { rowId: string; overdue: boolean }) {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await markOutboxReceivedAction(rowId);
      if (!result.ok) {
        setError(result.error);
        setConfirming(false);
        return;
      }
      navigateAfterActionSuccess(window.location.pathname + window.location.search);
    });
  }

  if (!confirming) {
    return (
      <span className="block">
        <OpButton type="button" variant="ghost" size="sm" onClick={() => setConfirming(true)}>
          Marcar recibido
        </OpButton>
        {error && <output className="mt-1 block text-sm text-ln-op-danger">{error}</output>}
      </span>
    );
  }

  return (
    <span className="block space-y-1">
      <span className="block text-sm text-ln-op-ink-2">
        {overdue
          ? "Queda registrado que lo recibiste, con tu nombre y la hora, y que el plazo legal ya había vencido."
          : "Queda registrado que lo recibiste, con tu nombre y la hora."}
      </span>
      <span className="flex gap-2">
        <OpButton type="button" variant="primary" size="sm" onClick={submit} disabled={pending}>
          {pending ? "Registrando…" : "Confirmar recepción"}
        </OpButton>
        <OpButton
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setConfirming(false)}
          disabled={pending}
        >
          Cancelar
        </OpButton>
      </span>
    </span>
  );
}

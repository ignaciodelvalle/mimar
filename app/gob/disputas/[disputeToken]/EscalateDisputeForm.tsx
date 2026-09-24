"use client";

import { useState, useTransition } from "react";

import { escalateDisputeAction } from "@/app/actions/custody-disputes";
import { OpButton, OpTextarea } from "@/components/ui/dashboard";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";

export function EscalateDisputeForm({ disputeToken }: { disputeToken: string }) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [okMessage, setOkMessage] = useState<string | null>(null);

  function cancel() {
    setOpen(false);
    setNotes("");
    setError(null);
  }

  function submit() {
    setError(null);
    setOkMessage(null);
    startTransition(async () => {
      const result = await escalateDisputeAction({ disputeToken, notes });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOkMessage("Escalada registrada. La disputa sigue abierta.");
      setOpen(false);
      setNotes("");
      // Full document reload so the SSR page reflects the mutation
      // (router.refresh() is banned - see lib/ui/full-page-action-nav.ts).
      navigateAfterActionSuccess(window.location.href);
    });
  }

  if (!open) {
    return (
      <OpButton type="button" onClick={() => setOpen(true)} variant="ghost" size="sm">
        Escalar a vía judicial
      </OpButton>
    );
  }

  return (
    <div className="space-y-3 rounded-[var(--radius-md)] border border-ln-op-line p-4">
      <p className="text-md font-medium text-ln-op-ink">Escalar a vía judicial</p>
      <p className="text-sm text-ln-op-mute">
        La disputa queda abierta. Se registra una nota en la historia de la mascota y en el
        historial de auditoría.
      </p>
      <div>
        <label htmlFor="escalate-notes" className="block text-sm text-ln-op-mute mb-1">
          Motivo de la escalada (mínimo 20 caracteres)
        </label>
        <OpTextarea
          id="escalate-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="Describí el motivo para derivar a vía judicial."
        />
        <p className="text-sm text-ln-op-mute mt-1 tabular-nums">{notes.trim().length} / 20 mín.</p>
      </div>

      {error && <output className="block text-md text-ln-op-danger">{error}</output>}
      {okMessage && <output className="block text-md text-ln-op-ok">{okMessage}</output>}

      <div className="flex gap-2">
        <OpButton
          type="button"
          onClick={submit}
          disabled={pending}
          variant="primary"
          className="px-4 py-2"
        >
          {pending ? "Registrando..." : "Confirmar escalada"}
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

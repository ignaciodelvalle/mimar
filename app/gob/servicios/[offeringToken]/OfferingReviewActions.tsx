"use client";

// Client component for approve/reject actions on a service offering (Fase 9).
// Mirrors the pattern used in /gob/cola/[publicToken]/ReviewActions.tsx.

import { useState, useTransition } from "react";

import {
  approveServiceOfferingAction,
  rejectServiceOfferingAction,
} from "@/app/actions/service-offerings";
import { OpButton, OpTextarea } from "@/components/ui/dashboard";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";

type Mode = "idle" | "approving" | "rejecting";

export function OfferingReviewActions({ publicToken }: { publicToken: string }) {
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<Mode>("idle");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  function approve() {
    setError(null);
    startTransition(async () => {
      const result = await approveServiceOfferingAction(publicToken);
      if (result.error) setError(result.error);
      else {
        setMode("idle");
        // Full document reload so the SSR page reflects the mutation
        // (router.refresh() is banned - see lib/ui/full-page-action-nav.ts).
        navigateAfterActionSuccess(window.location.href);
      }
    });
  }

  function reject() {
    setError(null);
    startTransition(async () => {
      const result = await rejectServiceOfferingAction(publicToken, reason);
      if (result.error) setError(result.error);
      else {
        setMode("idle");
        setReason("");
        // Full document reload so the SSR page reflects the mutation
        // (router.refresh() is banned - see lib/ui/full-page-action-nav.ts).
        navigateAfterActionSuccess(window.location.href);
      }
    });
  }

  if (mode === "approving") {
    return (
      <div className="space-y-2">
        <p className="text-sm text-ln-op-ink-2">
          Vas a aprobar este servicio. El proveedor recibirá una notificación.
        </p>
        <div className="flex items-center gap-2">
          <OpButton type="button" onClick={approve} disabled={pending} variant="ok" size="sm">
            {/* "aprobación" — es-AR. components/BulkApprovalQueueList.tsx
                spells the same confirmation correctly; this one was the odd
                one out (found by clicking through it, 2026-08-09). */}
            {pending ? "Aprobando…" : "Confirmar aprobación"}
          </OpButton>
          <OpButton
            type="button"
            onClick={() => {
              setMode("idle");
              setError(null);
            }}
            variant="ghost"
            size="sm"
          >
            Cancelar
          </OpButton>
        </div>
        {error && <p className="text-sm text-ln-op-danger">{error}</p>}
      </div>
    );
  }

  if (mode === "rejecting") {
    const tooShort = reason.trim().length < 10;
    return (
      <div className="space-y-2">
        <OpTextarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Motivo del rechazo (mínimo 10 caracteres). Se envía al proveedor."
          rows={3}
          size="sm"
        />
        <div className="flex items-center gap-2">
          <OpButton
            type="button"
            onClick={reject}
            disabled={pending || tooShort}
            variant="danger"
            size="sm"
          >
            {pending ? "Rechazando..." : "Confirmar rechazo"}
          </OpButton>
          <OpButton
            type="button"
            onClick={() => {
              setMode("idle");
              setReason("");
              setError(null);
            }}
            variant="ghost"
            size="sm"
          >
            Cancelar
          </OpButton>
        </div>
        {error && <p className="text-sm text-ln-op-danger">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <OpButton type="button" onClick={() => setMode("approving")} disabled={pending} variant="ok">
        Aprobar
      </OpButton>
      <OpButton
        type="button"
        onClick={() => setMode("rejecting")}
        disabled={pending}
        variant="danger"
      >
        Rechazar
      </OpButton>
      {error && <p className="text-sm text-ln-op-danger">{error}</p>}
    </div>
  );
}

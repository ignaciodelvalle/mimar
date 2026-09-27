"use client";

// The platform admin's reversal of a deactivation (jurisdiction-admin,
// admin-reversal). Platform-only by design: it lives under /admin, never among
// the shared components/institutional forms a jurisdiction admin's pages render.
//
// It asks for a reason (it lands in audit_log with who and when) and says,
// before it is made, what does NOT come back: the localities stay revoked.

import { useState, useTransition } from "react";

import { reactivateGovtAction } from "@/app/actions/govt-reactivation";
import { MOTIVO_MIN, MotivoField } from "@/components/MotivoField";
import { OpButton, OpFormAlert } from "@/components/ui/dashboard";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";

export function ReactivateGovtForm({
  targetUserId,
  displayName,
  isNational,
}: {
  targetUserId: string;
  displayName: string;
  isNational: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const canSubmit = reason.trim().length >= MOTIVO_MIN && !pending;

  if (!open) {
    return (
      <OpButton type="button" variant="ok" size="sm" onClick={() => setOpen(true)}>
        Reactivar cuenta
      </OpButton>
    );
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await reactivateGovtAction({ targetGovtUserId: targetUserId, reason });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      // Full document reload (router.refresh() is banned — see
      // lib/ui/full-page-action-nav.ts).
      navigateAfterActionSuccess(window.location.href);
    });
  }

  return (
    <form
      className="w-full space-y-3 rounded-[var(--radius-md)] border border-ln-op-line-2 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) submit();
      }}
    >
      <p className="text-sm text-ln-op-ink-2">
        {displayName} vuelve a poder ingresar.{" "}
        {isNational
          ? "La cuenta de observación nacional no tiene localidades."
          : "Las localidades que se revocaron al desactivarla no vuelven: asignalas de nuevo después de reactivar."}
      </p>
      <MotivoField value={reason} onChange={setReason} />
      {error && <OpFormAlert>{error}</OpFormAlert>}
      <div className="flex gap-2">
        <OpButton type="submit" variant="ok" size="sm" disabled={!canSubmit} loading={pending}>
          Reactivar
        </OpButton>
        <OpButton
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => setOpen(false)}
        >
          Cancelar
        </OpButton>
      </div>
    </form>
  );
}

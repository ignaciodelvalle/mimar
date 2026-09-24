"use client";

// Verify button for unverified orgs in the admin portal.
//
// State machine: idle → confirming → submitting → done | error
//
// The evidence-backed revocation path (with motivo + file upload) is handled
// by RevokeOrgActions from gob/organizaciones/.
// The lightweight unverify action (unverifyOrgAction / unverifyOrgForAuthority)
// is kept in admin-org-verification.ts for future surfaces but has no UI here;
// UnverifyOrgButton was removed (dead code — never rendered).

import { useState, useTransition } from "react";

import { verifyOrgAction } from "@/app/actions/admin-org-verification";
import { notifySaved } from "@/lib/ui/action-feedback";

type Org = {
  id: string;
  displayName: string;
  verified: boolean;
};

// ---------------------------------------------------------------------------
// Verify button — shown for unverified orgs
// ---------------------------------------------------------------------------

export function VerifyOrgButton({ org }: { org: Org }) {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (org.verified) return null;

  if (done) {
    return (
      <p className="text-sm text-ln-op-ok">
        Organización verificada. Los administradores de la org fueron notificados.
      </p>
    );
  }

  function handleVerify() {
    setError(null);
    startTransition(async () => {
      const result = await verifyOrgAction({ organizationId: org.id });
      if ("error" in result) {
        setError(result.error);
      } else {
        setDone(true);
        // No reload here — the toast is the confirmation (mutation-feedback
        // convention, lib/ui/action-feedback.ts). The inline panel above
        // stays too, since it carries the "admins were notified" detail.
        notifySaved("Organización verificada");
      }
    });
  }

  if (confirming) {
    return (
      <div className="rounded-[var(--radius-md)] border border-ln-op-azul p-3 space-y-2 bg-ln-op-card">
        <p className="text-sm text-ln-op-ink-2">
          ¿Confirmas la verificación de <span className="font-medium">{org.displayName}</span>? Esta
          acción queda registrada en el audit log y notifica a los administradores de la org.
        </p>
        {error && <p className="text-sm text-ln-op-danger">{error}</p>}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleVerify}
            disabled={pending}
            className="text-sm px-3 py-1.5 rounded-[var(--radius-md)] bg-ln-op-azul text-white font-semibold hover:opacity-90 disabled:opacity-50"
          >
            {pending ? "Verificando..." : "Sí, verificar"}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={pending}
            className="text-sm px-3 py-1.5 rounded-[var(--radius-md)] border border-ln-op-line hover:bg-ln-op-stripe"
          >
            Cancelar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="text-sm px-3 py-1.5 rounded-[var(--radius-md)] bg-ln-op-azul text-white font-semibold hover:opacity-90"
      >
        Verificar organización
      </button>
      {error && <p className="text-sm text-ln-op-danger">{error}</p>}
    </div>
  );
}

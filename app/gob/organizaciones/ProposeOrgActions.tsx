"use client";

import { useState, useTransition } from "react";

import { proposeOrgVerificationAction } from "@/app/actions/admin-proposals";
import { OpButton } from "@/components/ui/dashboard";
import { notifySaved } from "@/lib/ui/action-feedback";

type Org = {
  id: string;
  displayName: string;
  verified: boolean;
};

export function ProposeOrgActions({ org }: { org: Org }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  if (org.verified) {
    // Not "sin acciones disponibles desde acá" — RevokeOrgActions renders its
    // own (capability-gated) "Revocar verificación" button right below this
    // for actors who can act, so claiming no actions exist would contradict
    // an enabled button on the same card (screenshot review finding #8).
    return <p className="text-sm text-ln-op-mute">Ya verificada.</p>;
  }

  if (submitted) {
    return (
      <p className="text-sm text-ln-op-ok">
        Solicitud creada. Va a aparecer en la cola para revisión.
      </p>
    );
  }

  function propose() {
    setError(null);
    startTransition(async () => {
      const result = await proposeOrgVerificationAction({ organizationId: org.id });
      if ("error" in result) {
        setError(result.error);
      } else {
        setSubmitted(true);
        notifySaved("Solicitud creada");
      }
    });
  }

  return (
    <div className="flex items-center gap-2">
      <OpButton type="button" onClick={propose} disabled={pending} variant="ghost" size="sm">
        {pending ? "Creando..." : "Proponer verificación"}
      </OpButton>
      {error && <p className="text-sm text-ln-op-danger">{error}</p>}
    </div>
  );
}

"use client";

// Revocation UI for RUPGA service-dog credentials.
//
// State machine: idle → confirming → done
// Mirrors app/gob/organizaciones/RevokeOrgActions.tsx and
// app/gob/usuarios/RevokeUserActions.tsx, minus the evidence-upload step:
// revokeServiceDogCredentialAction (app/actions/service-dog.ts, reused
// verbatim here) takes only { petPublicToken, motivo } — RevokeServiceDogInput
// has no attachmentIds field, so there is nothing to upload.
//
// Client-side canRevoke hides the button when the actor clearly has no scope
// (defense-in-depth; the use-case is server-authoritative and re-checks
// admin/govt + jurisdiction itself). It reuses the "org_verification" target
// shape purely for its (province, locality) check — same reuse the use-case
// itself makes, since service-dog credentials don't have a dedicated
// RevocationType in lib/domain/revocation-scope.ts.
//
// A successful revoke drops the credential from this list via the action's
// server-side revalidatePath("/gob/rupga") — no client router.refresh().

import { useState, useTransition } from "react";

import { revokeServiceDogCredentialAction } from "@/app/actions/service-dog";
import { MOTIVO_MIN, MotivoField } from "@/components/MotivoField";
import { LnCheckbox } from "@/components/ui/Field";
import { OpButton } from "@/components/ui/dashboard";
import { canRevoke } from "@/lib/domain/revocation-scope";
import type { AdminOrGovtJurisdiction } from "@/lib/domain/revocation-scope";
import type { ServiceDogCredentialSearchResult } from "@/lib/infra/admin-search";
import { notifySaved } from "@/lib/ui/action-feedback";

type Mode = "idle" | "confirming" | "done";

export function RevokeServiceDogActions({
  credential,
  actorRole,
  jurisdictions,
}: {
  credential: ServiceDogCredentialSearchResult;
  actorRole: "admin" | "govt";
  jurisdictions: readonly AdminOrGovtJurisdiction[];
}) {
  const [mode, setMode] = useState<Mode>("idle");

  // Client-side capability check — server always re-validates. Computed AFTER
  // the hook so the Rules of Hooks hold (unconditional hook, then the gate).
  const canAct = canRevoke(
    { id: "", role: actorRole },
    {
      type: "org_verification",
      province: credential.jurisdictionProvince ?? "",
      locality: credential.jurisdictionLocality ?? "",
    },
    jurisdictions,
  );

  if (!canAct) return null;

  if (mode === "done") {
    return (
      <p className="text-sm text-ln-op-ok">
        Credencial revocada. El titular de {credential.petName} fue notificado.
      </p>
    );
  }

  if (mode === "confirming") {
    return (
      <RevokeServiceDogForm
        credential={credential}
        onDone={() => setMode("done")}
        onCancel={() => setMode("idle")}
      />
    );
  }

  return (
    <OpButton type="button" onClick={() => setMode("confirming")} variant="danger" size="sm">
      Revocar credencial
    </OpButton>
  );
}

// ---------------------------------------------------------------------------
// Form component
// ---------------------------------------------------------------------------

function RevokeServiceDogForm({
  credential,
  onDone,
  onCancel,
}: {
  credential: ServiceDogCredentialSearchResult;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [motivo, setMotivo] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const motivoTrimmed = motivo.trim();
  const motivoValid = motivoTrimmed.length >= MOTIVO_MIN;
  const canSubmit = motivoValid && confirm && !pending;

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await revokeServiceDogCredentialAction({
        petPublicToken: credential.petPublicToken,
        motivo: motivoTrimmed,
      });
      if ("error" in result) {
        setError(result.error);
      } else {
        // The action revalidates /gob/rupga server-side; just settle the UI.
        // No client reload, so the toast is the confirmation (mutation-
        // feedback convention, lib/ui/action-feedback.ts).
        onDone();
        notifySaved("Credencial revocada");
      }
    });
  }

  return (
    <div className="rounded-[var(--radius-md)] border border-ln-op-danger p-3 space-y-3 bg-ln-op-danger-bg">
      <p className="text-xs uppercase tracking-wider text-ln-op-danger">
        Revocar credencial RUPGA — {credential.petName}
      </p>
      <p className="text-xs text-ln-op-danger">
        La credencial pasa a estado revocada y el banner público de acceso deja de mostrarse. El
        titular recibirá una notificación con el motivo.
      </p>

      <MotivoField value={motivo} onChange={setMotivo} />

      <LnCheckbox
        checked={confirm}
        onChange={(e) => setConfirm(e.target.checked)}
        labelClassName="text-xs! text-ln-op-danger!"
      >
        Confirmo que quiero revocar la credencial RUPGA de {credential.petName}. Esta acción genera
        un registro permanente en el audit log.
      </LnCheckbox>

      {error && <p className="text-sm text-ln-op-danger">{error}</p>}

      <div className="flex items-center gap-2">
        <OpButton type="button" onClick={submit} disabled={!canSubmit} variant="danger" size="sm">
          {pending ? "Revocando..." : "Revocar"}
        </OpButton>
        <OpButton type="button" onClick={onCancel} disabled={pending} variant="ghost" size="sm">
          Cancelar
        </OpButton>
      </div>
    </div>
  );
}

"use client";

// Restablecer segundo factor — admin-assisted TOTP recovery (T2-S6).
//
// Supabase Auth has no recovery codes, so an operator who lost the phone with
// the authenticator app asks an admin, and this is the admin's side of it: every
// factor of the account is removed AND its credentials are reset (password
// replaced, every session ended, a new one-time link) — a factor-less account
// that still had its old password and sessions was one anybody holding either
// could claim by enrolling first. The operator comes back through the link and
// enrols a new app. Same friction as ResetCredentialsButton (motivo + explicit
// confirmation, audited), because it disarms a security control for one person.
// Never rendered on the admin's own detail page — the use-case refuses it too.

import { useState, useTransition } from "react";

import { resetMfaFactorsAction } from "@/app/actions/admin-institutional";
import { MagicLinkResultPanel } from "@/app/admin/_components/MagicLinkResultPanel";
import { MOTIVO_MIN, MotivoField } from "@/components/MotivoField";
import { LnCheckbox } from "@/components/ui/Field";
import { OpButton } from "@/components/ui/dashboard";
import { notifySaved } from "@/lib/ui/action-feedback";

export function ResetMfaButton({
  targetUserId,
  displayName,
  email,
  detailPath,
}: {
  targetUserId: string;
  displayName: string;
  email: string;
  detailPath: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [motivo, setMotivo] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [magicLink, setMagicLink] = useState<string | null>(null);

  if (magicLink !== null) {
    return (
      <MagicLinkResultPanel
        magicLink={magicLink}
        displayName={displayName}
        email={email}
        profileId={targetUserId}
        detailPath={detailPath}
        variant="mfaReset"
        resetLabel="Cerrar"
        onReset={() => setMagicLink(null)}
      />
    );
  }

  if (!open) {
    return (
      <OpButton type="button" onClick={() => setOpen(true)} variant="ghost" size="sm">
        Restablecer segundo factor
      </OpButton>
    );
  }

  const motivoTrimmed = motivo.trim();
  const canSubmit = motivoTrimmed.length >= MOTIVO_MIN && confirm && !pending;

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await resetMfaFactorsAction({ targetUserId, reason: motivoTrimmed });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setMotivo("");
      setConfirm(false);
      setMagicLink(result.magicLink);
      notifySaved("Segundo factor y credenciales restablecidos");
    });
  }

  return (
    <div className="space-y-3 rounded-[var(--radius-md)] border border-ln-op-danger-bd bg-ln-op-danger-bg p-3">
      <p className="text-xs font-bold uppercase tracking-wider text-ln-op-danger">
        Restablecer segundo factor &mdash; {displayName}
      </p>
      <p className="text-xs text-ln-op-danger">
        Quita la app de autenticación vinculada a la cuenta y también restablece sus credenciales:
        cierra todas sus sesiones, invalida su contraseña y genera un link nuevo de un solo uso. Con
        ese link la persona elige una contraseña y configura una app nueva. Usalo solo si perdió el
        acceso a su app y confirmaste su identidad por otro canal. Queda registrado en el audit log
        con el motivo.
      </p>

      <MotivoField value={motivo} onChange={setMotivo} />

      <LnCheckbox
        checked={confirm}
        onChange={(e) => setConfirm(e.target.checked)}
        labelClassName="text-xs! text-ln-op-danger!"
      >
        Confirmo que verifiqué la identidad de {displayName} y quiero quitar su segundo factor y
        restablecer sus credenciales.
      </LnCheckbox>

      {error && <p className="text-sm text-ln-op-danger">{error}</p>}

      <div className="flex items-center gap-2">
        <OpButton type="button" onClick={submit} disabled={!canSubmit} variant="danger" size="sm">
          {pending ? "Restableciendo..." : "Restablecer segundo factor"}
        </OpButton>
        <OpButton
          type="button"
          onClick={() => setOpen(false)}
          disabled={pending}
          variant="ghost"
          size="sm"
        >
          Cancelar
        </OpButton>
      </div>
    </div>
  );
}

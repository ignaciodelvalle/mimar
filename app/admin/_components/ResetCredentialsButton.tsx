"use client";

// Reset credentials button for institutional accounts.
//
// State machine: idle -> confirming -> resetting -> done | error
// Resetting credentials rotates the live operator's magic link and logs them
// out, so it carries the same friction as a deactivation: an explicit confirm
// step plus a required motivo (≥ MOTIVO_MIN chars) that is recorded in the
// audit payload. Unlike deactivation, no evidence upload is required.
//
// On success: renders MagicLinkResultPanel inline with the returned magic link.
// Used on both /admin/govts/[userId] and /admin/admins/[userId] detail pages.

import { useState, useTransition } from "react";

import { resetInstitutionalCredentialsAction } from "@/app/actions/admin-institutional";
import { MagicLinkResultPanel } from "@/app/admin/_components/MagicLinkResultPanel";
import { MOTIVO_MIN, MotivoField } from "@/components/MotivoField";
import { LnCheckbox } from "@/components/ui/Field";
import { OpButton } from "@/components/ui/dashboard";
import { notifySaved } from "@/lib/ui/action-feedback";

type Mode = "idle" | "confirming" | "done";

export function ResetCredentialsButton({
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
  const [mode, setMode] = useState<Mode>("idle");
  const [magicLink, setMagicLink] = useState<string | null>(null);

  if (mode === "done" && magicLink !== null) {
    return (
      <MagicLinkResultPanel
        magicLink={magicLink}
        displayName={displayName}
        email={email}
        profileId={targetUserId}
        detailPath={detailPath}
        variant="reset"
        resetLabel="Cerrar"
        onReset={() => {
          setMode("idle");
          setMagicLink(null);
        }}
      />
    );
  }

  if (mode === "confirming") {
    return (
      <ResetCredentialsForm
        targetUserId={targetUserId}
        displayName={displayName}
        onDone={(link) => {
          setMagicLink(link);
          setMode("done");
        }}
        onCancel={() => setMode("idle")}
      />
    );
  }

  return (
    <OpButton type="button" onClick={() => setMode("confirming")} variant="ghost" size="sm">
      Resetear credenciales
    </OpButton>
  );
}

// ---------------------------------------------------------------------------
// Form component
// ---------------------------------------------------------------------------

function ResetCredentialsForm({
  targetUserId,
  displayName,
  onDone,
  onCancel,
}: {
  targetUserId: string;
  displayName: string;
  onDone: (magicLink: string) => void;
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
      const result = await resetInstitutionalCredentialsAction({
        targetUserId,
        reason: motivoTrimmed,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      onDone(result.magicLink);
      // No reload — the result panel stays mounted on this same route; the
      // toast is the confirmation (mutation-feedback convention).
      notifySaved("Credenciales restablecidas");
    });
  }

  return (
    <div className="space-y-3 rounded-[var(--radius-md)] border border-ln-op-danger-bd bg-ln-op-danger-bg p-3">
      <p className="text-xs font-bold uppercase tracking-wider text-ln-op-danger">
        Resetear credenciales &mdash; {displayName}
      </p>
      <p className="text-xs text-ln-op-danger">
        Esto genera un nuevo link de acceso y cierra la sesión activa del operador. Queda registrado
        en el audit log con el motivo.
      </p>

      <MotivoField value={motivo} onChange={setMotivo} />

      <LnCheckbox
        checked={confirm}
        onChange={(e) => setConfirm(e.target.checked)}
        labelClassName="text-xs! text-ln-op-danger!"
      >
        Confirmo que quiero rotar las credenciales de {displayName}. Esta acción genera un registro
        permanente en el audit log.
      </LnCheckbox>

      {error && <p className="text-sm text-ln-op-danger">{error}</p>}

      <div className="flex items-center gap-2">
        <OpButton type="button" onClick={submit} disabled={!canSubmit} variant="danger" size="sm">
          {pending ? "Generando link..." : "Resetear credenciales"}
        </OpButton>
        <OpButton type="button" onClick={onCancel} disabled={pending} variant="ghost" size="sm">
          Cancelar
        </OpButton>
      </div>
    </div>
  );
}

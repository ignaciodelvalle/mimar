"use client";

// Deactivation UI for admin accounts.
//
// State machine: idle → confirming → submitting → done | error
// Mirrors RevokeUserActions.tsx structure — design §8.8.
//
// Evidence upload flow (design §3, spec REQ-6; C23):
//   1. User picks files via <input type="file"> — held in state, NOT uploaded.
//   2. On SUBMIT the files are uploaded to Supabase Storage (namespaced by the
//      TARGET) then registered via uploadRevocationEvidence.
//   3. attachmentIds[] are then passed to deactivateAdminAction.
// Cancelling never uploads, so no orphaned objects are left in the bucket.
//
// Client-side canDeactivateAdmin hides/disables the button when the actor
// clearly has no scope (defense-in-depth; server is authoritative).

import { useRef, useState, useTransition } from "react";

import { deactivateAdminAction } from "@/app/actions/admin-institutional";
import { MOTIVO_MIN, MotivoField } from "@/components/MotivoField";
import { LnCheckbox } from "@/components/ui/Field";
import { OpButton } from "@/components/ui/dashboard";
import { canDeactivateAdmin } from "@/lib/domain/institutional-scope";
import type { ActorProfile } from "@/lib/domain/institutional-scope";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";
import { useEvidenceUpload } from "@/lib/ui/use-evidence-upload";

type Target = {
  id: string;
  displayName: string;
};

type Mode = "idle" | "confirming" | "done";

export function DeactivateAdminActions({
  target,
  actor,
  activeAdminCount,
}: {
  target: Target;
  actor: ActorProfile;
  activeAdminCount: number;
}) {
  const canAct = canDeactivateAdmin(actor, target.id, activeAdminCount);

  const [mode, setMode] = useState<Mode>("idle");

  if (mode === "done") {
    return (
      <p className="text-sm text-ln-op-ok font-medium">
        Admin desactivado. {target.displayName} fue notificado.
      </p>
    );
  }

  if (!canAct) {
    const isSelf = actor.id === target.id;
    const isLast = activeAdminCount <= 1;
    const reason = isSelf
      ? "No podés desactivarte a vos mismo."
      : isLast
        ? "No se puede desactivar al único admin activo."
        : null;

    if (!reason) return null;

    return <p className="text-xs text-ln-op-mute italic">{reason}</p>;
  }

  if (mode === "confirming") {
    return (
      <DeactivateAdminForm
        target={target}
        onDone={() => setMode("done")}
        onCancel={() => setMode("idle")}
      />
    );
  }

  return (
    <OpButton type="button" onClick={() => setMode("confirming")} variant="danger" size="sm">
      Desactivar admin
    </OpButton>
  );
}

// ---------------------------------------------------------------------------
// Form component
// ---------------------------------------------------------------------------

function DeactivateAdminForm({
  target,
  onDone,
  onCancel,
}: {
  target: Target;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [motivo, setMotivo] = useState("");
  const [confirm, setConfirm] = useState(false);
  const { selectedFiles, uploading, addFiles, removeFile, uploadAll } = useEvidenceUpload();
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const motivoTrimmed = motivo.trim();
  const motivoValid = motivoTrimmed.length >= MOTIVO_MIN;
  const canSubmit = motivoValid && selectedFiles.length >= 1 && confirm && !pending && !uploading;

  function handleFilesChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    setError(null);
    addFiles(files);
    // Reset the native input so the same file can be re-picked after removal.
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      // C23: upload on submit, namespaced by the TARGET admin id.
      const uploaded = await uploadAll(target.id);
      if ("error" in uploaded) {
        setError(uploaded.error);
        return;
      }

      const result = await deactivateAdminAction({
        targetAdminUserId: target.id,
        motivo: motivoTrimmed,
        attachmentIds: uploaded.attachmentIds,
      });
      if ("error" in result) {
        setError(result.error);
      } else {
        // Full document reload so the SSR institutional list reflects the
        // change immediately (router.refresh() is banned - see
        // lib/ui/full-page-action-nav.ts).
        navigateAfterActionSuccess(window.location.href);
        onDone();
      }
    });
  }

  return (
    <div className="rounded-[var(--radius-md)] border border-ln-op-danger-bd bg-ln-op-danger-bg p-3 space-y-3">
      <p className="text-xs uppercase tracking-wider font-bold text-ln-op-danger">
        Desactivar admin &mdash; {target.displayName}
      </p>
      <p className="text-xs text-ln-op-danger">
        Esta acción es irreversible desde esta interfaz. El usuario quedará desactivado y recibirá
        una notificación con el motivo.
      </p>

      <MotivoField value={motivo} onChange={setMotivo} />

      <div className="space-y-1">
        <label
          htmlFor="deactivate-admin-evidence"
          className="block text-xs uppercase tracking-wider text-ln-op-mute"
        >
          Evidencia (al menos 1 archivo)
        </label>
        <input
          id="deactivate-admin-evidence"
          ref={fileInputRef}
          type="file"
          accept="image/*,application/pdf"
          multiple
          onChange={handleFilesChange}
          disabled={uploading || pending}
          className="text-sm text-ln-op-ink-2"
        />
        {uploading && <p className="text-xs text-ln-op-mute">Subiendo...</p>}
        {selectedFiles.length > 0 && (
          <ul className="space-y-0.5">
            {selectedFiles.map((f) => (
              <li key={f.key} className="flex items-center gap-2 text-xs text-ln-op-ink-2">
                <span className="truncate max-w-[200px]">{f.file.name}</span>
                <button
                  type="button"
                  onClick={() => removeFile(f.key)}
                  disabled={pending || uploading}
                  className="text-ln-op-danger hover:underline shrink-0 disabled:opacity-50"
                >
                  Quitar
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <LnCheckbox
        checked={confirm}
        onChange={(e) => setConfirm(e.target.checked)}
        labelClassName="text-xs! text-ln-op-danger!"
      >
        Confirmo que quiero desactivar la cuenta de {target.displayName}. Esta acción genera un
        registro permanente en el audit log.
      </LnCheckbox>

      {error && <p className="text-sm text-ln-op-danger">{error}</p>}

      <div className="flex items-center gap-2">
        <OpButton type="button" onClick={submit} disabled={!canSubmit} variant="danger" size="sm">
          {pending ? "Desactivando..." : "Desactivar"}
        </OpButton>
        <OpButton type="button" onClick={onCancel} disabled={pending} variant="ghost" size="sm">
          Cancelar
        </OpButton>
      </div>
    </div>
  );
}

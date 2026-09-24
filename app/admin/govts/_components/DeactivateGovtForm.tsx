"use client";

// Deactivation UI for govt accounts.
//
// State machine: idle → confirming → submitting → done | error
// Mirrors DeactivateAdminForm.tsx structure — design §8.8.
//
// Evidence upload flow (design §3, spec REQ-6; C23):
//   1. User picks files via <input type="file"> — held in state, NOT uploaded.
//   2. On SUBMIT the files are uploaded to Supabase Storage (namespaced by the
//      TARGET govt) then registered via uploadRevocationEvidence.
//   3. attachmentIds[] are then passed to deactivateGovtAction.
// Cancelling never uploads, so no orphaned objects are left in the bucket.
//
// Cascading effect: deactivating a govt also revokes all their active locality
// assignments (handled server-side in deactivateGovtForAuthority).
//
// Also used for a national observer (pilot T1-P9): same use case, no
// localities to revoke, so the copy drops them.

import { useRef, useState, useTransition } from "react";

import { deactivateGovtAction } from "@/app/actions/admin-institutional";
import { MOTIVO_MIN, MotivoField } from "@/components/MotivoField";
import { LnCheckbox } from "@/components/ui/Field";
import { OpButton } from "@/components/ui/dashboard";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";
import { useEvidenceUpload } from "@/lib/ui/use-evidence-upload";

type Target = {
  id: string;
  displayName: string;
  activeLocalityCount: number;
  /** Defaults to "govt". A national observer holds no localities. */
  role?: "govt" | "national";
};

/** The noun for the account in this form's copy. */
function accountNoun(target: Target): string {
  return target.role === "national" ? "observador nacional" : "gobierno";
}

type Mode = "idle" | "confirming" | "done";

export function DeactivateGovtActions({
  target,
}: {
  target: Target;
}) {
  const [mode, setMode] = useState<Mode>("idle");

  if (mode === "done") {
    return (
      <p className="text-sm text-ln-op-ok font-medium">
        {target.role === "national" ? "Observador nacional desactivado." : "Gobierno desactivado."}{" "}
        {target.displayName} fue notificado.
      </p>
    );
  }

  if (mode === "confirming") {
    return (
      <DeactivateGovtForm
        target={target}
        onDone={() => setMode("done")}
        onCancel={() => setMode("idle")}
      />
    );
  }

  return (
    <OpButton type="button" onClick={() => setMode("confirming")} variant="danger" size="sm">
      Desactivar {accountNoun(target)}
    </OpButton>
  );
}

// ---------------------------------------------------------------------------
// Form component
// ---------------------------------------------------------------------------

function DeactivateGovtForm({
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
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      // C23: upload on submit, namespaced by the TARGET govt id.
      const uploaded = await uploadAll(target.id);
      if ("error" in uploaded) {
        setError(uploaded.error);
        return;
      }

      const result = await deactivateGovtAction({
        targetGovtUserId: target.id,
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

  const localityWarning =
    target.activeLocalityCount > 0
      ? `Se revocarán ${target.activeLocalityCount} localidad${target.activeLocalityCount !== 1 ? "es activas" : " activa"}.`
      : null;

  return (
    <div className="rounded-[var(--radius-md)] border border-ln-op-danger-bd bg-ln-op-danger-bg p-3 space-y-3">
      <p className="text-xs uppercase tracking-wider font-bold text-ln-op-danger">
        Desactivar {accountNoun(target)} &mdash; {target.displayName}
      </p>
      <p className="text-xs text-ln-op-danger">
        Esta acción es irreversible desde esta interfaz. El usuario quedará desactivado y recibirá
        una notificación con el motivo.
        {localityWarning && <span className="block mt-1 font-medium">{localityWarning}</span>}
      </p>

      <MotivoField value={motivo} onChange={setMotivo} />

      <div className="space-y-1">
        <label
          htmlFor="deactivate-govt-evidence"
          className="block text-xs uppercase tracking-wider text-ln-op-mute"
        >
          Evidencia (al menos 1 archivo)
        </label>
        <input
          id="deactivate-govt-evidence"
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
        {target.role === "national"
          ? `Confirmo que quiero desactivar la cuenta de ${target.displayName}. Esta acción genera un registro permanente en el audit log.`
          : `Confirmo que quiero desactivar la cuenta de ${target.displayName} y revocar todas sus localidades activas. Esta acción genera un registro permanente en el audit log.`}
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

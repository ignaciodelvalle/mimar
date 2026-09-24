"use client";

// Revocation UI for vet role downgrade.
//
// State machine: idle → confirming → submitting → done | error
// Mirrors ProposeUserActions.tsx structure — design ADR-3.
//
// Evidence upload flow (design §3, spec REQ-6):
//   1. User picks files via <input type="file">
//   2. Each file is uploaded to Supabase Storage by the parent (via uploadRevocationEvidence)
//      and the resulting attachment IDs are accumulated in state.
//   3. On submit, attachmentIds[] are passed to revokeVetRoleAction.
//
// Client-side canRevoke hides the button when the actor clearly has no scope
// (defense-in-depth; server is authoritative).

import { useRef, useState, useTransition } from "react";

import { revokeVetRoleAction } from "@/app/actions/admin-revocations";
import { uploadRevocationEvidence } from "@/app/actions/revocation-evidence";
import { MOTIVO_MIN, MotivoField } from "@/components/MotivoField";
import { LnCheckbox } from "@/components/ui/Field";
import { OpButton } from "@/components/ui/dashboard";
import { canRevoke } from "@/lib/domain/revocation-scope";
import type { AdminOrGovtJurisdiction } from "@/lib/domain/revocation-scope";
import { createClient } from "@/lib/supabase/client";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";

type Target = {
  id: string;
  displayName: string;
  matriculaJurisdiccion: string | null;
  role: "owner" | "vet" | "govt" | "admin" | "national";
};

type UploadedFile = { name: string; attachmentId: string };

type Mode = "idle" | "confirming" | "done";

export function RevokeUserActions({
  target,
  actorUserId,
  actorRole,
  jurisdictions,
}: {
  target: Target;
  actorUserId: string;
  actorRole: "admin" | "govt";
  jurisdictions: readonly AdminOrGovtJurisdiction[];
}) {
  // Client-side capability check — server always re-validates.
  const canAct = canRevoke(
    { id: actorUserId, role: actorRole },
    {
      type: "vet_role",
      matriculaJurisdiccion: target.matriculaJurisdiccion ?? "",
    },
    jurisdictions,
  );

  if (!canAct || target.role !== "vet") return null;

  const [mode, setMode] = useState<Mode>("idle");

  if (mode === "done") {
    return (
      <p className="text-sm text-ln-op-ok">
        Rol vet revocado. {target.displayName} fue notificado.
      </p>
    );
  }

  if (mode === "confirming") {
    return (
      <RevokeVetForm
        target={target}
        actorUserId={actorUserId}
        onDone={() => setMode("done")}
        onCancel={() => setMode("idle")}
      />
    );
  }

  return (
    <OpButton type="button" onClick={() => setMode("confirming")} variant="danger" size="sm">
      Revocar rol vet
    </OpButton>
  );
}

// ---------------------------------------------------------------------------
// Form component
// ---------------------------------------------------------------------------

function RevokeVetForm({
  target,
  actorUserId,
  onDone,
  onCancel,
}: {
  target: Target;
  actorUserId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [motivo, setMotivo] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const motivoTrimmed = motivo.trim();
  const motivoValid = motivoTrimmed.length >= MOTIVO_MIN;
  const canSubmit = motivoValid && uploadedFiles.length >= 1 && confirm && !pending && !uploading;

  async function handleFilesChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    setError(null);
    setUploading(true);

    const supabase = createClient();
    const newFiles: UploadedFile[] = [];

    for (const file of files) {
      try {
        const ext = file.name.split(".").pop() ?? "bin";
        const path = `${actorUserId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

        const { error: storageError } = await supabase.storage
          .from("revocations")
          .upload(path, file, { contentType: file.type });

        if (storageError) {
          setError(`Error al subir ${file.name}: ${storageError.message}`);
          setUploading(false);
          return;
        }

        const result = await uploadRevocationEvidence({
          targetId: actorUserId,
          storagePath: path,
          mimeType: file.type,
          fileSize: file.size,
        });

        if ("error" in result) {
          setError(`Error al registrar ${file.name}: ${result.error}`);
          setUploading(false);
          return;
        }

        newFiles.push({ name: file.name, attachmentId: result.attachmentId });
      } catch (err) {
        setError(`Error inesperado subiendo ${file.name}.`);
        setUploading(false);
        return;
      }
    }

    setUploadedFiles((prev) => [...prev, ...newFiles]);
    setUploading(false);
    // Reset file input so the same file can be re-picked if removed.
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeFile(attachmentId: string) {
    setUploadedFiles((prev) => prev.filter((f) => f.attachmentId !== attachmentId));
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await revokeVetRoleAction({
        targetUserId: target.id,
        motivo: motivoTrimmed,
        attachmentIds: uploadedFiles.map((f) => f.attachmentId),
      });
      if ("error" in result) {
        setError(result.error);
      } else {
        onDone();
        // Full document reload so the SSR page reflects the revoked role —
        // mirrors RevokeOrgActions.tsx (audit-3-feedback §C2 asymmetry #4:
        // this file previously left the page stale after an equally
        // irreversible action). router.refresh() is banned — see
        // lib/ui/full-page-action-nav.ts.
        navigateAfterActionSuccess(window.location.href);
      }
    });
  }

  return (
    <div className="rounded-[var(--radius-md)] border border-ln-op-danger p-3 space-y-3 bg-ln-op-danger-bg">
      <p className="text-xs uppercase tracking-wider text-ln-op-danger">
        Revocar rol vet — {target.displayName}
      </p>
      <p className="text-xs text-ln-op-danger">
        Esta acción es irreversible desde esta interfaz. El usuario quedará como dueño y recibirá
        una notificación con el motivo.
      </p>

      <MotivoField value={motivo} onChange={setMotivo} />

      <div className="space-y-1">
        <label
          htmlFor="revoke-user-evidence-files"
          className="block text-xs uppercase tracking-wider text-ln-op-mute"
        >
          Evidencia (al menos 1 archivo)
        </label>
        <input
          ref={fileInputRef}
          id="revoke-user-evidence-files"
          type="file"
          accept="image/*,application/pdf"
          multiple
          onChange={handleFilesChange}
          disabled={uploading || pending}
          className="text-sm text-ln-op-ink-2"
        />
        {uploading && <p className="text-xs text-ln-op-mute">Subiendo...</p>}
        {uploadedFiles.length > 0 && (
          <ul className="space-y-0.5">
            {uploadedFiles.map((f) => (
              <li key={f.attachmentId} className="flex items-center gap-2 text-xs text-ln-op-ink-2">
                <span className="truncate max-w-[200px]">{f.name}</span>
                <button
                  type="button"
                  onClick={() => removeFile(f.attachmentId)}
                  className="text-ln-op-danger hover:underline shrink-0"
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
        Confirmo que quiero revocar el rol veterinario de {target.displayName}. Esta acción genera
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

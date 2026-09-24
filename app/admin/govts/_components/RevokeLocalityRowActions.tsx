"use client";

// Per-row locality revocation UI for the govt detail page.
//
// State machine: idle → confirming → submitting → done | error
// Mirrors RevokeUserActions.tsx structure — design §8.8.
//
// Wraps the existing revokeGovtLocalityAction from Fase 4 with the
// standard motivo + evidence upload pattern.
//
// Evidence (C23): files are held in state and uploaded on SUBMIT, namespaced by
// the TARGET assignment id. Cancelling never uploads — no orphaned objects.

import { useId, useRef, useState, useTransition } from "react";

import { revokeGovtLocalityAction } from "@/app/actions/admin-revocations";
import { MOTIVO_MIN, MotivoField } from "@/components/MotivoField";
import { LnCheckbox } from "@/components/ui/Field";
import { OpButton } from "@/components/ui/dashboard";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";
import { useEvidenceUpload } from "@/lib/ui/use-evidence-upload";

type Mode = "idle" | "confirming" | "done";

export function RevokeLocalityRowActions({
  assignmentId,
  localityLabel,
}: {
  assignmentId: string;
  localityLabel: string;
}) {
  const [mode, setMode] = useState<Mode>("idle");

  if (mode === "done") {
    return (
      <span className="text-xs text-ln-op-ok font-semibold uppercase tracking-wide">Revocada</span>
    );
  }

  if (mode === "confirming") {
    return (
      <RevokeLocalityForm
        assignmentId={assignmentId}
        localityLabel={localityLabel}
        onDone={() => setMode("done")}
        onCancel={() => setMode("idle")}
      />
    );
  }

  return (
    <OpButton type="button" onClick={() => setMode("confirming")} variant="danger" size="sm">
      Revocar
    </OpButton>
  );
}

// ---------------------------------------------------------------------------
// Form component
// ---------------------------------------------------------------------------

function RevokeLocalityForm({
  assignmentId,
  localityLabel,
  onDone,
  onCancel,
}: {
  assignmentId: string;
  localityLabel: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  // The evidence input's id comes from useId(), NEVER a literal.
  //
  // This form renders once PER LOCALITY ASSIGNMENT (app/admin/govts/[userId]/
  // page.tsx, inside a .map()). A hardcoded id gave every row the same one, so
  // `label.control` resolved to the FIRST input in the document for all of
  // them — and each row owns its own `mode`, with no single-open guard, so two
  // panels can be expanded at once. Expanded together, clicking row 2's
  // "Evidencia" label opened the picker bound to row 1's input, and the file
  // landed in the wrong form: the mandatory evidence of an AUDITED, destructive
  // revocation, attached to a different official's locality.
  //
  // Same defect and same remedy as the chapa revocation dialog (1861c614c) and
  // as components/MotivoField.tsx before it. Third time, so state the rule: a
  // control inside a repeated row never carries a literal id.
  const evidenceId = useId();
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
      // C23: upload on submit, namespaced by the TARGET assignment id.
      const uploaded = await uploadAll(assignmentId);
      if ("error" in uploaded) {
        setError(uploaded.error);
        return;
      }

      const result = await revokeGovtLocalityAction({
        govtAssignmentId: assignmentId,
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
    <div className="rounded-[var(--radius-md)] border border-ln-op-danger-bd bg-ln-op-danger-bg p-3 space-y-3 mt-2">
      <p className="text-xs uppercase tracking-wider font-bold text-ln-op-danger">
        Revocar localidad &mdash; {localityLabel}
      </p>

      <MotivoField value={motivo} onChange={setMotivo} />

      <div className="space-y-1">
        <label
          htmlFor={evidenceId}
          className="block text-xs uppercase tracking-wider text-ln-op-mute"
        >
          Evidencia (al menos 1 archivo)
        </label>
        <input
          id={evidenceId}
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
        Confirmo que quiero revocar la localidad {localityLabel}. Esta acción genera un registro
        permanente en el audit log.
      </LnCheckbox>

      {error && <p className="text-sm text-ln-op-danger">{error}</p>}

      <div className="flex items-center gap-2">
        <OpButton type="button" onClick={submit} disabled={!canSubmit} variant="danger" size="sm">
          {pending ? "Revocando..." : "Revocar localidad"}
        </OpButton>
        <OpButton type="button" onClick={onCancel} disabled={pending} variant="ghost" size="sm">
          Cancelar
        </OpButton>
      </div>
    </div>
  );
}

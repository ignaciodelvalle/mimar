"use client";

// Generic bulk-revoke wrapper for the 4 admin/govt queues:
//   - /admin/usuarios (targetKind='vet') — revoke vet roles
//   - /gob/usuarios (targetKind='vet')
//   - /admin/organizaciones (targetKind='org') — revoke org verification
//   - /gob/organizaciones (targetKind='org')
//
// Renders each item's pre-built `content` node with a checkbox.
// When ≥1 are selected, a floating action bar appears with a single
// "Revocar seleccionados" button that opens a modal collecting the
// shared motivo (≥30 chars) + evidence files. On submit, calls
// `bulkRevokeAction` and shows per-item success/failure inline.
//
// The single-item RevokeUserActions / RevokeOrgActions remain on the
// row for one-off revocations; this component is additive.

import { useEffect, useId, useRef, useState, useTransition } from "react";

import { type BulkRevokeKind, bulkRevokeAction } from "@/app/actions/bulk-actions";
import { uploadRevocationEvidence } from "@/app/actions/revocation-evidence";
import { Icon } from "@/components/Icon";
import { MOTIVO_MIN } from "@/components/MotivoField";
import { LnCheckbox } from "@/components/ui/Field";
import { OpBulkBar } from "@/components/ui/dashboard/OpBulkBar";
import { OpTextarea } from "@/components/ui/dashboard/OpField";
import { isPageFullySelected, toggleSelectPage, toggleSelection } from "@/lib/domain/bulk-select";
import { createClient } from "@/lib/supabase/client";

export interface BulkRevokableItem {
  id: string;
  label: string;
  /** Whether this item is eligible for bulk revocation. False hides the checkbox. */
  revocable: boolean;
  /** Server-rendered row content (JSX from the server page). */
  content: React.ReactNode;
}

type UploadedFile = { name: string; attachmentId: string };

interface Props {
  items: BulkRevokableItem[];
  targetKind: BulkRevokeKind;
}

export function BulkRevokeList({ items, targetKind }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [modalOpen, setModalOpen] = useState(false);

  function toggle(id: string) {
    setSelected((prev) => toggleSelection(prev, id));
  }

  const selectedItems = items.filter((i) => selected.has(i.id));

  // Header checkbox controls the revocable rows on the page only. "select all N
  // in query" is intentionally out of scope here — every revoke needs shared
  // evidence + a ≥30-char motivo, so a query-wide blind revoke would be unsafe.
  const revocableIds = items.filter((i) => i.revocable).map((i) => i.id);
  const allPageSelected = isPageFullySelected(selected, revocableIds);

  function handleToggleSelectPage() {
    setSelected((prev) => toggleSelectPage(prev, revocableIds));
  }

  return (
    <>
      {revocableIds.length > 0 && (
        <div className="flex items-center gap-2 px-1">
          <LnCheckbox
            checked={allPageSelected}
            onChange={handleToggleSelectPage}
            aria-label="Seleccionar todas las filas revocables de esta página"
          />
          <span className="text-sm text-ln-op-mute">Seleccionar página</span>
        </div>
      )}
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.id} className="rounded-lg border border-ln-op-line px-4 py-3">
            <div className="flex items-start gap-3">
              {item.revocable ? (
                <LnCheckbox
                  checked={selected.has(item.id)}
                  onChange={() => toggle(item.id)}
                  aria-label={`Seleccionar ${item.label} para revocación masiva`}
                  className="mt-1.5"
                />
              ) : (
                <div className="mt-1.5 h-4 w-4 shrink-0" aria-hidden />
              )}
              <div className="min-w-0 flex-1">{item.content}</div>
            </div>
          </li>
        ))}
      </ul>

      <OpBulkBar
        count={selectedItems.length}
        onClear={() => setSelected(new Set())}
        actions={[
          {
            key: "revoke",
            label: "Revocar seleccionados",
            tone: "danger",
            // Opens the evidence+motivo modal rather than a reason-only confirm:
            // bulkRevokeAction requires ≥1 attachment + a ≥30-char motivo, which
            // the generic ConfirmDialog reason field cannot collect.
            onRun: () => setModalOpen(true),
          },
        ]}
      />

      {modalOpen && (
        <BulkRevokeModal
          selectedItems={selectedItems}
          targetKind={targetKind}
          onClose={() => setModalOpen(false)}
          onDone={() => {
            setModalOpen(false);
            setSelected(new Set());
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

interface ModalProps {
  selectedItems: BulkRevokableItem[];
  targetKind: BulkRevokeKind;
  onClose: () => void;
  onDone: () => void;
}

function BulkRevokeModal({ selectedItems, targetKind, onClose, onDone }: ModalProps) {
  const [pending, startTransition] = useTransition();
  const [motivo, setMotivo] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    succeeded: string[];
    failed: { id: string; reason: string }[];
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const evidenciaInputId = useId();
  const modalHeadingId = useId();
  const modalDescId = useId();
  // RA-9 BR-2 — the panel used to be a plain <div role="dialog" aria-modal="true">:
  // it TOLD assistive tech the rest of the page was inert while nothing was inert
  // and nothing trapped, focus never moved in and never restored on close, and the
  // outcome ("N revocaciones aplicadas · M fallaron") of an irreversible bulk act
  // replaced the form with no live region and no focus move — announced to nobody.
  // Native <dialog>.showModal() supplies the top layer, the inertness, the focus
  // trap and the Escape/`cancel` event; the refs below add the two things the
  // platform does NOT: initial focus into the modal, and the result announcement.
  const dialogRef = useRef<HTMLDialogElement>(null);
  const motivoRef = useRef<HTMLTextAreaElement>(null);
  const resultHeadingRef = useRef<HTMLParagraphElement>(null);

  // Open as a MODAL dialog (top layer + inert background + native focus trap).
  // jsdom does not implement showModal(); fall back to the `open` attribute there
  // so tests can still read the tree — production browsers always take the first
  // branch.
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    // Remember who opened us so focus can go back there on close — the modal is
    // mounted/unmounted by the parent, so "close" is this effect's cleanup.
    const opener = document.activeElement as HTMLElement | null;
    if (!el.open) {
      if (typeof el.showModal === "function") el.showModal();
      else el.setAttribute("open", "");
    }
    // Initial focus lands on the first control the operator must fill, not on the
    // dialog box itself — showModal() alone focuses the dialog, which announces
    // the name but leaves the operator a Tab away from the form.
    motivoRef.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  // Escape (native `cancel`) must sync back to React state, or the dialog closes
  // in the DOM while the parent still believes it is open.
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const handleCancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    el.addEventListener("cancel", handleCancel);
    return () => el.removeEventListener("cancel", handleCancel);
  }, [onClose]);

  // Move focus onto the outcome sentence once the bulk action reports back. The
  // <output aria-live="polite"> announces it; the focus move means a keyboard
  // user's next Tab starts from the result, not from the top of the page.
  useEffect(() => {
    if (result) resultHeadingRef.current?.focus();
  }, [result]);

  const motivoTrimmed = motivo.trim();
  const motivoValid = motivoTrimmed.length >= MOTIVO_MIN;
  const canSubmit =
    motivoValid && uploadedFiles.length >= 1 && confirm && !pending && !uploading && !result;

  async function handleFilesChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    setError(null);
    setUploading(true);

    const supabase = createClient();

    // Storage-path namespace: the viewer's own uid from the client session.
    // The server action re-derives the actor from ITS session — this value
    // never feeds authorization (authz triage 2026-07-04).
    const {
      data: { user: sessionUser },
    } = await supabase.auth.getUser();
    if (!sessionUser) {
      setError("Sesión expirada.");
      setUploading(false);
      return;
    }

    const newFiles: UploadedFile[] = [];

    for (const file of files) {
      try {
        const ext = file.name.split(".").pop() ?? "bin";
        const path = `${sessionUser.id}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
        const { error: storageError } = await supabase.storage
          .from("revocations")
          .upload(path, file, { contentType: file.type });
        if (storageError) {
          setError(`Error al subir ${file.name}: ${storageError.message}`);
          setUploading(false);
          return;
        }
        const r = await uploadRevocationEvidence({
          targetId: sessionUser.id,
          storagePath: path,
          mimeType: file.type,
          fileSize: file.size,
        });
        if ("error" in r) {
          setError(`Error al registrar ${file.name}: ${r.error}`);
          setUploading(false);
          return;
        }
        newFiles.push({ name: file.name, attachmentId: r.attachmentId });
      } catch {
        setError(`Error inesperado subiendo ${file.name}.`);
        setUploading(false);
        return;
      }
    }
    setUploadedFiles((prev) => [...prev, ...newFiles]);
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const r = await bulkRevokeAction({
        targetIds: selectedItems.map((i) => i.id),
        targetKind,
        motivo: motivoTrimmed,
        attachmentIds: uploadedFiles.map((f) => f.attachmentId),
      });
      setResult({ succeeded: r.succeeded, failed: r.failed });
    });
  }

  // MOT-4a (motion audit Gap 3): `op-dialog-enter` gives this the same
  // entry-only scale+fade as ConfirmDialog — it is the other native <dialog>
  // guarding an irreversible act. Entry yes, exit no (audit §5.4).
  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      aria-labelledby={modalHeadingId}
      aria-describedby={modalDescId}
      aria-modal="true"
      className="op-dialog-enter max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-ln-op-card p-6 shadow-xl backdrop:bg-black/50"
    >
      <div>
        <header className="mb-4 flex items-baseline justify-between gap-3">
          <h2 id={modalHeadingId} className="text-lg font-semibold text-ln-op-danger">
            Revocar {selectedItems.length} {targetKindLabel(targetKind, selectedItems.length)}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-ln-op-mute hover:text-ln-op-ink"
          >
            Cerrar
          </button>
        </header>
        <p id={modalDescId} className="sr-only">
          Revocación masiva irreversible sobre {selectedItems.length}{" "}
          {targetKindLabel(targetKind, selectedItems.length)}. Cada afectado recibe una notificación
          con el motivo. Requiere un motivo de al menos {MOTIVO_MIN} caracteres y al menos un
          archivo de evidencia.
        </p>

        {result ? (
          <output aria-live="polite" className="block space-y-3">
            <p
              ref={resultHeadingRef}
              tabIndex={-1}
              className="text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ln-op-azul"
            >
              <strong className="text-ln-op-ok">
                {result.succeeded.length} revocaciones aplicadas
              </strong>
              {result.failed.length > 0 && (
                <>
                  {" · "}
                  <strong className="text-ln-op-danger">{result.failed.length} fallaron</strong>
                </>
              )}
              .
            </p>
            {result.failed.length > 0 && (
              <ul className="space-y-1 rounded-lg border border-ln-op-danger-bd bg-ln-op-danger-bg p-3 text-xs">
                {result.failed.map((f) => (
                  <li key={f.id} className="text-ln-op-danger">
                    <span className="font-ln-mono">{f.id.slice(0, 8)}…</span> — {f.reason}
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              onClick={onDone}
              className="w-full rounded-md bg-ln-op-azul px-4 py-2 text-sm font-medium text-white hover:bg-ln-op-azul-700"
            >
              Recargar lista
            </button>
          </output>
        ) : (
          <div className="space-y-4">
            <details className="rounded-lg border border-ln-op-line bg-ln-op-stripe p-3 text-sm">
              <summary className="cursor-pointer font-medium">
                {selectedItems.length} {targetKindLabel(targetKind, selectedItems.length)}{" "}
                alcanzados
              </summary>
              <ul className="mt-2 max-h-32 space-y-0.5 overflow-y-auto pl-4 text-xs text-ln-op-ink-2">
                {selectedItems.map((i) => (
                  <li key={i.id}>{i.label}</li>
                ))}
              </ul>
            </details>

            <div>
              <label
                htmlFor="bulk-revoke-motivo"
                className="mb-1 block text-xs font-medium text-ln-op-ink-2"
              >
                Motivo (mínimo {MOTIVO_MIN} caracteres)
              </label>
              <OpTextarea
                id="bulk-revoke-motivo"
                ref={motivoRef}
                aria-required="true"
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                rows={4}
                placeholder="Describí el motivo común para todas las revocaciones de esta operación."
                size="xs"
              />
              <p className="mt-1 text-xs text-ln-op-mute">
                {motivoTrimmed.length}/{MOTIVO_MIN} caracteres
              </p>
            </div>

            <div>
              <label
                htmlFor={evidenciaInputId}
                className="mb-1 block text-xs font-medium text-ln-op-ink-2"
              >
                Evidencia (al menos 1 archivo)
              </label>
              <input
                id={evidenciaInputId}
                type="file"
                ref={fileInputRef}
                onChange={handleFilesChange}
                multiple
                className="block w-full text-xs"
              />
              {uploading && <p className="mt-1 text-xs text-ln-op-mute">Subiendo archivos…</p>}
              {uploadedFiles.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs">
                  {uploadedFiles.map((f) => (
                    <li key={f.attachmentId} className="flex items-center gap-1 text-ln-op-ok">
                      <Icon name="check" size={14} decorative /> {f.name}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <LnCheckbox
              checked={confirm}
              onChange={(e) => setConfirm(e.target.checked)}
              labelClassName="text-xs! text-ln-op-ink-2!"
            >
              Confirmo que esta revocación afecta a {selectedItems.length}{" "}
              {targetKindLabel(targetKind, selectedItems.length)} y entiendo que cada afectado va a
              recibir una notificación con el motivo.
            </LnCheckbox>

            {error && (
              <p role="alert" className="text-sm text-ln-op-danger">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2 border-t border-ln-op-line pt-3">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md px-4 py-2 text-sm text-ln-op-ink-2 hover:bg-ln-op-stripe"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={!canSubmit}
                className="rounded-md bg-ln-op-danger px-4 py-2 text-sm font-medium text-white hover:bg-ln-op-danger disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pending ? "Revocando…" : "Revocar seleccionados"}
              </button>
            </div>
          </div>
        )}
      </div>
    </dialog>
  );
}

function targetKindLabel(kind: BulkRevokeKind, count: number): string {
  if (kind === "vet") return count === 1 ? "matrícula vet" : "matrículas vet";
  if (kind === "org") return count === 1 ? "organización" : "organizaciones";
  return count === 1 ? "asignación govt" : "asignaciones govt";
}

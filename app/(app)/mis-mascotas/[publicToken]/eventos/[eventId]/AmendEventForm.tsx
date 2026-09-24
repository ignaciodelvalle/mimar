"use client";

// AmendEventForm — form to submit a correction (amendment) for a pet event.
//
// Design (Wave 2 Item 15 D1-D5):
//   - Prefills current payload values as the "old" value for each field.
//   - User edits the new value per field.
//   - Requires a reason (will be surfaced to admin/govt as mandatory, optional
//     for owner/vet — both validated server-side).
//   - On submit → ConfirmDialog → amendEventAction → redirect to event page.
//
// Uses the native <dialog> element (same pattern as ConfirmDialog) so the
// browser provides focus trap and Escape-key dismissal automatically.
// The form intentionally renders field entries as a simple list of
// key → old → new. It is not event-type-specific (D1 says "no new schema").

import { amendEventAction } from "@/app/actions/amendment";
import { Icon } from "@/components/Icon";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { LnField, LnInput, LnTextarea } from "@/components/ui/Field";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";
import { useEffect, useRef, useState, useTransition } from "react";

export type AmendEventFormProps = {
  eventId: string;
  eventType: string;
  currentPayload: Record<string, unknown>;
  publicToken: string;
  onClose: () => void;
  triggerRef?: React.RefObject<HTMLElement | null>;
};

// Fields excluded from the amendment form — internal/system fields.
const EXCLUDED_FIELDS = new Set([
  "payload_version",
  "actor_role",
  "actor_user_id",
  "target_event_id",
]);

function formatFieldLabel(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function stringifyValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

export function AmendEventForm({
  eventId,
  eventType,
  currentPayload,
  publicToken,
  onClose,
  triggerRef,
}: AmendEventFormProps) {
  const [isPending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Editable fields: current payload keys minus excluded ones.
  const editableFields = Object.keys(currentPayload).filter((k) => !EXCLUDED_FIELDS.has(k));

  const [fieldValues, setFieldValues] = useState<Record<string, string>>(
    Object.fromEntries(editableFields.map((k) => [k, stringifyValue(currentPayload[k])])),
  );

  // Open the native dialog on mount (always open when rendered).
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (!el.open) el.showModal();
  }, []);

  // Sync native cancel event (Escape key) back to React state.
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

  // Return focus to the trigger when the dialog closes.
  useEffect(() => {
    return () => {
      if (triggerRef?.current) {
        (triggerRef.current as HTMLElement).focus();
      }
    };
  }, [triggerRef]);

  function handleFieldChange(key: string, value: string) {
    setFieldValues((prev) => ({ ...prev, [key]: value }));
  }

  function buildChanges(): Array<{ field: string; old: unknown; new: unknown }> {
    return editableFields
      .filter((k) => stringifyValue(currentPayload[k]) !== fieldValues[k])
      .map((k) => ({
        field: k,
        old: currentPayload[k],
        new: fieldValues[k],
      }));
  }

  function handleSubmitClick() {
    const changes = buildChanges();
    if (changes.length === 0) {
      setError("No modificaste ningún campo. Hacé al menos un cambio antes de corregir.");
      return;
    }
    setError(null);
    setConfirmOpen(true);
  }

  function handleConfirm() {
    const changes = buildChanges();
    startTransition(async () => {
      const result = await amendEventAction({
        publicToken,
        targetEventId: eventId,
        reason: reason.trim() || null,
        changes,
      });
      setConfirmOpen(false);
      if (result.ok) {
        // Full document reload of the event page: the libreta projection and
        // amendment chain are server-derived, and router.refresh() is banned
        // (silent-drop defect — see lib/ui/full-page-action-nav.ts). The
        // reload also closes this dialog, so no onClose() needed.
        navigateAfterActionSuccess(window.location.href);
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <>
      {/* Native dialog — browser provides focus trap and Escape key handling. */}
      <dialog
        ref={dialogRef}
        aria-label="Corregir registro"
        onClose={onClose}
        className={[
          "m-auto w-full max-w-lg max-h-[90dvh] overflow-y-auto p-0",
          "rounded-[var(--radius-md)] border border-[var(--color-ln-line-strong)]",
          "bg-[var(--color-ln-card)] shadow-[0_18px_50px_rgba(20,40,60,.22)]",
          "[&::backdrop]:bg-black/40",
          "open:flex open:flex-col",
        ].join(" ")}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[var(--color-ln-line)] bg-[var(--color-ln-card)] px-5 py-4">
          <div>
            <p className="font-ln-mono text-xs uppercase tracking-[.3em] text-[var(--color-ln-mute)]">
              Corrección por enmienda
            </p>
            <h2 className="mt-0.5 font-ln-serif text-lg font-semibold text-[var(--color-ln-ink)]">
              Corregir registro
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-[var(--radius-pill)] p-1.5 text-[var(--color-ln-mute)] hover:bg-[var(--color-ln-stripe)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ln-azul)]"
            aria-label="Cerrar"
          >
            <Icon name="close" size="sm" decorative />
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-col gap-4 px-5 py-5">
          {/* Info banner */}
          <div
            className="rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] px-3.5 py-2.5"
            role="note"
          >
            <p className="font-ln-mono text-sm text-[var(--color-ln-mute)] leading-relaxed">
              La libreta es inmutable. Esta corrección agrega un nuevo registro que reemplaza el
              valor mostrado. El registro original queda visible en el historial.
            </p>
          </div>

          {/* Error */}
          {error && (
            <div
              role="alert"
              className="rounded-[var(--radius-sm)] border border-[var(--color-ln-seal)] bg-[var(--color-ln-seal-bg,var(--color-ln-stripe))] px-3.5 py-2.5"
            >
              <p className="text-md text-[var(--color-ln-seal)]">{error}</p>
            </div>
          )}

          {/* Editable fields */}
          {editableFields.length === 0 ? (
            <p className="text-md text-[var(--color-ln-mute)] italic">
              Este evento no tiene campos editables.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {editableFields.map((key) => (
                <div
                  key={key}
                  className="rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] p-3"
                >
                  <p className="font-ln-mono text-xs uppercase tracking-[.08em] text-[var(--color-ln-mute)] mb-1.5">
                    {formatFieldLabel(key)}
                  </p>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div>
                      <p className="font-ln-mono text-xs uppercase tracking-[.08em] text-[var(--color-ln-mute)] mb-0.5">
                        Valor actual
                      </p>
                      <p className="rounded-[var(--radius-sm)] bg-[var(--color-ln-stripe)] px-2.5 py-2 text-sm text-[var(--color-ln-ink-2)] min-h-[36px] break-words">
                        {stringifyValue(currentPayload[key]) || (
                          <span className="italic text-[var(--color-ln-mute)]">vacío</span>
                        )}
                      </p>
                    </div>
                    <div>
                      <p className="font-ln-mono text-xs uppercase tracking-[.08em] text-[var(--color-ln-mute)] mb-0.5">
                        Nuevo valor
                      </p>
                      <LnInput
                        id={`field-${key}`}
                        name={`field-${key}`}
                        value={fieldValues[key] ?? ""}
                        onChange={(e) => handleFieldChange(key, e.target.value)}
                        aria-label={`Nuevo valor para ${formatFieldLabel(key)}`}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Reason */}
          <LnField
            label="Motivo de la corrección"
            optional
            hint="Obligatorio para administradores y gobierno"
          >
            {({ id }) => (
              <LnTextarea
                id={id}
                name="reason"
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Describí brevemente por qué se corrige este dato."
              />
            )}
          </LnField>
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 flex justify-end gap-2 border-t border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] px-5 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className={[
              "rounded-[var(--radius-pill)] border border-[var(--color-ln-line-strong)]",
              "bg-[var(--color-ln-card)] px-4 py-2 text-md font-medium text-[var(--color-ln-ink)]",
              "hover:bg-[var(--color-ln-stripe)] transition-colors min-h-[44px]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ln-azul)]",
            ].join(" ")}
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleSubmitClick}
            disabled={isPending || editableFields.length === 0}
            className={[
              "rounded-[var(--radius-pill)] px-4 py-2 text-md font-semibold text-white",
              "bg-[var(--color-ln-azul)] hover:bg-[var(--color-ln-azul-700,var(--color-ln-azul))]",
              "disabled:opacity-50 transition-opacity min-h-[44px]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-[var(--color-ln-azul)]",
            ].join(" ")}
          >
            Confirmar corrección
          </button>
        </div>
      </dialog>

      {/* Confirm dialog */}
      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={handleConfirm}
        title="Confirmar corrección"
        description="Esta acción agrega un registro de corrección. El valor original queda en el historial. ¿Confirmás?"
        confirmLabel="Confirmar corrección"
        cancelLabel="Volver"
        tone="neutral"
        pending={isPending}
        triggerRef={triggerRef as React.RefObject<HTMLButtonElement>}
      />
    </>
  );
}

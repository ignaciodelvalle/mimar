"use client";

// ConfirmDialog — accessible modal confirmation dialog backed by <dialog>.showModal().
//
// Uses the native <dialog> element so the browser provides:
//   - Automatic focus trap (keyboard navigation stays inside the dialog)
//   - Escape key dismissal via the native `cancel` event
//   - Proper aria role without manual role="dialog" hacks
//
// Design tokens: supports both ln-* (owner tier) and ln-op-* (operator tier).
// Tone prop controls the destructive-action button color.
//
// THE RULE for irreversible/destructive actions (audit-3-feedback §C2,
// 2026-07-21) — never a bare one-click, and never a bespoke ad-hoc inline
// panel invented per-component. Two tiers, chosen by whether the action
// needs an audit-log justification:
//
//   1. ConfirmDialog (this component) — the default for any irreversible
//      action that does NOT require a recorded reason/evidence: a single
//      confirm step naming the consequence (see `description`) is enough
//      weight. Use this unless tier 2 applies.
//   2. Inline mode-switch + mandatory reason (and, for the highest-stakes
//      admin/govt actions, a required evidence upload + explicit
//      acknowledgment checkbox) — for actions whose audit trail must carry
//      a motivo, e.g. RevokeOrgActions.tsx / RevokeUserActions.tsx
//      (org/role revocation), ResetCredentialsButton.tsx (credential
//      rotation). This tier is intentionally HEAVIER than ConfirmDialog,
//      not a lighter shortcut around it — the checkbox-acknowledgment
//      pattern is stronger, not weaker, confirmation. Do not use a bare
//      inline panel with no reason field for an action that would
//      otherwise warrant one.
//
// Either tier is acceptable; picking a THIRD, unweighted pattern (a plain
// one-click button, or an inline panel with no reason field pretending to
// be tier 2) for a genuinely irreversible action is the violation.
//
// `description` must state the CONSEQUENCE ("Esto revoca el acceso de X
// y..."), not just ask "¿Estás seguro?" — a bare confirmation question
// with no stated outcome forces the user to already know what happens,
// which defeats the point of a confirm step.
//
// THE GRAMMAR OF CONFIRMATION (PO decision D.3, 2026-07-30) — the confirm
// button carries the VERB OF THE ACT ("Revocar", "Aceptar custodia",
// "Resolver disputa"), NEVER "Confirmar": not bare, and not as the leading
// verb of "Confirmar + noun" ("Confirmar reasignación" → "Reasignar"). A
// button that says "Confirmar" describes the user's click, not the outcome;
// the person reading it still has to reconstruct what they are about to do.
// Friction scales with CONSEQUENCE, not with the wording: irreversible or
// legally weighty acts get a modal that STATES the consequence; reversible
// ones stay inline with the verb on the button.
//
// `confirmLabel` therefore has NO DEFAULT — omitting it is a compile error, so
// no future call site can silently fall back into the generic label. The
// regression fence is __tests__/confirm-label-grammar.guard.test.ts, which
// fails on any confirm-style label that is exactly "Confirmar".
//
// Usage:
//   const [open, setOpen] = useState(false);
//   const triggerRef = useRef<HTMLButtonElement>(null);
//
//   <button ref={triggerRef} onClick={() => setOpen(true)}>Eliminar</button>
//   <ConfirmDialog
//     open={open}
//     onClose={() => setOpen(false)}
//     onConfirm={handleDelete}
//     title="Eliminar regla"
//     description="Esta acción no se puede deshacer."
//     confirmLabel="Eliminar"
//     tone="danger"
//     triggerRef={triggerRef}
//   />

import { useEffect, useRef } from "react";

export type ConfirmDialogTone = "danger" | "warn" | "neutral";

const confirmBtnClass: Record<ConfirmDialogTone, string> = {
  danger: "bg-[var(--color-ln-seal)] hover:opacity-90 focus-visible:ring-[var(--color-ln-seal)]",
  warn: "bg-[var(--color-ln-warn)] hover:opacity-90 focus-visible:ring-[var(--color-ln-warn)]",
  neutral:
    "bg-[var(--color-ln-azul)] hover:bg-[var(--color-ln-azul-700)] focus-visible:ring-[var(--color-ln-azul)]",
};

export type ConfirmDialogProps = {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  /**
   * The consequence sentence. Wired to the dialog via `aria-describedby`, so a
   * screen reader speaks it as part of the dialog announcement (RA-9 BR-3) —
   * without that wiring `showModal()` announces only the title plus the focused
   * Cancel button, and the consequence is never read aloud.
   */
  description?: string;
  /**
   * REQUIRED — the label carries the VERB OF THE ACT ("Revocar", "Aceptar
   * custodia"), never the generic "Confirmar" (PO decision D.3, 2026-07-30).
   * There is deliberately NO default: the compiler must force every call site
   * to name its act, so no future caller can fall back into the generic label
   * by omission. See the "grammar of confirmation" rule below.
   */
  confirmLabel: string;
  cancelLabel?: string;
  tone?: ConfirmDialogTone;
  pending?: boolean;
  /** Ref to the element that triggered the dialog — focus returns here on close. */
  triggerRef?: React.RefObject<HTMLElement | null>;
  /**
   * Optional extra content rendered between the description and the footer
   * actions — e.g. a mandatory-reason textarea. The confirm button's enabled
   * state is the caller's responsibility (gate `onConfirm` on validity).
   */
  children?: React.ReactNode;
};

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancelar",
  tone = "danger",
  pending = false,
  triggerRef,
  children,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useRef(`confirm-dialog-title-${Math.random().toString(36).slice(2)}`).current;
  // RA-9 BR-3: showModal() puts initial focus on Cancel, so the AT announces the
  // dialog NAME plus the focused control — the `description` (the sentence that
  // STATES the consequence, the entire point of D.3's "modal that states the
  // consequence") was spoken by nobody. aria-describedby is what makes the
  // browser read it as part of the dialog announcement.
  const descId = useRef(`confirm-dialog-desc-${Math.random().toString(36).slice(2)}`).current;
  // Tracks whether THIS instance has actually been open, so the focus-restore
  // effect below only fires on a real open→close transition — see its comment.
  const wasOpenRef = useRef(false);

  // Open/close the native dialog imperatively.
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;

    if (open) {
      if (!el.open) el.showModal();
    } else {
      if (el.open) el.close();
    }
  }, [open]);

  // Sync native cancel event (Escape key) back to React state.
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const handleCancel = (e: Event) => {
      e.preventDefault(); // prevent the browser from closing before React state syncs
      onClose();
    };
    el.addEventListener("cancel", handleCancel);
    return () => el.removeEventListener("cancel", handleCancel);
  }, [onClose]);

  // Return focus to the trigger when the dialog closes — but ONLY on a real
  // open→close transition, not on initial mount (`open` starts `false`).
  // ROOT CAUSE (QA 2026-07-21, /gob/decomisos landing scrolled to the bottom
  // row on every load and after every filter change): a page can render MANY
  // ConfirmDialog instances at once — one per list row (Reasignar/Devolver al
  // dueño per decomiso). Every instance mounts with `open=false`, so without
  // `wasOpenRef` this effect fired on EVERY instance's mount, each one
  // stealing focus via `triggerRef.current.focus()`; the LAST instance in DOM
  // order (the bottom-most row) always won the race, and the browser
  // auto-scrolled that now-focused button into view — silently landing the
  // whole page at the bottom instead of the top. `wasOpenRef` gates the
  // refocus so it only happens after THIS instance was genuinely opened
  // (user clicked its trigger) and then closed.
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      return;
    }
    if (wasOpenRef.current && triggerRef?.current) {
      triggerRef.current.focus();
    }
  }, [open, triggerRef]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      aria-modal="true"
      onClose={onClose}
      className={[
        // MOT-4a (motion audit Gap 3): a 150ms scale+fade ENTRY, no exit —
        // see the .op-dialog-enter block in app/globals.css for why the
        // asymmetry is deliberate.
        "op-dialog-enter",
        "m-auto max-w-[360px] w-full rounded-[var(--radius-md)] p-0",
        "border border-[var(--color-ln-line-strong)]",
        "bg-[var(--color-ln-card)] shadow-[0_18px_50px_rgba(20,40,60,.22)]",
        // Backdrop via CSS — the native ::backdrop pseudo-element
        "[&::backdrop]:bg-black/40",
        "open:flex open:flex-col",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Header */}
      <div className="px-5 pt-5 pb-3">
        <h2
          id={titleId}
          className="text-base font-semibold text-[var(--color-ln-ink)] leading-snug"
        >
          {title}
        </h2>
        {description && (
          <p id={descId} className="mt-1.5 text-md text-[var(--color-ln-ink-2)] leading-snug">
            {description}
          </p>
        )}
      </div>

      {/* Optional extra content (e.g. mandatory-reason textarea) */}
      {children}

      {/* Footer actions */}
      <div className="flex gap-2 justify-end px-5 py-4 border-t border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)]">
        <button
          type="button"
          onClick={onClose}
          disabled={pending}
          className={[
            "rounded-[var(--radius-pill)] border border-[var(--color-ln-line-strong)]",
            "bg-[var(--color-ln-card)] px-4 py-2 text-sm font-medium",
            "text-[var(--color-ln-ink)] hover:bg-[var(--color-ln-stripe)]",
            "disabled:opacity-50 transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ln-azul)]",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={pending}
          className={[
            "rounded-[var(--radius-pill)] px-4 py-2 text-sm font-semibold text-white",
            "disabled:opacity-50 transition-opacity",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1",
            confirmBtnClass[tone],
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {pending ? "Procesando…" : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

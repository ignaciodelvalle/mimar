"use client";

// action-feedback — the mutation-feedback convention companion to
// full-page-action-nav.ts / use-action-redirect.ts.
//
// WHY (audit-3-feedback §C1, 2026-07-21): sonner's <Toaster/> is mounted
// globally (components/Toaster.tsx) but before this file only had 2 real
// `toast.*` call sites in the whole app — the audit found ~85%+ of
// mutations give no explicit success feedback at all. This file is the
// convention fix, not a full sweep: it establishes ONE rule and adopts it
// on a handful of representative call sites so the pattern is provable and
// repeatable, rather than converting every mutation in one pass.
//
// THE RULE — exactly two sanctioned ways a mutation confirms success:
//
//   1. Full-page reload (`navigateAfterActionSuccess` / `useActionRedirect`,
//      lib/ui/full-page-action-nav.ts) — for actions that legitimately
//      navigate, or where the SSR page must re-render to stay truthful
//      (status pills, revoked/verified badges, business-rule CRUD lists).
//      The reload itself IS the confirmation. Do NOT also fire a toast on
//      top of a reload — the page changing and a toast both firing is a
//      double-signal for the same event, and the toast gets wiped by the
//      navigation anyway.
//   2. `notifySaved` / `notifyActionError` (this file) — for in-place
//      mutations that intentionally stay mounted after success (no reload,
//      no navigation). These need SOME explicit signal since nothing else
//      visibly changes; a lightweight toast is it. This can run ALONGSIDE
//      an existing persistent inline confirmation string (e.g. a result
//      panel that also states a substantive detail like "fue notificado")
//      — the toast is the immediate transient cue, the inline text is the
//      durable one; they're complementary, not redundant.
//
//      `notifyUndoable` (Lote Q, Q5) is a REFINEMENT of this second
//      mechanism, not a third one: the same success toast, plus a
//      "Deshacer" action button. It is ONLY for mutations whose inverse is
//      a REAL, first-class server action that restores the exact prior
//      state (e.g. welfare self-assign ↔ unassign). In an append-only
//      events system most actions have NO honest inverse — anything that
//      sent a notification, appended a medical/legal event, or overwrote
//      heterogeneous per-row state must NOT fake one; a "Deshacer" that
//      performs an approximate rollback is worse than none. The undo
//      callback commits through the normal server-action path and confirms
//      with the standard toast; it never touches navigation.
//
// Do not invent a third pattern (bespoke "Guardado" banners with no toast,
// silent success, etc.) without updating this doc comment — the whole
// point of §C1 was to stop the ad hoc per-component choice the audit found
// (full-reload vs inline-text-only vs toast, picked with no written rule).
//
// Usage:
//   import { notifySaved, notifyActionError } from "@/lib/ui/action-feedback";
//   notifySaved("Transferencia aceptada");
//   notifyActionError("No se pudo guardar. Probá de nuevo.");
//   notifyUndoable("Te asignaste la denuncia", { onUndo: () => undoAction() });

import { toast } from "sonner";

/** Fires the standard success toast for an in-place (non-reloading) mutation. */
export function notifySaved(message = "Listo"): void {
  toast.success(message);
}

/** Fires the standard error toast for an in-place (non-reloading) mutation.
 * Most components already render an inline error string next to the
 * trigger (the form/field-level detail); reach for this only when there's
 * no better-placed inline error surface for the failure. */
export function notifyActionError(message: string): void {
  toast.error(message);
}

/** How long an undoable toast stays up — longer than sonner's 4s default so
 * "Deshacer" is realistically reachable, short enough that the offer never
 * outlives the operator's memory of what it would undo. */
export const UNDOABLE_TOAST_DURATION_MS = 8000;

/**
 * Fires the standard success toast WITH a "Deshacer" action (mechanism #2
 * refinement — see the module doc for when an undo is honest and when it
 * must not be offered). `onUndo` runs the real inverse server action; its
 * own success/failure feedback is the caller's job (standard notifySaved /
 * notifyActionError), since this module cannot know the inverse's outcome.
 */
export function notifyUndoable(
  message: string,
  undo: { label?: string; onUndo: () => void | Promise<void> },
): void {
  toast.success(message, {
    duration: UNDOABLE_TOAST_DURATION_MS,
    action: {
      label: undo.label ?? "Deshacer",
      onClick: () => void undo.onUndo(),
    },
  });
}

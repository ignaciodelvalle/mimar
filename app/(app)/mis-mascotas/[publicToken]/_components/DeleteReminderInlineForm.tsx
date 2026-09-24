"use client";

// DeleteReminderInlineForm — client island for the "Eliminar" button on a
// reminder row inside PetReminders (which stays a Server Component).
//
// Needed because deleteVaccineReminderAction follows the N3 redirect contract:
// it returns `redirectTo` on success and the calling form performs the full
// document navigation via useActionRedirect (lib/ui/use-action-redirect.ts)
// instead of relying on a server-side redirect() the App Router can silently
// drop. On a delete that drop is the worst shape of the defect: the row really
// is gone and the person watches nothing happen, then presses again.
//
// Same shape as components/pet-profile/MarkFoundInlineForm.tsx.

import { deleteVaccineReminderAction } from "@/app/actions/reminders";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useActionState } from "react";

export function DeleteReminderInlineForm({
  petToken,
  reminderId,
}: {
  petToken: string;
  reminderId: string;
}) {
  const boundAction = deleteVaccineReminderAction.bind(null, petToken, reminderId);
  const [state, formAction, isPending] = useActionState(boundAction, { error: null });
  // `navigating` keeps the button busy until the document actually leaves —
  // window.location.assign() returns at once, and a control that re-enabled
  // over the old page invites the second press (X1-F1).
  const navigating = useActionRedirect(state.redirectTo, state);
  const busy = isPending || navigating;

  return (
    <form action={formAction}>
      <button
        type="submit"
        disabled={busy}
        className="px-3 py-1.5 rounded-[var(--radius-pill)] border border-[var(--color-ln-line)] text-[var(--color-ln-ink-2)] text-xs font-medium hover:bg-[var(--color-ln-stripe)] transition-colors disabled:opacity-50"
      >
        {busy ? "Eliminando…" : "Eliminar"}
      </button>
      {state.error && (
        <p role="alert" className="mt-1 text-xs text-[var(--color-ln-err)]">
          {state.error}
        </p>
      )}
    </form>
  );
}

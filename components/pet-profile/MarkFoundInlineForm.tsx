"use client";

// MarkFoundInlineForm — client island for the "Apareció · marcar
// encontrado/a" button inside LostCaseBlock's StaleLostCaseBanner (which
// stays a Server Component). Needed because setPetFoundAction follows the
// N3 redirect contract: it returns `redirectTo` on success and the calling
// form performs the full document navigation (see
// lib/ui/use-action-redirect.ts) instead of relying on a server-side
// redirect() the client router can silently drop.
//
// The navigation fires INSIDE the action, not from an effect (2026-10-06):
// setPetFoundAction revalidates, the profile re-renders as found, and the stale
// banner holding this form is gone from that render — an effect-based
// useActionRedirect on the unmounted form never ran. Same fix as the
// marcar-encontrada sheet in SheetMounter.

import { useActionNavigate } from "@/lib/ui/use-action-redirect";
import { type EventFormState, setPetFoundAction } from "@/src/modules/events/actions";
import { useActionState } from "react";

export function MarkFoundInlineForm({
  petPublicToken,
  label,
}: {
  petPublicToken: string;
  label: string;
}) {
  const boundAction = setPetFoundAction.bind(null, petPublicToken);
  const [navigate, navigating] = useActionNavigate();
  const [state, formAction, isPending] = useActionState(
    async (previous: EventFormState, formData: FormData) => {
      const result = await boundAction(previous, formData);
      if (result.redirectTo) navigate(result.redirectTo);
      return result;
    },
    { error: null },
  );
  const busy = isPending || navigating;

  return (
    <form action={formAction}>
      <button
        type="submit"
        disabled={busy}
        className="inline-flex min-h-11 items-center justify-center rounded-full bg-ln-ok px-4 text-sm font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-50"
      >
        {busy ? "Guardando…" : label}
      </button>
      {state.error && (
        <p role="alert" className="mt-1 text-xs text-[var(--color-ln-err)]">
          {state.error}
        </p>
      )}
    </form>
  );
}

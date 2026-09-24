"use client";

// MarkFoundInlineForm — client island for the "Apareció · marcar
// encontrado/a" button inside LostCaseBlock's StaleLostCaseBanner (which
// stays a Server Component). Needed because setPetFoundAction follows the
// N3 redirect contract: it returns `redirectTo` on success and the calling
// form performs the full document navigation via useActionRedirect (see
// lib/ui/use-action-redirect.ts) instead of relying on a server-side
// redirect() the client router can silently drop.

import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { setPetFoundAction } from "@/src/modules/events/actions";
import { useActionState } from "react";

export function MarkFoundInlineForm({
  petPublicToken,
  label,
}: {
  petPublicToken: string;
  label: string;
}) {
  const boundAction = setPetFoundAction.bind(null, petPublicToken);
  const [state, formAction, isPending] = useActionState(boundAction, { error: null });
  useActionRedirect(state.redirectTo, state);

  return (
    <form action={formAction}>
      <button
        type="submit"
        disabled={isPending}
        className="inline-flex min-h-11 items-center justify-center rounded-full bg-ln-ok px-4 text-sm font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-50"
      >
        {isPending ? "Guardando…" : label}
      </button>
      {state.error && (
        <p role="alert" className="mt-1 text-xs text-[var(--color-ln-err)]">
          {state.error}
        </p>
      )}
    </form>
  );
}

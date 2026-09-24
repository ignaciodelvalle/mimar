"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { startApplyIntentFormAction } from "@/app/actions/apply-intent";

// Adoption CTA. Posts a real `<form action>` so the funnel works WITHOUT client
// JS (the server action sets the apply-intent cookie + redirects on the server).
// With JS on, useFormStatus drives the pending label and useActionState surfaces
// the in-place error when the pet is no longer listable (or the account is
// institutional) without losing context.
//
// Sprint 6 PR-054: a mobile-only sticky version of the CTA renders at the
// viewport bottom so visitors don't have to scroll back up after reading the
// full pet story. The inline button stays in place on desktop where the CTA is
// already in-view. Both are independent forms posting the same server action.

// Submit button — useFormStatus must be read from a child of the <form>.
function SubmitButton({
  className,
  pendingLabel,
  idleLabel,
  siblingPending = false,
}: {
  className: string;
  pendingLabel: string;
  idleLabel: string;
  /** Pending state shared across both CTA forms — disables this button while
   *  the sibling form is submitting (useFormStatus alone is per-form). */
  siblingPending?: boolean;
}) {
  const { pending } = useFormStatus();
  const busy = pending || siblingPending;
  return (
    <button
      type="submit"
      disabled={busy}
      className={className}
      style={{ background: "var(--color-ln-azul)" }}
    >
      {busy ? pendingLabel : idleLabel}
    </button>
  );
}

export function ApplyButton({
  petToken,
  petName,
  isAuthenticated = true,
}: {
  petToken: string;
  petName: string;
  /** Pass false for anonymous visitors so the CTA copy reflects the auth gate. */
  isAuthenticated?: boolean;
}) {
  // isPending from useActionState covers BOTH forms (they share the action
  // state), so submitting from one disables the other too — useFormStatus
  // alone is per-form and would leave the sibling button active.
  const [state, formAction, isPending] = useActionState(startApplyIntentFormAction, null);
  const error = state && "error" in state ? state.error : null;

  const inlineIdleLabel = isAuthenticated
    ? `Postular para adoptar a ${petName}`
    : "Creá tu cuenta para postular";
  const stickyIdleLabel = isAuthenticated
    ? `Postularme a ${petName}`
    : "Creá tu cuenta para postular";

  return (
    <>
      {/* Inline CTA — visible on all viewports */}
      <form
        action={formAction}
        className="rounded-[var(--radius-md)] border px-6 py-5 space-y-[10px]"
        style={{
          background: "var(--color-ln-card)",
          borderColor: "var(--color-ln-line-strong)",
        }}
      >
        <input type="hidden" name="petToken" value={petToken} />
        <SubmitButton
          className="flex w-full items-center justify-center gap-2 rounded-[var(--radius-md)] border-0 px-4 py-[13px] text-base font-semibold text-white transition-opacity disabled:opacity-60"
          pendingLabel="Procesando..."
          idleLabel={inlineIdleLabel}
          siblingPending={isPending}
        />
        <p className="text-center text-sm" style={{ color: "var(--color-ln-mute)" }}>
          El refugio responde en aproximadamente 5 días.
        </p>
        {error && (
          <output className="block text-center text-md" style={{ color: "var(--color-ln-err)" }}>
            {error}
          </output>
        )}
      </form>

      {/* Mobile-only sticky CTA at the viewport bottom. Hidden on desktop
          where the inline button above is already in view. */}
      <form
        action={formAction}
        className="md:hidden fixed inset-x-0 bottom-0 z-30 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] border-t"
        style={{
          background: "rgba(251,250,245,.95)",
          backdropFilter: "blur(6px)",
          borderColor: "var(--color-ln-line)",
        }}
      >
        <input type="hidden" name="petToken" value={petToken} />
        <SubmitButton
          className="block w-full rounded-[var(--radius-md)] border-0 px-4 py-[13px] text-md font-semibold text-white transition-opacity disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
          pendingLabel="Procesando..."
          idleLabel={stickyIdleLabel}
          siblingPending={isPending}
        />
        {error && (
          <output
            className="mt-1.5 block text-center text-sm"
            style={{ color: "var(--color-ln-err)" }}
          >
            {error}
          </output>
        )}
      </form>
    </>
  );
}

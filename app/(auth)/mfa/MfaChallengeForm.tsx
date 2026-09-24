"use client";

import { useActionState, useEffect } from "react";

import { type MfaStepState, verifyMfaChallengeAction } from "@/app/actions/mfa";
import { LnButton } from "@/components/ui/Button";

import { MfaCodeField } from "./MfaCodeField";

const initialState: MfaStepState = { error: null };

export function MfaChallengeForm({ returnTo }: { returnTo: string | null }) {
  const [state, formAction, isPending] = useActionState(verifyMfaChallengeAction, initialState);

  // A FULL navigation, not a router push: the action just rewrote the session
  // cookies with the aal2 token, and every RSC payload the client router holds
  // was rendered for the aal1 session.
  useEffect(() => {
    if (state.next) window.location.assign(state.next);
  }, [state.next]);

  return (
    <form action={formAction} className="space-y-4">
      {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}
      <MfaCodeField />
      {state.error && (
        <p className="text-sm text-[var(--color-ln-err)]" role="alert">
          {state.error}
        </p>
      )}
      <LnButton type="submit" block loading={isPending || Boolean(state.next)} disabled={isPending}>
        {state.next ? "Entrando..." : "Verificar"}
      </LnButton>
    </form>
  );
}

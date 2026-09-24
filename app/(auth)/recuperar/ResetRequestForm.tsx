"use client";

// kept-fields-allowlist: `email` below is uncontrolled with
// `defaultValue={state.email ?? ""}` — the SERVER ECHOES the submitted
// address back in `PasswordResetRequestState`, the same bug-#46 pattern as
// LoginForm.tsx (see its own allowlist comment). It is the only field on
// this form. The fence only recognizes kept()-seeded defaultValue, not an
// arbitrary server echo.
import {
  type PasswordResetRequestState,
  requestPasswordResetAction,
} from "@/app/actions/password-reset";
import { LnField, LnInput } from "@/components/ui/Field";
import { useActionState, useState } from "react";

import { ResetCodeStep } from "./ResetCodeStep";

const initialState: PasswordResetRequestState = { message: null, error: null };

/**
 * Two steps on one page, like the phone's `RecuperarScreen`: ask for a code,
 * then redeem it. The address stays in state so it is not typed twice.
 *
 * "Usar otro correo" remounts the flow (`key`), which is the only way to return a
 * `useActionState` to its initial state.
 */
export function ResetRequestForm() {
  const [attempt, setAttempt] = useState(0);
  return <ResetRequestFlow key={attempt} onRestart={() => setAttempt((n) => n + 1)} />;
}

function ResetRequestFlow({ onRestart }: { onRestart: () => void }) {
  const [state, formAction, isPending] = useActionState(requestPasswordResetAction, initialState);

  // SUCCESS IS NOT AN ANSWER ABOUT THE ADDRESS: every accepted request moves on to
  // the code step with the same sentence, because moving on only for a known
  // address would be the enumeration oracle.
  if (state.message) {
    return (
      <ResetCodeStep email={state.email ?? ""} notice={state.message} onChangeEmail={onRestart} />
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <LnField label="Correo electrónico" required error={state.error ?? undefined}>
        {({ id, describedBy, invalid }) => (
          <LnInput
            id={id}
            name="email"
            type="email"
            autoComplete="email"
            required
            aria-describedby={describedBy}
            invalid={invalid}
            // React 19 resets the form after the action; a refusal echoes the
            // address back so the reset lands on it instead of wiping it.
            defaultValue={state.email ?? ""}
          />
        )}
      </LnField>

      <button
        type="submit"
        disabled={isPending}
        className="w-full px-4 py-3 rounded-[var(--radius-pill)] bg-[var(--color-ln-azul)] text-white font-medium hover:bg-[var(--color-ln-azul-700)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {isPending ? "Enviando..." : "Enviar código"}
      </button>
    </form>
  );
}

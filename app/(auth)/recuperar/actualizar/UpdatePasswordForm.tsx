"use client";

import { type UpdatePasswordState, updatePasswordAction } from "@/app/actions/password-reset";
import { LnField, LnPasswordInput } from "@/components/ui/Field";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";

const initialState: UpdatePasswordState = { error: null };

export function UpdatePasswordForm() {
  const router = useRouter();
  // YES, THE PASSWORDS ARE RE-SEEDED, AND THIS IS THE ARGUMENT FOR IT.
  //
  // The likeliest refusal on this form is "las contraseñas no coinciden", and
  // it used to empty BOTH boxes: React 19 resets a `<form action>` when its
  // action settles, a refusal included, and neither field was controlled. The
  // person on the other side is already locked out — that is how they got to a
  // recovery link — and the password they lost is one they invented thirty
  // seconds ago and have written down nowhere.
  //
  // WHY BOTH, NEVER ONE. Seeding only "nueva" and clearing "repetir" is the
  // tempting halfway house and it is the dangerous option: when the two differ,
  // the typo may be in the FIRST box, and a person who retypes only the
  // confirmation to match it ends up with an account whose password is the
  // typo. Restoring both keeps the mismatch visible, and `LnPasswordInput`'s
  // reveal toggle is there to find it. Both or neither.
  //
  // WHY THIS IS NOT THE THING SignupForm REFUSES TO DO. That form's rule is
  // "password fields are never echoed/round-tripped", and it is about the
  // SERVER: an echoed password would ride back in the action's return value,
  // through the RSC response and into anything that logs action results.
  // `useKeptFields` never does that — it reads the form's own `FormData` in the
  // BROWSER and keeps it in a ref. The exposure it adds is the DOM `value`
  // attribute, which is not new either: React keeps a controlled input's
  // `defaultValue` in sync, so `LoginForm`'s controlled password has been
  // sitting in that same attribute since the PO QA #44 fix. Same exposure,
  // strictly more of the person's work kept.
  const { boundAction: keptAction, kept } = useKeptFields(updatePasswordAction);
  const [state, formAction, isPending] = useActionState(keptAction, initialState);

  // Redirect to login on success so the user starts a fresh session.
  useEffect(() => {
    if (state.ok) {
      router.replace("/iniciar-sesion");
    }
  }, [state.ok, router]);

  return (
    <form action={formAction} className="space-y-4">
      <LnField label="Nueva contraseña" required hint="Mínimo 8 caracteres.">
        {({ id, describedBy, invalid }) => (
          <LnPasswordInput
            id={id}
            name="password"
            defaultValue={kept("password")}
            autoComplete="new-password"
            minLength={8}
            required
            aria-describedby={describedBy}
            invalid={invalid}
          />
        )}
      </LnField>
      <LnField label="Repetir contraseña" required>
        {({ id, describedBy, invalid }) => (
          <LnPasswordInput
            id={id}
            name="confirmPassword"
            defaultValue={kept("confirmPassword")}
            autoComplete="new-password"
            minLength={8}
            required
            aria-describedby={describedBy}
            invalid={invalid}
          />
        )}
      </LnField>

      {state.error && (
        <p className="text-sm text-[var(--color-ln-err)]" role="alert">
          {state.error}
        </p>
      )}

      {state.ok && (
        <output className="block text-sm text-[var(--color-ln-ok)]">
          Contraseña actualizada. Redirigiendo...
        </output>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="w-full px-4 py-3 rounded-[var(--radius-pill)] bg-[var(--color-ln-azul)] text-white font-medium hover:bg-[var(--color-ln-azul-700)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {isPending ? "Guardando..." : "Guardar nueva contraseña"}
      </button>
    </form>
  );
}

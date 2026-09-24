"use client";

// The /cuenta password-change form (A04-1). Three fields: the CURRENT password —
// the proof that the person at the keyboard owns the account — and the new one
// twice. The recovery form (/recuperar/actualizar) has no first field because
// the recovery mail is its proof.
//
// The two NEW passwords are re-seeded after a refusal for the reason
// UpdatePasswordForm gives at length (React 19 resets the form when the action
// settles). The CURRENT one is not: the likeliest refusal is that it was wrong,
// and handing a wrong password back is handing back the thing to retype.
//
// kept-fields-allowlist: `currentPassword` above has no defaultValue/kept() on
// purpose (the paragraph above), not by omission — the two fields that ARE
// typed work (`password`/`confirmPassword`) are already covered by kept().
import { changePasswordAction } from "@/app/actions/change-password";
import { LnButton } from "@/components/ui/Button";
import { LnField, LnPasswordInput } from "@/components/ui/Field";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import type { UpdatePasswordState } from "@/src/modules/auth/application/password-reset/types";
import Link from "next/link";
import { useActionState } from "react";

const initialState: UpdatePasswordState = { error: null };

export function ChangePasswordForm() {
  const { boundAction: keptAction, kept } = useKeptFields(changePasswordAction);
  const [state, formAction, isPending] = useActionState(keptAction, initialState);

  if (state.ok) {
    return (
      <div className="space-y-4">
        <output className="block text-sm text-[var(--color-ln-ok)]">
          Listo, cambiamos tu contraseña. Cerramos tu sesión en los demás dispositivos.
        </output>
        <Link href="/cuenta" className="text-sm text-[var(--color-ln-azul)]">
          Volver a Mi cuenta
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <LnField label="Contraseña actual" required>
        {({ id, describedBy, invalid }) => (
          <LnPasswordInput
            id={id}
            name="currentPassword"
            autoComplete="current-password"
            required
            aria-describedby={describedBy}
            invalid={invalid}
          />
        )}
      </LnField>
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
      <LnField label="Repetir nueva contraseña" required>
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

      <LnButton type="submit" block loading={isPending} disabled={isPending}>
        {isPending ? "Guardando..." : "Cambiar contraseña"}
      </LnButton>
    </form>
  );
}

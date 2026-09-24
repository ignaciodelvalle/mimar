"use client";

// kept-fields-allowlist: `email` below is uncontrolled with
// `defaultValue={state.email ?? ""}` — the server ECHOES the submitted email
// back in `AuthFormState`, so a rejected login re-seeds the field from the
// action's own response, not from useKeptFields' kept(). This is the
// documented alternate pattern (lib/ui/use-kept-fields.ts's docblock: "the
// value echoed back by the action and re-seeded — the defaultValue={state.x}
// pattern"), and it is the ORIGINAL of the two: SignupForm/ResetRequestForm's
// echo pattern (and useKeptFields itself) trace back to this fix (PO QA #44,
// commit 6d0a0cb6). `password` is fully controlled (value+onChange), which
// survives the React 19 post-action reset on its own. The
// useKeptFields-adoption fence (scripts/check-kept-fields-adoption.ts) only
// recognizes kept()-seeded defaultValue, not an arbitrary server echo — this
// form does not need converting, it was already safe before the hook existed.
import { type AuthFormState, loginAction } from "@/app/actions/auth";
import { LnField, LnInput, LnPasswordInput } from "@/components/ui/Field";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useActionState, useState } from "react";

const initialState: AuthFormState = { error: null };

export function LoginForm({ returnTo }: { returnTo: string | null }) {
  const [state, formAction, isPending] = useActionState(loginAction, initialState);
  // N3: the action returns where to go; this performs the full document
  // navigation the App Router cannot be trusted to do after a server action.
  // `state` as the fire key so a second successful login in the same mounted
  // document (same destination string) still navigates.
  const navigating = useActionRedirect(state.redirectTo, state);
  return (
    <LoginFormView
      state={state}
      formAction={formAction}
      // `navigating` outlives the action (X1-F1): assign() does not block, so a
      // button gated on isPending alone snaps back to "Iniciar sesión" over the
      // login page while the destination is still loading — the exact frame the
      // review filmed, and the one that makes a user press again.
      isPending={isPending || navigating}
      returnTo={returnTo}
    />
  );
}

// Presentational form, split from the useActionState wiring so tests can
// assert every submit state (idle / pending / error) without mocking React.
//
// Submission contract (task #39): the submit button MUST stay a plain
// type="submit" inside the <form action={…}> — React/Next serialize that
// form into a progressively-enhanced POST (action="" method="POST" +
// $ACTION hidden inputs), so a click works even before hydration or with
// JS disabled. Never move the submit out of the form or replace it with an
// onClick handler: that reintroduces the silently-dropped click.
export function LoginFormView({
  state,
  formAction,
  isPending,
  returnTo,
}: {
  state: AuthFormState;
  formAction: (formData: FormData) => void;
  isPending: boolean;
  returnTo: string | null;
}) {
  // Password is controlled so we can reset it programmatically; the email is
  // intentionally UNCONTROLLED (the DOM owns its value). Two field-state bugs
  // motivate this split (PO QA #44):
  //
  //  1. Password persisted across an account switch. A password is scoped to
  //     the email it was typed for — editing the email must drop the stale
  //     password. We clear it from the email's onChange.
  //  2. A controlled email fought browser autofill: binding value={email} let a
  //     re-render (e.g. a failed-submit error state) write React's copy back
  //     into the input, clobbering what autofill or the user had just typed.
  //     Leaving the email uncontrolled makes the DOM the single source of truth,
  //     so the typed/autofilled value always wins.
  const [password, setPassword] = useState("");

  return (
    <div className="space-y-5">
      {/* Email/password form is FIRST in DOM — correct tab order and screen-reader flow.
          The Mi Argentina stub renders below (visually and in DOM) so focus order is:
          email → password → submit → stub. */}
      <div className="flex flex-col gap-5">
        <form action={formAction} className="space-y-4">
          {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}
          <LnField label="Correo electrónico" required>
            {({ id, describedBy, invalid }) => (
              <LnInput
                id={id}
                name="email"
                type="email"
                autoComplete="email"
                required
                aria-describedby={describedBy}
                invalid={invalid || Boolean(state.error)}
                // Uncontrolled value (DOM-owned); onChange only drops the stale
                // password when the account email is edited.
                onChange={() => setPassword("")}
                // React 19 auto-resets this uncontrolled form once the action
                // resolves. A failed login returns (no redirect), so without a
                // defaultValue the reset would wipe the email the user just
                // typed. loginAction echoes the submitted email back, so the
                // reset lands on it and the field survives. defaultValue does
                // not fight autofill (it only seeds the DOM default, never the
                // live value), so the uncontrolled-email decision above holds.
                defaultValue={state.email ?? ""}
              />
            )}
          </LnField>
          <LnField label="Contraseña" required>
            {({ id, describedBy, invalid }) => (
              <LnPasswordInput
                id={id}
                name="password"
                autoComplete="current-password"
                required
                aria-describedby={describedBy}
                invalid={invalid}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
          </LnField>

          <div className="flex justify-end">
            <a
              href="/recuperar"
              className="text-xs text-[var(--color-ln-azul)] underline underline-offset-2 hover:text-[var(--color-ln-azul-700)]"
            >
              ¿Olvidaste tu contraseña?
            </a>
          </div>

          {/* Form-level error surface (task #39): a failed submit must never be
              silent. The credentials error belongs to the email+password PAIR,
              not to the email field, so it renders as its own alert block. */}
          {state.error && (
            <div
              role="alert"
              className="rounded-[var(--radius-sm)] border border-[var(--color-ln-err-100)] bg-[var(--color-ln-err-bg)] px-3 py-2 text-sm text-[var(--color-ln-err)]"
            >
              {state.error}
            </div>
          )}

          <button
            type="submit"
            disabled={isPending}
            aria-busy={isPending || undefined}
            className="w-full px-4 py-3 rounded-[var(--radius-sm)] bg-[var(--color-ln-azul)] text-white font-medium hover:bg-[var(--color-ln-azul-700)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isPending ? "Ingresando..." : "Iniciar sesión"}
          </button>
        </form>

        <div className="flex items-center gap-3 text-xs text-[var(--color-ln-mute)]">
          <div className="flex-1 h-px bg-[var(--color-ln-stripe)]" />
          <span>o</span>
          <div className="flex-1 h-px bg-[var(--color-ln-stripe)]" />
        </div>

        {/* Mi Argentina stub — after the form in DOM (and visually) */}
        <button
          type="button"
          disabled
          aria-disabled="true"
          tabIndex={-1}
          title="Próximamente: integración con Mi Argentina"
          className="w-full px-4 py-3 rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] text-sm text-[var(--color-ln-mute)] cursor-not-allowed"
        >
          Conectar con Mi Argentina (próximamente)
        </button>
      </div>
    </div>
  );
}

"use client";

// kept-fields-allowlist: every field here is already proven safe, by three
// DIFFERENT mechanisms, each argued out in its own comment below — this
// fence only recognizes one of the three (kept()), so it flags the other
// two as if nobody had thought about them:
//   - email/firstName/lastName: uncontrolled with `defaultValue={state.x}`,
//     the SERVER ECHO pattern (bug #46) — the documented alternative to
//     kept() in lib/ui/use-kept-fields.ts's own docblock, and the pattern
//     kept() itself was generalized FROM (see LoginForm.tsx).
//   - password/confirmPassword: genuinely covered by kept() already.
//   - tosAccepted: uncontrolled with NEITHER checked= NOR defaultChecked=,
//     which is the PO-gated, deliberate choice to NEVER re-tick a consent
//     on someone's behalf (see the comment at its call site) — not an
//     omission the fence should ask for a `key`/`kept()` fix on.
import {
  type AuthFormState,
  type IdentityFormState,
  completeIdentityAction,
  signupAction,
} from "@/app/actions/auth";
import { LnCheckbox, LnField, LnInput, LnPasswordInput } from "@/components/ui/Field";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import { useStepFocus } from "@/lib/ui/use-step-focus";
import { IDENTITY_NAME_MAX_LENGTH } from "@dim/contract/input";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState } from "react";

const initialAuthState: AuthFormState = { error: null };
const initialIdentityState: IdentityFormState = { error: null };

// Two-step inline signup per design spec §1.2.
//
// Step 1 (account): email + password + repeat password + TOS checkbox.
//   signupAction creates the auth.users row; profiles.display_name is set
//   provisionally to the email local-part by the handle_new_user trigger.
//
// Step 2 (identity): nombre + apellido (required) + DNI (optional).
//   completeIdentityAction updates profiles.display_name to the real name
//   and stores dni_hash + dni_last4 (no plaintext DNI — Wave 5 Item 25a).
//
// returnTo / intent=apply branches: both used to skip the old pet step and
// redirect after step 1. They now show step 2 (identity) first so that the
// account never ends up with only a provisional display_name. Redirect happens
// after step 2 completes.
//
// `initialStep` (2026-08-01): the page mounts this form at "identity" when the
// visitor is ALREADY authenticated but still carries the trigger's provisional
// display_name — i.e. they are resuming an abandoned signup, not starting one.
// The step used to live only in this component's useState, so it died with the
// browser tab and nothing could ever bring the user back. Now the entry step is
// decided server-side from the database on every request; the useState below
// only carries the step-1 → step-2 transition within a single visit.

export function SignupForm({
  intent,
  returnTo,
  initialStep = "account",
}: {
  intent: "apply" | null;
  returnTo: string | null;
  /** Server-decided entry point. "identity" means "resume an abandoned signup". */
  initialStep?: "account" | "identity";
}) {
  const router = useRouter();
  const [step, setStep] = useState<"account" | "identity">(initialStep);
  // Resuming is a property of how the page was ENTERED, not of the current
  // step: a visitor who starts at step 1 and advances to step 2 is completing a
  // fresh signup and must still read "Paso 2 de 2".
  const resuming = initialStep === "identity";
  // STEP 1 WAS ONLY HALF FIXED, and the half that was missing is the half that
  // costs the most. Bug #46 taught this form that React 19 resets a
  // `<form action>` once the action settles, and it answered by echoing the
  // EMAIL back through server state. The two passwords and the terms tick were
  // left to be cleared, so the single likeliest refusal here — "las contraseñas
  // no coinciden" — wiped both passwords and unticked the box, on a form that
  // still showed the email and therefore looked mostly intact.
  //
  // `useKeptFields` covers what the echo could not. The echo is a SERVER
  // round-trip and a password must never take one (an echoed secret rides back
  // in the action's return value, through the RSC response, into anything that
  // logs it) — this hook instead reads the form's own `FormData` in the BROWSER
  // and keeps it in a ref, so the secret goes nowhere it was not already. The
  // full argument, including why both password boxes are restored rather than
  // one, is written out in `app/(auth)/recuperar/actualizar/UpdatePasswordForm.tsx`.
  //
  // THE TERMS TICK IS RESTORED, NOT PRE-TICKED, and the difference is the whole
  // point: `keptChecked` can only answer "true" for a box the person themselves
  // ticked on their own submit, in this same mounted form, moments ago — it has
  // no other source of truth. The acceptance that gets recorded is still the one
  // in the NEXT submit's `FormData`, and the box remains theirs to untick. A
  // browser restoring a form on back-navigation does exactly this.
  const { boundAction: keptSignupAction, kept, keptChecked } = useKeptFields(signupAction);
  const [authState, authFormAction, authPending] = useActionState(
    keptSignupAction,
    initialAuthState,
  );
  const [identityState, identityFormAction, identityPending] = useActionState(
    completeIdentityAction,
    initialIdentityState,
  );
  // A11y fix (2026-07 audit): each step below is a full early-return (its own
  // JSX tree, not a shared shell), so only one of the two target elements is
  // ever mounted at a time — the same ref object attaches to whichever one is
  // currently rendered. See lib/ui/use-step-focus.ts.
  const stepFocusRef = useRef<HTMLDivElement>(null);
  useStepFocus(step, stepFocusRef);

  // Step 1 → step 2 transition.
  useEffect(() => {
    if (!authState.ok) return;
    setStep("identity");
  }, [authState.ok]);

  // Step 2 → redirect or /mis-mascotas.
  useEffect(() => {
    if (!identityState.ok) return;
    if (returnTo) {
      router.replace(returnTo);
    } else {
      router.replace("/mis-mascotas");
    }
  }, [identityState.ok, returnTo, router]);

  if (step === "identity") {
    return (
      <div className="space-y-5">
        <p className="text-center text-xs uppercase tracking-[0.3em] text-[var(--color-ln-mute)]">
          {resuming ? "Último paso" : "Paso 2 de 2"}
        </p>

        <div className="space-y-2">
          <h2
            ref={stepFocusRef}
            tabIndex={-1}
            className="font-ln-serif text-title font-semibold tracking-[-0.01em] text-[var(--color-ln-ink)] focus:outline-none"
          >
            Contanos quién sos
          </h2>
          <p className="text-sm text-[var(--color-ln-ink-2)]">
            {resuming
              ? "Ahora figurás con la primera parte de tu correo. Tu nombre real es lo que va a aparecer en la credencial de tu mascota."
              : "Tu nombre aparecerá en tu perfil y en las comunicaciones de miMAR."}
          </p>
        </div>

        <form action={identityFormAction} className="space-y-4">
          <LnField label="Nombre" required>
            {({ id, describedBy, invalid }) => (
              <LnInput
                id={id}
                name="firstName"
                type="text"
                autoComplete="given-name"
                required
                // The SERVER's own bound, imported rather than repeated. Both
                // halves land in one `profiles.display_name`, so the schema
                // derives the per-half ceiling from that column's; a number typed
                // here would be a fourth place to keep in step. It is a courtesy,
                // not the rule — `completeIdentityInputSchema` is what refuses.
                maxLength={IDENTITY_NAME_MAX_LENGTH}
                aria-describedby={describedBy}
                invalid={invalid}
                // Uncontrolled (DOM-owned). React 19 auto-resets this form once
                // completeIdentityAction resolves; on a validation error (no
                // redirect) the reset would wipe the typed name. The action
                // echoes it back in state so the reset lands on it instead
                // (mirrors the login email fix, bug #46).
                defaultValue={identityState.firstName ?? ""}
              />
            )}
          </LnField>
          <LnField label="Apellido" required>
            {({ id, describedBy, invalid }) => (
              <LnInput
                id={id}
                name="lastName"
                type="text"
                autoComplete="family-name"
                required
                maxLength={IDENTITY_NAME_MAX_LENGTH}
                aria-describedby={describedBy}
                invalid={invalid}
                defaultValue={identityState.lastName ?? ""}
              />
            )}
          </LnField>
          {/* THE DNI FIELD WAS REMOVED HERE (2026-09-07), on the same grounds as
              the locality field below it and with the same shape of reasoning.

              WHAT IT BOUGHT: nothing. This form's writer leaves `dni_verified`
              false by design (see `complete-identity.ts`), so a DNI typed here
              unlocked none of the four things a verified DNI gates — the vet
              upgrade, creating an organization, creating a consultorio, and
              volunteering as a tránsito all read `dni_verified` and all send you
              to `/cuenta/verificar-dni`, which is untouched and still asks.

              WHAT IT COST, beyond the friction a pilot tester actually reported:
              `profiles_dni_hash_unique` (migration 0106, `db/schema.ts:414`) is
              partial on `dni_hash IS NOT NULL` and NOT on `dni_verified`, so an
              unverified number typed here OCCUPIED THE SLOT GLOBALLY. Nothing
              here proves the typer owns the number. Somebody entering another
              person's DNI — by typo or otherwise — left that person unable to
              ever verify their own: the collision surfaces through the
              deliberately GENERIC error the enumeration defence requires, so the
              victim gets an opaque failure and no way out.

              This does not close the squat completely — `/cuenta/verificar-dni`
              is self-declared too, and its own audit payload calls the method
              `placeholder_form`. It removes the CASUAL path, mid-signup, where
              the typer bears no consequence. The real fix is federated identity:
              PO decision 2026-09-07 is that DNI collection waits for Mi
              Argentina rather than growing another self-declared door. */}

          {/* THE LOCALITY FIELD WAS REMOVED HERE (2026-08-27). It wrote
              profiles.jurisdiction_province / _locality, which had one writer and
              zero readers, under a hint that promised it "ayuda a las campañas
              regionales de salud animal" — a purpose the code never had.
              Collecting a personal datum for a purpose that does not exist is
              itself a finalidad problem (Ley 25.326 art. 4), so the field is gone
              rather than better worded. Jurisdiction is a PET-level fact in this
              product and is captured on the pet. See
              src/modules/auth/application/complete-identity.ts. */}
          {identityState.error && (
            <p className="text-sm text-[var(--color-ln-err)]" role="alert">
              {identityState.error}
            </p>
          )}

          <button
            type="submit"
            disabled={identityPending}
            className="w-full px-4 py-3 rounded-[var(--radius-pill)] bg-[var(--color-ln-azul)] text-white font-medium hover:bg-[var(--color-ln-azul-700)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {identityPending
              ? resuming
                ? "Guardando..."
                : "Creando cuenta..."
              : resuming
                ? "Guardar mi nombre"
                : "Crear cuenta"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Step 1 is only ever reached on initial mount (no "back" from step 2),
          so useStepFocus's mount-skip means this ref never actually fires
          today — kept for symmetry with step 2 and in case a future "back"
          affordance is added. */}
      <p
        ref={stepFocusRef}
        tabIndex={-1}
        className="text-xs uppercase tracking-[0.3em] text-[var(--color-ln-mute)] text-center focus:outline-none"
      >
        Paso 1 de 2
      </p>

      {/* Email/password form is FIRST in DOM — correct tab order and screen-reader flow.
          The Mi Argentina stub renders below (visually and in DOM). */}
      <div className="flex flex-col gap-5">
        <form action={authFormAction} className="space-y-4">
          <LnField label="Correo electrónico" required error={authState.error ?? undefined}>
            {({ id, describedBy, invalid }) => (
              <LnInput
                id={id}
                name="email"
                type="email"
                autoComplete="email"
                required
                aria-describedby={describedBy}
                invalid={invalid}
                // Uncontrolled (DOM-owned) — same fix as LoginForm (bug #46).
                // React 19 auto-resets this form once signupAction resolves; a
                // validation error (no redirect) would otherwise wipe the typed
                // email. signupAction echoes it back in state so the reset
                // lands on the typed value instead of clearing it.
                defaultValue={authState.email ?? ""}
              />
            )}
          </LnField>
          <LnField label="Contraseña" required hint="Mínimo 8 caracteres.">
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

          {/* NOT RESTORED, and it is the one field on this form deliberately
              left to be re-ticked. Everything else here is the person's WORK —
              their name, their mail, the password they composed — and putting
              work back after a failed submit is a kindness. A consent is not
              work. It is an affirmative act, and a box the system re-ticks on
              your behalf is one you did not tick that time.
              The argument for restoring it was real and was considered: the box
              only comes back if this same person ticked it on their own submit
              in this same mounted form, which is what a browser does on back
              navigation, and the consent actually recorded is still the one in
              the NEXT submit. That is probably defensible. "Probably
              defensible" is the wrong standard for consent when the
              conservative option costs one click on a form somebody fills once
              in their life.
              PO-gated if anybody wants it changed: this is a legal posture, not
              an ergonomics call. */}
          <LnCheckbox id="tosAccepted" name="tosAccepted" required>
            Leí y acepto los{" "}
            <Link
              href="/terminos"
              target="_blank"
              className="font-medium text-[var(--color-ln-azul)] underline underline-offset-2"
            >
              Términos y condiciones
            </Link>{" "}
            y la{" "}
            <Link
              href="/privacidad"
              target="_blank"
              className="font-medium text-[var(--color-ln-azul)] underline underline-offset-2"
            >
              Política de privacidad
            </Link>
            .
          </LnCheckbox>

          <button
            type="submit"
            disabled={authPending}
            className="w-full px-4 py-3 rounded-[var(--radius-pill)] bg-[var(--color-ln-azul)] text-white font-medium hover:bg-[var(--color-ln-azul-700)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {authPending ? "Procesando..." : "Continuar"}
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
          className="w-full px-4 py-3 rounded-[var(--radius-pill)] border border-[var(--color-ln-line-strong)] text-sm text-[var(--color-ln-mute)] cursor-not-allowed"
        >
          Conectar con Mi Argentina (próximamente)
        </button>
      </div>
    </div>
  );
}

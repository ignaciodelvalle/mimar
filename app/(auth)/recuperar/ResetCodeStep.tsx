"use client";

// The web's code step of password recovery (PO decision 2026-09-13: ONE method,
// the six-digit code, on both surfaces). It now mirrors the phone's
// `RecuperarScreen` redeem step COMPLETELY — code, new password and confirmation
// on one form, both operations inside one handler.
//
// WHY THE PASSWORD FIELDS ARE HERE AND NOT ON /recuperar/actualizar
// ---------------------------------------------------------------------------
// This is a security fix, not a layout preference. Redeeming the code mints a
// REAL cookie session, and until 2026-09-15 nothing obliged the person to
// continue: `/recuperar/actualizar` was a separate page they could simply
// navigate away from. So possession of the code alone was a complete web login.
// The attack is a phone call — somebody posing as miMAR support triggers the
// reset, asks the victim to read back "the 6-digit verification code we just
// sent", enters address plus code here, and walks away from the password form
// into `/inicio` with a live session. Because the password never changed,
// `signOut({ scope: "others" })` never ran, and the victim got no signal at all.
//
// The fix is structural rather than a guard, a marker or a middleware fence:
// after this change there is no USER-VISIBLE step between redeeming the code and
// setting the password, so there is nothing left for a person to abandon. A guard
// would have had to decide what "abandoned" means; removing the window does not.
//
// BE PRECISE ABOUT WHAT THAT DOES NOT BUY, because the next reader will otherwise
// trust a guarantee that is not here. This closes the UI path, not the protocol:
// the anon key is public (see the section below), so anyone holding the code can
// still `POST /auth/v1/verify` themselves and mint a session without ever loading
// this page. What the change removes is the low-skill version of the phone scam,
// and it makes the scam NOISY — the attacker now has to change the password to
// get through the screen, which is the one action the victim cannot miss. The
// real control on a stolen code remains the code's own lifetime and GoTrue's
// per-IP ceiling, both of which live in the hosted project's configuration and
// not in this file.
//
// THE ORDER INSIDE THE HANDLER IS LOAD-BEARING, and it is the phone's order for
// the phone's reason (`resetPasswordWithCode`, apps/mobile/src/auth/session-store.ts):
// a recovery code is SINGLE-USE and `verifyOtp` consumes it, so the two local
// password rules — which cost nothing — run BEFORE it. Validating afterwards
// burns a good code on a typo in the confirmation box and sends the person back
// to an endpoint that allows their address five mails an hour.
//
// AND A FAILED `updateUser` DROPS THE SESSION IMMEDIATELY, exactly as the phone
// does (`session-store-password-reset.test.ts`, "drops the session verifyOtp
// stored when updateUser fails"). By then `verifyOtp` has already written live
// auth cookies; leaving them would recreate the very window this change closes,
// only worse, because the screen is showing an error while the browser is signed
// in. A recovery session must never outlive the handler that created it.
//
// WHY THE CODE IS REDEEMED FROM THE BROWSER AND NOT FROM A SERVER ACTION
// ---------------------------------------------------------------------------
// It used to be a server action, and that is exactly what broke. GoTrue's
// `token_verifications` ceiling is keyed PER IP ADDRESS (supabase/config.toml,
// `[auth.rate_limit]`: 30 per 5 minutes). Every web redemption reached GoTrue
// from the deployment's ONE egress address, so that per-IP ceiling stopped
// bounding a caller and became a single pool shared by every web user in the
// country — one burst and nobody could redeem a code for five minutes.
//
// Redeeming here, from the browser, is the structural fix rather than a bigger
// number: GoTrue then keys the ceiling on the real person's address, exactly as
// it already does for the phone (`resetPasswordWithCode`,
// apps/mobile/src/auth/session-store.ts). The shared pool does not need to be
// managed because it no longer exists.
//
// `createClient()` here is `createBrowserClient` from `@supabase/ssr`, which
// writes the auth cookies to `document.cookie`. That is still the load-bearing
// detail, for a smaller job than before: `updateUser` and `signOut` need the
// session `verifyOtp` just stored, and the FULL document navigation at the end
// needs the server to see the cookies of the account we just recovered.
//
// WHAT WENT AWAY WITH THE SERVER ACTION, AND WHY THAT IS NOT A REGRESSION
// ---------------------------------------------------------------------------
// The verify-side per-IP and per-email rate-limit buckets are gone, and a reader
// arriving here will reasonably suspect protection was deleted. It was not,
// because those buckets never bounded an attacker: the anon key is PUBLIC — it
// ships in this very bundle, and the phone already redeems with it — so
// `/auth/v1/verify` was always reachable directly. Somebody brute-forcing a
// victim's six-digit code never had to come through our form, so our per-email
// bucket only ever bounded people who did. The real and only bound on brute
// force is GoTrue's own per-IP ceiling, and this change makes that ceiling
// per-attacker instead of per-deployment. We gave up a bucket that bounded
// nobody and removed a denial of service that bounded everybody.
//
// WHAT A REFUSAL MAY NEVER SAY: whether the address has an account. GoTrue
// answers a wrong code, an expired code, a spent code and a code for an address
// with no account with the SAME error, so there is no honest way to tell them
// apart — and telling "no such account" apart would rebuild the enumeration
// oracle `requestPasswordReset` refuses to be. They share ONE sentence, the same
// one the phone shows. The other refusals (blank field, provider over its own
// limit, provider unavailable) are about the request, never the account.
//
// THE CODE AND THE PASSWORD ARE NEVER LOGGED, never echoed back into the DOM and
// never put in a URL: the code goes to `verifyOtp`, the password goes to
// `updateUser`, and neither goes anywhere else.
//
// "Pedir otro código" stays a SERVER action, deliberately. That half is
// genuinely ours — our server is the one asking GoTrue to send mail — so it
// still spends `auth_password_reset_ip` / `auth_password_reset_email` before
// GoTrue is touched, and gets the same neutral sentence back.

// kept-fields-allowlist: the main code+password form above uses a plain
// `onSubmit`/`event.preventDefault()`, NOT `<form action={fn}>` — see the
// header comment's "WHY THE CODE IS REDEEMED FROM THE BROWSER AND NOT FROM
// A SERVER ACTION": it is deliberately outside React 19's form-action reset
// this fence guards against. The ONLY `useActionState`-driven form here is
// the "Pedir otro código" resend, and its only field is a HIDDEN
// `value={email}` echoing a stable prop (no onChange because nothing here
// is user-editable) — controlled-input DOM sync applies to any `value=`
// prop, onChange or not, so it survives the reset the same way a
// value+onChange field does; there is also nothing "typed" in a hidden
// field to lose. The fence only recognizes the value+onChange shape as
// controlled, not a value-only one.
import {
  type PasswordResetRequestState,
  requestPasswordResetAction,
} from "@/app/actions/password-reset";
import { LnButton } from "@/components/ui/Button";
import { LnField, LnInput, LnPasswordInput } from "@/components/ui/Field";
import { createClient } from "@/lib/supabase/client";
import { useActionNavigate } from "@/lib/ui/use-action-redirect";
import { destroyRecoverySession } from "@/src/modules/auth/application/password-reset/destroy-recovery-session";
import { revokeOtherSessions } from "@/src/modules/auth/application/password-reset/revoke-other-sessions";
import {
  PASSWORD_SETUP_PENDING_RECOVERY_MESSAGE,
  isPasswordSetupPending,
} from "@/src/modules/auth/domain/first-access";
import {
  MFA_PASSWORD_CHANGE_NEEDS_ADMIN_MESSAGE,
  isInsufficientAalError,
} from "@/src/modules/auth/domain/mfa-policy";
import {
  MIN_PASSWORD_LENGTH,
  validateNewPassword,
} from "@/src/modules/auth/domain/new-password-rules";
import { type FormEvent, useActionState, useState } from "react";

const initialResendState: PasswordResetRequestState = { message: null, error: null };

/**
 * Where a finished reset lands. The login screen, like `/recuperar/actualizar`
 * has always done — a FULL document navigation, see below. The session the reset
 * leaves behind is the person's own and the login page will route them onward by
 * role; what matters here is that the document leaves.
 */
const RESET_DESTINATION = "/iniciar-sesion";

/** The sentence shown while the document is on its way out. `/recuperar/actualizar`'s own. */
export const RESET_DONE_MESSAGE = "Contraseña actualizada. Redirigiendo...";

/**
 * Every sentence this step can show about the CODE. `invalid_code` is the
 * neutral one the four indistinguishable causes share; the others are about the
 * provider or the flow, never about the account. What it can say about the
 * PASSWORD comes from `new-password-rules.ts`, shared with the two other callers.
 */
export const RESET_CODE_MESSAGES = {
  missing_code: "Ingresá el código de 6 dígitos que te enviamos por correo.",
  rate_limited: "Demasiados intentos. Esperá unos minutos y volvé a probar.",
  invalid_code: "El código no es válido o ya venció. Pedí uno nuevo y volvé a intentar.",
  unavailable: "No pudimos verificar el código en este momento. Probá de nuevo en unos minutos.",
  // The phone's sentence, for the phone's situation: the code is spent and the
  // password did not change, so the only way forward is a new code. It sits on
  // the code field because that is where the remedy is.
  update_failed: "No pudimos cambiar la contraseña. Pedí un código nuevo y volvé a intentar.",
} as const;

/**
 * Whitespace is removed from the code, not just trimmed: a code pasted from a
 * mail client often arrives as "123 456". Nothing else is normalized and the
 * LENGTH is not checked — GoTrue owns `otp_length`, and a client that refused a
 * seven-digit code would break the day that setting changes (the phone's
 * `CODE_LENGTH` docblock makes the same point).
 */
export function normalizeRecoveryCode(raw: string): string {
  return raw.replace(/\s+/g, "");
}

/**
 * A provider refusal that is about load or availability rather than the code.
 * Anything else — including GoTrue's `otp_expired`, which is what a wrong code,
 * an expired code, a spent code and an unknown address all produce — collapses
 * into the one neutral sentence.
 */
function messageForProviderError(error: { status?: number; code?: string }): string {
  if (error.status === 429 || error.code === "over_request_rate_limit") {
    return RESET_CODE_MESSAGES.rate_limited;
  }
  if (error.status === undefined || error.status >= 500) return RESET_CODE_MESSAGES.unavailable;
  return RESET_CODE_MESSAGES.invalid_code;
}

export function ResetCodeStep({
  email,
  notice,
  onChangeEmail,
}: {
  email: string;
  notice: string;
  onChangeEmail: () => void;
}) {
  const [codeError, setCodeError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [working, setWorking] = useState(false);
  const [resendState, resendAction, resendPending] = useActionState(
    requestPasswordResetAction,
    initialResendState,
  );
  // NAV CONTRACT N3, imperative half: `useActionNavigate` performs a FULL
  // document navigation, which is what makes the next page render on the server
  // with the cookies this handler just settled. A client-side router push would
  // reuse the RSC payload this document already has and arrive without them.
  // `navigating` never comes back down, so the button stays in its loading state
  // until the document leaves.
  const [navigate, navigating] = useActionNavigate();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    // The browser must NOT post this form: there is no server action behind it,
    // and a native post would put the code AND the new password in a request we
    // do not handle. JavaScript is required for this step by design
    // (PO 2026-09-15) — the redemption has to happen from the person's own IP to
    // be worth doing.
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const code = normalizeRecoveryCode(String(fields.get("code") ?? ""));
    const password = String(fields.get("password") ?? "");
    const confirmPassword = String(fields.get("confirmPassword") ?? "");

    if (!code) {
      setPasswordError(null);
      setCodeError(RESET_CODE_MESSAGES.missing_code);
      return;
    }
    // BEFORE `verifyOtp`, always. See the header: the code is single-use and
    // these two rules are free, so a typo in the confirmation box must not cost
    // the person a code.
    const passwordProblem = validateNewPassword(password, confirmPassword);
    if (passwordProblem) {
      setCodeError(null);
      setPasswordError(passwordProblem);
      return;
    }

    setCodeError(null);
    setPasswordError(null);
    setWorking(true);

    const auth = createClient().auth;

    let redeemed: Awaited<ReturnType<typeof auth.verifyOtp>>;
    try {
      redeemed = await auth.verifyOtp({ email, token: code, type: "recovery" });
    } catch {
      // auth-js rethrows anything that is not an AuthError (a network failure, a
      // cookie write that threw). Nothing about the code or the account.
      setWorking(false);
      setCodeError(RESET_CODE_MESSAGES.unavailable);
      return;
    }

    if (redeemed.error) {
      setWorking(false);
      setCodeError(messageForProviderError(redeemed.error));
      return;
    }
    // No error and no session is not a success: there is no session to change a
    // password with. Same sentence as a refused code.
    if (!redeemed.data.session) {
      setWorking(false);
      setCodeError(RESET_CODE_MESSAGES.invalid_code);
      return;
    }

    // From here on a LIVE recovery session exists in this browser's cookie jar,
    // and every exit below must either finish the reset or destroy it.

    // An account that still owes its FIRST password pays it at /primer-acceso
    // only (first-access.ts): drop the session, change nothing.
    if (isPasswordSetupPending(redeemed.data.user ?? redeemed.data.session.user)) {
      await destroyRecoverySession(auth);
      setWorking(false);
      setCodeError(PASSWORD_SETUP_PENDING_RECOVERY_MESSAGE);
      return;
    }
    let updated: Awaited<ReturnType<typeof auth.updateUser>> | null = null;
    let threw = false;
    try {
      updated = await auth.updateUser({ password });
    } catch {
      threw = true;
    }

    if (threw || updated?.error) {
      // DROP THE SESSION. The phone calls `clearSession()` here; the browser's
      // equivalent is a local sign-out, which revokes THIS session and clears the
      // auth cookies `verifyOtp` wrote. `scope: "local"` and not "global": the
      // person's other devices did nothing wrong, and the password did not
      // change, so there is nothing to revoke them for.
      //
      // It goes through `destroyRecoverySession` rather than calling `signOut`
      // here because `signOut` RETURNS its error instead of throwing, and returns
      // it WITHOUT having cleared anything — on exactly the network failure that
      // most likely caused `updateUser` to fail a line ago. That module makes the
      // local clear unconditional; read its header before simplifying this back.
      await destroyRecoverySession(auth);
      setWorking(false);
      // An account with a second factor cannot set its password from a recovery
      // session (aal1); the code was right, so do not tell the person to retry.
      setCodeError(
        isInsufficientAalError(updated?.error)
          ? MFA_PASSWORD_CHANGE_NEEDS_ADMIN_MESSAGE
          : RESET_CODE_MESSAGES.update_failed,
      );
      return;
    }

    // MED-5: the reset is the canonical response to a compromised account, so
    // every session minted before it dies. Best-effort and shared with
    // `updatePasswordAction` — see `revoke-other-sessions.ts`.
    await revokeOtherSessions(auth);

    // Deliberately NOT clearing `working`: the document is on its way out and a
    // button that came back to life over the old page invites a second submit,
    // which would spend a code that no longer exists.
    setDone(true);
    navigate(RESET_DESTINATION);
  }

  return (
    <ResetCodeStepView
      email={email}
      notice={resendState.message ?? notice}
      codeError={codeError}
      passwordError={passwordError}
      done={done}
      onSubmit={onSubmit}
      pending={working || navigating}
      resendError={resendState.error}
      resendAction={resendAction}
      resendPending={resendPending}
      onChangeEmail={onChangeEmail}
    />
  );
}

/** Presentational half, split so tests can render every state without hooks. */
export function ResetCodeStepView({
  email,
  notice,
  codeError,
  passwordError,
  done,
  onSubmit,
  pending,
  resendError,
  resendAction,
  resendPending,
  onChangeEmail,
}: {
  email: string;
  notice: string;
  codeError: string | null;
  passwordError: string | null;
  done: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  pending: boolean;
  resendError: string | null;
  resendAction: (formData: FormData) => void;
  resendPending: boolean;
  onChangeEmail: () => void;
}) {
  return (
    <div className="space-y-5">
      <output className="block rounded-[var(--radius-sm)] border border-[var(--color-ln-ok-100)] bg-[var(--color-ln-ok-050)] px-4 py-3.5 text-md text-[var(--color-ln-ink)]">
        {notice}
      </output>

      <form onSubmit={onSubmit} className="space-y-4">
        <LnField
          label="Código"
          required
          hint="El código de 6 dígitos que te llegó por correo."
          error={codeError ?? undefined}
        >
          {({ id, describedBy, invalid }) => (
            <LnInput
              id={id}
              name="code"
              type="text"
              // `one-time-code` lets the browser offer the code straight from the
              // mail or the notification. NO maxLength: GoTrue owns otp_length,
              // and a cap here would silently truncate a longer code.
              autoComplete="one-time-code"
              inputMode="numeric"
              spellCheck={false}
              mono
              required
              aria-describedby={describedBy}
              invalid={invalid}
            />
          )}
        </LnField>

        {/* The password pair, with `/recuperar/actualizar`'s own labels and hint —
            same surface, same words. `new-password` on both, so a manager offers
            to store the one it is about to become. */}
        <LnField
          label="Nueva contraseña"
          required
          hint={`Mínimo ${MIN_PASSWORD_LENGTH} caracteres.`}
          error={passwordError ?? undefined}
        >
          {({ id, describedBy, invalid }) => (
            <LnPasswordInput
              id={id}
              name="password"
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
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
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              required
              aria-describedby={describedBy}
              invalid={invalid}
            />
          )}
        </LnField>

        {done && (
          <output className="block text-sm text-[var(--color-ln-ok)]">{RESET_DONE_MESSAGE}</output>
        )}

        <LnButton type="submit" block size="lg" loading={pending}>
          {pending ? "Guardando..." : "Cambiar contraseña"}
        </LnButton>
      </form>

      <div className="flex flex-col items-center gap-2">
        <form action={resendAction} className="w-full">
          <input type="hidden" name="email" value={email} />
          {resendError && (
            <p role="alert" className="mb-2 text-center text-sm text-[var(--color-ln-err)]">
              {resendError}
            </p>
          )}
          <LnButton type="submit" variant="ghost" block loading={resendPending}>
            {resendPending ? "Enviando..." : "Pedir otro código"}
          </LnButton>
        </form>
        <LnButton type="button" variant="ghost" size="sm" onClick={onChangeEmail}>
          Usar otro correo
        </LnButton>
      </div>
    </div>
  );
}

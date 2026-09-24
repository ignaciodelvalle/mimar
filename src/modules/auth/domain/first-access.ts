// First access of an institutional account — the "set your password" step.
//
// WHY THIS EXISTS (pilot T1-P3)
// ---------------------------------------------------------------------------
// An admin creates a municipal operator at /admin/govts/new. The account used
// to be born with a random throwaway password the operator never saw, and the
// only way in was a magic link the admin copied and forwarded by hand. The
// link landed on the site root, where nothing read the session it carried, so
// in practice the operator went through /recuperar to get a password at all.
//
// Now the account is born WITHOUT a password and with a flag in `app_metadata`
// (writable by the service role only — the person cannot clear it from the
// browser). The account is born CONFIRMED (an unconfirmed one can be claimed
// by a public signUp — see create-institutional-account.ts) and the link is
// mailed by the app; it lands on FIRST_ACCESS_PATH, which
// turns the link into a session and asks for a password. Until that happens,
// every page-level guard sends the session back to FIRST_ACCESS_PATH
// (lib/infra/auth-guards.ts → requireUserOrRedirect), so nothing else is
// reachable first.
//
// Mi Argentina federation: the flag is only ever set by the institutional
// creation / credential-reset use cases. A federated identity linked later
// never carries it, so this step never stands in that path.
//
// PURE ON PURPOSE: imported by a server guard and by a client component.

export const FIRST_ACCESS_PATH = "/primer-acceso";

/** Key inside GoTrue's `app_metadata`. */
export const PASSWORD_SETUP_PENDING_KEY = "password_setup_pending";

/**
 * Refusal for the RECOVERY paths while the flag is set (2026-09-18). The
 * recovery proof accepts `otp` sessions — and a first-access link session is
 * one — so without this a person (or whoever holds the link) could set the
 * password at /recuperar/actualizar and walk past /primer-acceso: the flag
 * stayed set, and the arming stamp that pins WHICH session may pay it
 * (isSessionAfterArming, below) was never consulted. A pending account owes
 * its password to the first-access step and to nothing else.
 */
export const PASSWORD_SETUP_PENDING_RECOVERY_MESSAGE =
  "Tu cuenta todavía tiene que elegir su primera contraseña. Entrá con el link de primer acceso que te llegó por mail; si venció, pedile uno nuevo a una persona con rol de administración.";

/** `app_metadata` patch that clears the flag once the password is set. */
export function completedPasswordSetupMetadata(): Record<string, boolean> {
  return { [PASSWORD_SETUP_PENDING_KEY]: false };
}

/**
 * True only for an explicit `true` in the GoTrue user's `app_metadata`.
 * Anything else — absent, false, a string, no metadata at all — is "not
 * pending": an account created before this step existed must never be locked
 * out by it.
 */
export function isPasswordSetupPending(user: unknown): boolean {
  if (typeof user !== "object" || user === null) return false;
  const meta = (user as { app_metadata?: unknown }).app_metadata;
  if (typeof meta !== "object" || meta === null) return false;
  return (meta as Record<string, unknown>)[PASSWORD_SETUP_PENDING_KEY] === true;
}

// ---------------------------------------------------------------------------
// WHICH SESSION may set the password: only one authenticated AFTER the arming.
// ---------------------------------------------------------------------------
// The flag says "this ACCOUNT owes a password". It says nothing about which
// SESSION may pay it. A credential reset re-arms the flag and then revokes every
// session; if that revocation fails, a session the reset was meant to end still
// carries the armed flag — and every guard walks it to FIRST_ACCESS_PATH, where
// it could choose the password the reset took away (security review, 2026-09).
//
// So arming also stamps WHEN it happened, and the step accepts only a session
// authenticated at or after that instant. "Authenticated" is the `amr[].timestamp`
// of the session, NOT the access token's `iat`: `iat` moves on every refresh, so
// a surviving session would simply refresh its way past the stamp.
// lib/infra/operator-shift.ts measured all three candidates against GoTrue.
//
// CLOCK: the stamp is taken from Postgres (`select now()`), the amr timestamp is
// written by GoTrue — two services on one host clock in every environment we
// run. The Node process's clock is never one side of this comparison.

/** Key inside GoTrue's `app_metadata`: ISO instant the flag was last armed. */
export const PASSWORD_SETUP_ARMED_AT_KEY = "password_setup_armed_at";

/**
 * `app_metadata` to stamp on an account that must choose a password next. The
 * ONLY way to arm the flag: an arming without its instant would be refused at
 * the step (fails closed), so there is deliberately no unstamped variant.
 */
export function armedPasswordSetupMetadata(armedAt: Date): Record<string, boolean | string> {
  return {
    [PASSWORD_SETUP_PENDING_KEY]: true,
    [PASSWORD_SETUP_ARMED_AT_KEY]: armedAt.toISOString(),
  };
}

/** The arming instant stamped on the user, or null when absent/unparseable. */
export function passwordSetupArmedAt(user: unknown): Date | null {
  if (typeof user !== "object" || user === null) return null;
  const meta = (user as { app_metadata?: unknown }).app_metadata;
  if (typeof meta !== "object" || meta === null) return null;
  const raw = (meta as Record<string, unknown>)[PASSWORD_SETUP_ARMED_AT_KEY];
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * May a session authenticated at `sessionStartedAt` complete the first access
 * of an account armed at `armedAt`?
 *
 * FAILS CLOSED on either side unknown. An account armed before the stamp
 * existed gets a fresh link from a credential reset; a GoTrue whose token
 * stops carrying amr timestamps breaks first access loudly rather than
 * silently re-opening the takeover.
 *
 * `amr` timestamps are whole seconds, so the arming instant is compared at the
 * same resolution (floored): a link opened in the same second the account was
 * armed is not refused for a sub-second the claim cannot express.
 */
export function isSessionAfterArming(sessionStartedAt: Date | null, armedAt: Date | null): boolean {
  if (sessionStartedAt === null || armedAt === null) return false;
  const armedSecondMs = Math.floor(armedAt.getTime() / 1000) * 1000;
  return sessionStartedAt.getTime() >= armedSecondMs;
}

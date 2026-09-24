// Second factor (TOTP) for institutional accounts — the policy, pure (T2-S6).
//
// WHO. Every institutional principal: admin, govt, national — the same predicate
// the 8-hour operator shift uses (`isInstitutionalPrincipal`, an OR over role and
// account type). Personal accounts — owners, vets, org staff on a personal
// profile — are not asked for a second factor.
//
// WHAT IT ANSWERS, from two server-side facts and nothing the client says:
//
//   · the account's factors, from the user object `auth.getUser()` just fetched
//     from GoTrue (never the cookie's copy);
//   · the session's assurance level, from the `aal` claim of the access token
//     that same `getUser()` validated (`aal1` after a password, `aal2` after a
//     verified TOTP challenge).
//
//   aal claim unreadable         → "unknown" (checked first; see below)
//   no verified factor           → "enrol": the account must set one up before
//                                  it may act. Enrolment is enforced at the first
//                                  institutional request after sign-in — there is
//                                  no grace period, because the population is a
//                                  handful of named operators we onboard by hand.
//   verified factor, aal2        → "satisfied"
//   verified factor, not aal2    → "challenge": type the six digits.
//
// "unknown" is the caller's to interpret, and live-user.ts states its answer:
// it FAILS OPEN and reports, the same direction as the operator shift. The claim
// is minted and signed by GoTrue on every token, so an attacker cannot strip it;
// the only way to lose it is a GoTrue shape change, and locking every operator
// out of every console over that is the worse failure.
//
// Only VERIFIED factors count. An abandoned enrolment leaves an `unverified`
// factor behind, which proves nothing about a phone.

export type MfaFactorLike = { factor_type?: string; status?: string };

export type MfaRequirement = "satisfied" | "enrol" | "challenge" | "unknown";

export function hasVerifiedTotpFactor(factors: ReadonlyArray<MfaFactorLike> | null | undefined) {
  return (factors ?? []).some((f) => f.factor_type === "totp" && f.status === "verified");
}

export function mfaRequirement(input: {
  factors: ReadonlyArray<MfaFactorLike> | null | undefined;
  aal: "aal1" | "aal2" | null;
}): MfaRequirement {
  // Unknown FIRST: without the claim this function cannot tell a satisfied
  // session from an unsatisfied one, and answering "enrol" for it would be a
  // guess dressed as a verdict.
  if (input.aal === null) return "unknown";
  if (!hasVerifiedTotpFactor(input.factors)) return "enrol";
  return input.aal === "aal2" ? "satisfied" : "challenge";
}

// ENROLMENT NEEDS A FRESH SESSION (2026-09-18). Enrolling is trust on first use:
// whoever holds a session of an account WITHOUT a verified factor can bind their
// own phone to it, and from then on they are the one who passes the challenge.
// A session is not proof that its holder just typed the password — the session
// timebox is 30 days (supabase/config.toml [auth.sessions]), so a cookie lifted
// from a shared computer last week is still a session. So the app only offers
// enrolment to a session whose most recent authentication (the newest `amr`
// timestamp — a password, a first-access link, a recovery code) is at most
// fifteen minutes old: long enough to sign in, install an authenticator app
// from the store and scan the code; far too short for an old session.
//
// What this does NOT bind: somebody calling GoTrue's /factors endpoints
// directly with an old token never runs this code. That path is bounded in the
// database instead — the MFA verification hook (migration 0232) refuses to
// verify a NEW factor unless the account signed in within the same window.
//
// Unknown (no usable timestamp) is NOT fresh: failing closed here costs one
// sign-in, and the alternative is letting an unreadable token enrol.
export const MFA_ENROL_MAX_SESSION_AGE_SECONDS = 15 * 60;

/** Tolerated clock skew between GoTrue and this server, for a timestamp "from the future". */
const ENROL_CLOCK_SKEW_MS = 5 * 60 * 1000;

export function isFreshForEnrolment(authenticatedAt: Date | null, now: Date = new Date()): boolean {
  if (!authenticatedAt) return false;
  const ageMs = now.getTime() - authenticatedAt.getTime();
  return ageMs >= -ENROL_CLOCK_SKEW_MS && ageMs <= MFA_ENROL_MAX_SESSION_AGE_SECONDS * 1000;
}

export const MFA_ENROL_STALE_MESSAGE =
  "Por seguridad, para configurar la verificación en dos pasos tenés que haber iniciado sesión hace menos de 15 minutos. Cerrá sesión y volvé a entrar con tu contraseña.";

/** Where a page load goes for each unmet requirement. */
export const MFA_CHALLENGE_PATH = "/mfa";
export const MFA_ENROL_PATH = "/mfa/configurar";

/** es-AR refusal copy for a write boundary that meets an unmet requirement. */
export const MFA_CHALLENGE_MESSAGE =
  "Tu cuenta institucional pide el código de verificación de tu app de autenticación. Ingresalo para seguir.";
export const MFA_ENROL_MESSAGE =
  "Tu cuenta institucional necesita un segundo factor de verificación. Configuralo para seguir.";

// PASSWORD CHANGES ON AN ACCOUNT WITH A FACTOR (2026-09-18). GoTrue refuses to
// set a password from an aal1 session once the account has a verified factor —
// "AAL2 session is required to update email or password when MFA is enabled",
// code `insufficient_aal`, measured on local GoTrue v2.188.1. Every self-service
// path we have sets it from an aal1 session: the recovery code and the recovery
// link (a recovery session is aal1 by nature) and /cuenta/contrasena's proof
// session (a fresh password sign-in). So for these accounts self-service
// recovery CANNOT work, and saying "probá con otra contraseña" would send the
// person round in circles. The way out is the admin credential reset, which
// goes through the admin API — not subject to the check (measured the same day)
// — and hands them a first-access link.
export const MFA_PASSWORD_CHANGE_NEEDS_ADMIN_MESSAGE =
  "Tu cuenta tiene verificación en dos pasos, así que su contraseña no se puede cambiar por esta vía. Pedile a una persona con rol de administración de miMAR que restablezca tus credenciales: te va a dar un link para elegir una contraseña nueva.";

/** GoTrue's refusal to change a password from an aal1 session of an account with MFA. */
export function isInsufficientAalError(
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  if (!error) return false;
  if (error.code === "insufficient_aal") return true;
  return /AAL2 session is required/i.test(error.message ?? "");
}

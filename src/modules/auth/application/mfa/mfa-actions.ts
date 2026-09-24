// The three second-factor steps an institutional operator takes (T2-S6):
//
//   verifyMfaChallengeAction   — /mfa: six digits → the session becomes aal2.
//   startMfaEnrolmentAction    — /mfa/configurar: a new TOTP factor (QR + secret).
//   confirmMfaEnrolmentAction  — /mfa/configurar: first code → factor verified,
//                                session aal2, audit row `mfa_factor_enrolled`.
//
// All three run on the COOKIE client, so a successful verify rewrites the
// session cookies with the aal2 token GoTrue returns — the next request is
// judged on that token by requireLiveUser, never on anything this module says.
//
// None of them grants anything but the factor step: they refuse accounts the
// policy does not cover (personal, erased, deactivated), and enrolment is only
// offered to an account WITHOUT a verified factor — adding a second factor, or
// replacing one, would let a password alone swap the phone. A lost phone is an
// admin reset (reset-mfa-factors.ts), audited.
//
// Enrolment additionally needs a FRESH session (mfa-policy.ts,
// isFreshForEnrolment — signed in within the last fifteen minutes), and a
// completed one mails the account holder (./mfa-enrolled-mail.ts): enrolment is
// trust on first use, and those are the two ways the wrong first user is either
// kept out or found out.
//
// The code is spent against a per-account budget before GoTrue sees it: six
// digits are a million guesses, and GoTrue's own per-IP ceiling keys on OUR
// egress address, shared by every operator in the country.
//
// THIS BUDGET ONLY SEES THE APP. Someone holding the password can post codes
// straight to GoTrue's /factors/{id}/verify and never pass through here. The
// ceiling that binds that path lives in the database: the MFA verification
// attempt hook (migration 0232 — 10 misses an hour, 20 a day, per account;
// supabase/config.toml locally, a Teams/Enterprise feature on hosted Supabase).
// Where the hook is not enabled, the direct path is bounded only by GoTrue's
// per-IP limit — a documented residual, not a covered one.

import QRCode from "qrcode";

import { db } from "@/db";
import { writeAuditLog } from "@/lib/infra/audit-log";
import { RateLimitError, enforceRateLimit } from "@/lib/infra/rate-limit";
import { resolveUserLanding, safeReturnTo } from "@/lib/infra/role-landing";
import { MFA_ENROL_STALE_MESSAGE } from "@/src/modules/auth/domain/mfa-policy";

import type { SupabaseServerClient } from "@/lib/infra/live-user";

import { mailMfaFactorEnrolled } from "./mfa-enrolled-mail";
import { type MfaSession, loadMfaSession } from "./mfa-session";

export type MfaStepState = { error: string | null; next?: string };

export type MfaEnrolmentStart =
  | { error: string }
  | { ok: true; factorId: string; secret: string; qrDataUrl: string };

/** Per-account budget for code attempts (challenge and enrolment together). */
export const MFA_CODE_LIMIT = { maxPerMinute: 5, maxPerHour: 30 };

const SESSION_GONE = "Tu sesión expiró. Volvé a iniciar sesión.";
const NOT_ELIGIBLE = "Esta verificación es solo para cuentas institucionales activas.";
const SHIFT_OVER =
  "Tu turno de trabajo terminó. Por seguridad cerramos la sesión — volvé a iniciar sesión para seguir.";
const BAD_CODE = "El código no es correcto o ya venció. Probá con el que muestra ahora tu app.";
const BAD_FORMAT = "Ingresá los 6 números que muestra tu app de autenticación.";
const TOO_MANY = "Demasiados intentos. Esperá un momento y volvé a probar.";
const FACTOR_ISSUER = "miMAR";

function readCode(formData: FormData): string | null {
  const code = String(formData.get("code") ?? "").replace(/\s+/g, "");
  return /^\d{6}$/.test(code) ? code : null;
}

async function spendCodeBudget(userId: string): Promise<string | null> {
  try {
    await enforceRateLimit("auth_mfa_code_user", userId, MFA_CODE_LIMIT);
    return null;
  } catch (err) {
    if (err instanceof RateLimitError) return TOO_MANY;
    throw err;
  }
}

async function landingAfterMfa(session: MfaSession, formData: FormData): Promise<string> {
  return (
    safeReturnTo(String(formData.get("returnTo") ?? "")) ??
    (await resolveUserLanding(session.userId))
  );
}

export async function verifyMfaChallengeAction(
  supabase: SupabaseServerClient,
  _previous: MfaStepState,
  formData: FormData,
): Promise<MfaStepState> {
  const session = await loadMfaSession(supabase);
  if (!session) return { error: SESSION_GONE };
  if (!session.eligible) return { error: NOT_ELIGIBLE };
  if (session.shiftExpired) return { error: SHIFT_OVER };
  if (!session.verifiedFactorId) {
    return { error: "Tu cuenta todavía no tiene un segundo factor configurado." };
  }

  const code = readCode(formData);
  if (!code) return { error: BAD_FORMAT };
  const limited = await spendCodeBudget(session.userId);
  if (limited) return { error: limited };

  const { error } = await session.supabase.auth.mfa.challengeAndVerify({
    factorId: session.verifiedFactorId,
    code,
  });
  if (error) return { error: BAD_CODE };

  return { error: null, next: await landingAfterMfa(session, formData) };
}

export async function startMfaEnrolmentAction(
  supabase: SupabaseServerClient,
): Promise<MfaEnrolmentStart> {
  const session = await loadMfaSession(supabase);
  if (!session) return { error: SESSION_GONE };
  if (!session.eligible) return { error: NOT_ELIGIBLE };
  if (session.shiftExpired) return { error: SHIFT_OVER };
  if (session.verifiedFactorId) {
    return {
      error:
        "Tu cuenta ya tiene un segundo factor. Si perdiste el acceso a tu app, pedile a un admin que lo restablezca.",
    };
  }
  if (!session.enrolmentFresh) return { error: MFA_ENROL_STALE_MESSAGE };

  // An abandoned enrolment leaves an UNVERIFIED factor behind; clear it so the
  // new one does not collide with it. Unverified factors prove nothing and the
  // person may remove their own at aal1.
  const { data: listed } = await session.supabase.auth.mfa.listFactors();
  for (const stale of listed?.all ?? []) {
    if (stale.status !== "verified") {
      await session.supabase.auth.mfa.unenroll({ factorId: stale.id });
    }
  }

  const { data, error } = await session.supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: "App de autenticación",
    issuer: FACTOR_ISSUER,
  });
  if (error || !data) {
    return { error: "No pudimos iniciar la configuración. Probá de nuevo en unos minutos." };
  }

  // The QR is drawn HERE from the otpauth URI, as a PNG data URL, rather than
  // rendering GoTrue's SVG markup in the page: no foreign markup reaches the DOM.
  const qrDataUrl = await QRCode.toDataURL(data.totp.uri, { margin: 1, width: 220 });
  return { ok: true, factorId: data.id, secret: data.totp.secret, qrDataUrl };
}

export async function confirmMfaEnrolmentAction(
  supabase: SupabaseServerClient,
  _previous: MfaStepState,
  formData: FormData,
): Promise<MfaStepState> {
  const session = await loadMfaSession(supabase);
  if (!session) return { error: SESSION_GONE };
  if (!session.eligible) return { error: NOT_ELIGIBLE };
  if (session.shiftExpired) return { error: SHIFT_OVER };

  // Confirming is only for an account that has no verified factor yet; with one
  // in place this would be a plain challenge recorded as an enrolment.
  if (session.verifiedFactorId) {
    return { error: "Tu cuenta ya tiene un segundo factor configurado." };
  }
  if (!session.enrolmentFresh) return { error: MFA_ENROL_STALE_MESSAGE };
  const factorId = String(formData.get("factorId") ?? "");
  if (!factorId) return { error: "Volvé a empezar la configuración." };
  const code = readCode(formData);
  if (!code) return { error: BAD_FORMAT };
  const limited = await spendCodeBudget(session.userId);
  if (limited) return { error: limited };

  // GoTrue scopes the factor to the session's own user: a factor id of somebody
  // else is refused there, not here.
  const { error } = await session.supabase.auth.mfa.challengeAndVerify({ factorId, code });
  if (error) return { error: BAD_CODE };

  // The factor exists and is verified at GoTrue; this row is its trace. `db`,
  // not a transaction: the fact being recorded is not a Postgres write.
  await writeAuditLog(db, {
    action: "mfa_factor_enrolled",
    actorUserId: session.userId,
    targetUserId: session.userId,
    payload: { factor_id: factorId, factor_type: "totp" },
  });

  // Best-effort by construction (it never throws): the factor is enrolled and
  // audited whatever the mail provider says.
  if (session.email) {
    await mailMfaFactorEnrolled({ to: session.email, enrolledAt: new Date() });
  }

  return { error: null, next: await landingAfterMfa(session, formData) };
}

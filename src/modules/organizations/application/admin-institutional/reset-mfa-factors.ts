// Use-case: resetMfaFactorsForAuthority — admin-assisted second-factor recovery
// (T2-S6).
//
// WHY THIS EXISTS. Institutional accounts must pass TOTP before any portal
// (src/modules/auth/domain/mfa-policy.ts). Supabase Auth has NO recovery codes,
// so an operator who loses the phone that holds the factor has no self-service
// way back in. This is the way back: an admin removes EVERY factor of the
// account, and the operator enrols a new one on /mfa/configurar.
//
// IT RESETS THE CREDENTIALS TOO (2026-09-18). Removing the factors alone left
// the account exactly where an attacker wants it: no factor, the old password
// still valid, every live session still alive. Enrolment is trust on first use,
// so any of those sessions — or anyone holding the password — could enrol THEIR
// phone seconds after the reset and own the account from then on. So the reset
// runs the credential reset first (reset-institutional-credentials.ts): the
// password is replaced by a random one nobody holds, every session is ended
// (or, if that fails, the account is DEACTIVATED and no factor is touched), the
// first-access flag is re-armed, and a fresh one-time link is issued. The
// person comes back through that link, sets a password, and enrols from a
// session that is minutes old — which is also the only kind of session
// /mfa/configurar accepts. The link goes back to the admin exactly as the
// credential reset returns it (the panel shows it to forward by hand).
//
// It is how the control is disarmed for one account, so it carries the same
// friction as a credential reset: admin only, a motivo, never on oneself (an
// admin whose own factor is gone asks another admin — otherwise a stolen admin
// password plus this button would be a way past the second factor), and an
// audit row naming the removed factor ids. Never a secret.
//
// ORDER. Credentials, then the lockout counters, then factors, then the audit
// row with what actually happened. Credentials first because a failure there must leave the factor in
// place: a factor-less account with live sessions is the state this ordering
// exists to never create. The steps cannot share a transaction (they are HTTP
// calls). If a deletion fails halfway, the factors that WERE removed are still
// audited and the admin is told; the credentials are already reset, which is
// the safe side.
//
// THE FACTOR LIST IS READ TWICE (review LOW-3). The first read is a pre-flight:
// a GoTrue that cannot list factors stops the reset while the account is whole.
// But between that read and the end of the credential reset, a still-live
// session could enrol a new factor, and deleting only the pre-flight set would
// leave it standing. So the set actually deleted is re-read AFTER the sessions
// are gone, when nobody can enrol anything any more.
//
// THE LOCKOUT COUNTERS (review MEDIUM-1). The GoTrue MFA verification hook
// (migrations 0232/0233) counts wrong codes per account in rate_limit_buckets
// under `mfa_verify_fail:<user>:hour|day:<window>` and rejects every attempt
// once the ceiling is hit. A reset that left them would hand back an account
// that still cannot enrol until the window rolls over (up to a day). They are
// cleared once the sessions are revoked — before that, a leftover session could
// start spending the fresh budget.

import { eq, like } from "drizzle-orm";

import { db, profiles, rateLimitBuckets } from "@/db";
import { canResetCredentials } from "@/lib/domain/institutional-scope";
import { MOTIVO_MIN } from "@/lib/domain/revocation-validation";
import { writeAuditLog } from "@/lib/infra/audit-log";
import { createAdminClient } from "@/lib/supabase/admin";

import { loadActorProfile } from "./helpers";
import { resetInstitutionalCredentialsForAuthority } from "./reset-institutional-credentials";

/**
 * LIKE pattern for every MFA-hook failure bucket of one account. The literal
 * underscores in the prefix are escaped so they match only themselves.
 */
export function mfaFailBucketPattern(userId: string): string {
  return `mfa\\_verify\\_fail:${userId}:%`;
}

export type ResetMfaFactorsResult =
  | { error: string }
  | { ok: true; removed: number; magicLink: string };

export async function resetMfaFactorsForAuthority(
  actorUserId: string,
  input: { targetUserId: string; reason: string },
): Promise<ResetMfaFactorsResult> {
  const reason = (input.reason ?? "").trim();
  if (reason.length < MOTIVO_MIN) {
    return { error: `El motivo requiere al menos ${MOTIVO_MIN} caracteres.` };
  }

  const actor = await loadActorProfile(actorUserId);
  if (!actor || !canResetCredentials(actor)) return { error: "CAPABILITY_DENIED" };
  if (input.targetUserId === actorUserId) {
    return {
      error:
        "No podés restablecer tu propio segundo factor. Pedíselo a otra persona con rol de administración.",
    };
  }

  const [target] = await db
    .select({ id: profiles.id, accountType: profiles.accountType })
    .from(profiles)
    .where(eq(profiles.id, input.targetUserId))
    .limit(1);
  if (!target) return { error: "NOT_FOUND" };
  if (target.accountType !== "institutional") return { error: "NOT_INSTITUTIONAL" };

  // Read the factors BEFORE anything changes, so a GoTrue that cannot even list
  // them stops the reset while the account is still whole.
  const admin = createAdminClient();
  const { data: listed, error: listError } = await admin.auth.admin.mfa.listFactors({
    userId: input.targetUserId,
  });
  if (listError || !listed) {
    return { error: "No pudimos leer los factores de la cuenta. Probá de nuevo en unos minutos." };
  }

  const credentials = await resetInstitutionalCredentialsForAuthority(actorUserId, {
    targetUserId: input.targetUserId,
    reason,
  });
  if ("error" in credentials) return { error: credentials.error };

  // Sessions are gone: lift the hook's lockout so the person can enrol again.
  let bucketsCleared = true;
  try {
    await db
      .delete(rateLimitBuckets)
      .where(like(rateLimitBuckets.bucketKey, mfaFailBucketPattern(input.targetUserId)));
  } catch (e) {
    console.error("reset-mfa: could not clear the mfa_verify_fail buckets", e);
    bucketsCleared = false;
  }

  // Re-read now that nobody can enrol: this is the set that gets deleted.
  const { data: current, error: relistError } = await admin.auth.admin.mfa.listFactors({
    userId: input.targetUserId,
  });
  if (relistError || !current) {
    return {
      error:
        "Restablecimos la contraseña y cerramos las sesiones, pero no pudimos leer los factores de la cuenta. Probá de nuevo en unos minutos.",
    };
  }

  const removedIds: string[] = [];
  let failed = false;
  for (const factor of current.factors) {
    const { error } = await admin.auth.admin.mfa.deleteFactor({
      userId: input.targetUserId,
      id: factor.id,
    });
    if (error) {
      failed = true;
      break;
    }
    removedIds.push(factor.id);
  }

  // Nothing to remove and nothing removed: no fact happened, so no row.
  if (removedIds.length > 0) {
    await writeAuditLog(db, {
      action: "mfa_factors_reset_by_admin",
      actorUserId,
      targetUserId: input.targetUserId,
      payload: { reason, factor_ids: removedIds, complete: !failed },
    });
  }

  if (failed) {
    return {
      error:
        "No pudimos quitar todos los factores de la cuenta. Lo que se quitó quedó registrado; probá de nuevo.",
    };
  }
  if (!bucketsCleared) {
    return {
      error:
        "Quitamos los factores, pero no pudimos levantar el bloqueo por códigos incorrectos. Probá de nuevo en unos minutos.",
    };
  }
  return { ok: true, removed: removedIds.length, magicLink: credentials.magicLink };
}

// Use-case: verifyDniForUser — strangler migration 38/61.
//
// Pure writer: receives userId + raw DNI string, validates, runs the DB
// transaction, and returns the result. No Next.js request context.
//
// The outer shim (app/actions/dni-verification.ts) gates via requireUserOrRedirect.
// Tests call verifyDniForUser directly with a known userId.

import { eq } from "drizzle-orm";

import { auditLog, db, notifications, profiles } from "@/db";
import { pgError } from "@/lib/infra/db-errors";
import { dniLast4, hashDni } from "@/lib/utils/dni-hash";

import type { DniVerifyResult } from "./types";

// ============================================================================
// Validation helpers
// ============================================================================

// Argentine DNI is 7–8 digits. No spaces, no dots, no dashes.
const DNI_RE = /^\d{7,8}$/;

function validateDni(raw: string): { trimmed: string; error: string | null } {
  const trimmed = raw.trim().replace(/[.\s-]/g, "");
  if (!DNI_RE.test(trimmed)) {
    return { trimmed, error: "El DNI debe tener 7 u 8 dígitos numéricos." };
  }
  return { trimmed, error: null };
}

// Postgres 23505 = unique_violation. Mirror of isUniqueViolationOn in upgrade.ts.
// pgError unwraps drizzle 0.45's `.cause` chain to the real postgres-js error.
function isDniUniqueViolation(err: unknown): boolean {
  const info = pgError(err);
  if (!info || info.code !== "23505") return false;
  const constraint = info.constraint ?? "";
  const detail = typeof info.raw.detail === "string" ? info.raw.detail : "";
  // The partial unique index is named profiles_dni_hash_unique (migration 0106).
  return constraint.includes("dni") || detail.includes("(dni_hash)");
}

// ============================================================================
// Pure inner writer — testable without FormData or Supabase client
// ============================================================================

/**
 * Sets dni_hash + dni_last4 + dni_verified=true for `userId`.
 *
 * No DNI in plaintext (Wave 5 Item 25a): the raw DNI is never persisted.
 * Only the HMAC-SHA256 hash (lib/dni-hash.ts) and the last 4 digits are stored.
 *
 * - Short-circuits idempotently if the profile already has dni_verified=true.
 * - Catches 23505 on the partial unique index and returns a friendly error.
 * - Inserts one audit_log row (action: "dni_verified_self").
 * - Inserts one self-notification (notificationType: "profile_self_updated").
 *
 * TODO(25b): replace this direct DB write with a verified assertion from the
 * Mi Argentina OAuth callback. The outer shape (userId in, result out) stays
 * the same; only the trust source changes.
 */
export async function verifyDniForUser(userId: string, rawDni: string): Promise<DniVerifyResult> {
  const { trimmed, error: formatError } = validateDni(rawDni);
  if (formatError) return { ok: false, error: formatError };

  // Load profile — need current state to check idempotency.
  const [profile] = await db
    .select({ dniVerified: profiles.dniVerified, dniLast4: profiles.dniLast4 })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);

  if (!profile) return { ok: false, error: "Perfil no encontrado." };

  // Idempotent short-circuit: already verified AND there is a DNI on file.
  //
  // The flag alone was the condition, and it made a half-state UNREPAIRABLE:
  // a profile flagged verified with no dni_hash/dni_last4 got `ok: true` back
  // without a single write, so submitting the form reported success and changed
  // nothing, forever. The seed produced exactly that state on every demo account
  // (master test CIU, N2b) — but the guard is not about the seed. The two
  // columns are written together by the transaction below, so if they are ever
  // apart, something skipped this writer and the repair has to be allowed
  // through rather than reported as already-done.
  if (profile.dniVerified && profile.dniLast4) return { ok: true };

  const dniHashValue = hashDni(trimmed);
  const dniLast4Value = dniLast4(trimmed);

  try {
    await db.transaction(async (tx) => {
      await tx
        .update(profiles)
        .set({
          dniHash: dniHashValue,
          dniLast4: dniLast4Value,
          dniVerified: true,
          dniVerifiedAt: new Date(),
          identitySource: "legacy",
          updatedAt: new Date(),
        })
        .where(eq(profiles.id, userId));

      await tx.insert(auditLog).values({
        actorUserId: userId,
        action: "dni_verified_self",
        targetUserId: userId,
        payload: { method: "placeholder_form" },
      });

      await tx.insert(notifications).values({
        userId,
        notificationType: "profile_self_updated",
        title: "DNI declarado",
        body: "Tu DNI fue registrado correctamente en miMAR.",
        severity: "success",
        ctaLabel: "Ver mi cuenta",
        ctaUrl: "/cuenta",
      });
    });
  } catch (err) {
    // DNI enumeration defense (audit 28-#3, Tier-2 authz critique AU-1).
    // A distinct "ese DNI ya está registrado por otra cuenta" message confirmed
    // to an authenticated attacker which DNIs already exist — probing the
    // profiles_dni_hash_unique index (migration 0106) turns this verify flow
    // into a DNI oracle, and this path has no rate limit. Mirror the sibling
    // hardening in complete-identity.ts: the USER-FACING string is GENERIC and
    // identical whether the failure is a DNI collision or any other write error,
    // so the two are indistinguishable. The duplicate is still prevented
    // server-side — the partial unique index rejects the second insert.
    //
    // The isDniUniqueViolation branch is KEPT for server-side logging only
    // (differentiated observability) — only the copy returned to the user is
    // collapsed to the generic message.
    if (isDniUniqueViolation(err)) {
      console.warn("[verifyDniForUser] dni_hash unique violation (duplicate DNI collision)");
    } else {
      console.error("[verifyDniForUser] DNI write failed:", err);
    }
    return {
      ok: false,
      error: "No pudimos guardar tus datos. Revisá la información e intentá de nuevo.",
    };
  }

  return { ok: true };
}

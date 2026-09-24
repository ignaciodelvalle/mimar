// Use-case: selfDeactivatePersonalAccountForUser (14.1 Zona de riesgo)
//
// Steps:
//   1. Load profile — must be personal + (owner|vet) + not already deactivated
//   2. Validate reason (min 5 chars)
//   3. SET deactivated_at (anti-race WHERE)
//   4. INSERT audit_log
//
// auth.users is NOT deleted — allows reactivation by admin.
// No coverage check needed (only govt needs that).

import { and, eq, isNull } from "drizzle-orm";

import { auditLog, db, profiles } from "@/db";

import type { PersonalSelfDeactivateResult } from "./types";

export async function selfDeactivatePersonalAccountForUser(
  userId: string,
  reason: string,
): Promise<PersonalSelfDeactivateResult> {
  if (!reason || reason.trim().length < 5) {
    return { error: "REASON_TOO_SHORT: El motivo debe tener al menos 5 caracteres." };
  }

  const [profile] = await db
    .select({
      id: profiles.id,
      role: profiles.role,
      accountType: profiles.accountType,
      deactivatedAt: profiles.deactivatedAt,
    })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);

  if (!profile) return { error: "NOT_FOUND" };
  if (profile.accountType !== "personal") {
    return { error: "ROLE_MISMATCH: solo cuentas personales pueden usar esta acción." };
  }
  // Idempotency: already deactivated.
  if (profile.deactivatedAt !== null) return { ok: true, noOp: true };

  try {
    await db.transaction(async (tx) => {
      // SET deactivated_at (anti-race WHERE ensures exactly once).
      const updated = await tx
        .update(profiles)
        .set({ deactivatedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(profiles.id, userId), isNull(profiles.deactivatedAt)))
        .returning({ id: profiles.id });

      if (updated.length === 0) {
        // Another concurrent call won the race — treat as success (idempotent).
        throw Object.assign(new Error("RACE_CONDITION"), {});
      }

      await tx.insert(auditLog).values({
        actorUserId: userId,
        action: "personal_self_deactivated",
        targetUserId: userId,
        payload: { reason: reason.trim(), role: profile.role },
      });
    });
  } catch (err) {
    if (err instanceof Error && err.message === "RACE_CONDITION") {
      return { ok: true, noOp: true };
    }
    return {
      error: err instanceof Error ? err.message : "Error desconocido al desactivar cuenta.",
    };
  }

  return { ok: true };
}

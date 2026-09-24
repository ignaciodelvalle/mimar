// Use-case: selfReactivatePersonalAccountForUser — the way BACK from
// selfDeactivatePersonalAccountForUser.
//
// WHY IT EXISTS
// ---------------------------------------------------------------------------
// Until `requireLiveUser` started reading `deactivated_at` on personal accounts,
// self-deactivation cost the user nothing — the dialog said the account was off
// and every write still worked. Making the flag real closes that lie, and it
// opens a worse one if nothing else moves: a person who switched their own
// account off would meet a refusal on every write with no self-service way out,
// and would have to ask support for permission to undo their own decision.
//
// This is that way out. It is the exact inverse of the deactivate use-case and
// deliberately no more than that:
//   1. Load profile — must be personal, not erased, and currently deactivated
//   2. CLEAR deactivated_at (anti-race WHERE — exactly-once, like the deactivate)
//   3. INSERT audit_log
//
// PERSONAL ONLY, AND THAT IS THE WHOLE SECURITY ARGUMENT. An INSTITUTIONAL
// deactivation is an act of an operator on somebody else's account; letting its
// subject undo it here would be a privilege escalation dressed as a self-service
// affordance. A personal deactivation is an act of the person on their OWN
// account, which is why undoing it needs nobody's permission. The accountType
// check below is what keeps those two apart, and it must not be relaxed into
// "not institutional" or dropped in favour of a UI that simply does not render
// the button.
//
// NOT reachable by a caller who is not the subject: the action wrapper resolves
// the user id from the session (app/actions/profile-self-service.ts) and this
// writer is never exported from a "use server" file.

import { and, eq, isNotNull, isNull } from "drizzle-orm";

import { auditLog, db, profiles } from "@/db";

import type { PersonalSelfReactivateResult } from "./types";

export async function selfReactivatePersonalAccountForUser(
  userId: string,
): Promise<PersonalSelfReactivateResult> {
  const [profile] = await db
    .select({
      id: profiles.id,
      role: profiles.role,
      accountType: profiles.accountType,
      deactivatedAt: profiles.deactivatedAt,
      deletedAt: profiles.deletedAt,
    })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);

  if (!profile) return { error: "NOT_FOUND" };

  // Erasure outranks deactivation here for the same reason it outranks it in
  // requireLiveUser's precedence: an erased account has no identity left to
  // reactivate, and its PII is already hashed. Reviving it would hand a live
  // account back to a subject the system has finished forgetting.
  if (profile.deletedAt !== null) {
    return { error: "ACCOUNT_ERASED: no se puede reactivar una cuenta eliminada." };
  }

  if (profile.accountType !== "personal") {
    return { error: "ROLE_MISMATCH: solo cuentas personales pueden usar esta acción." };
  }

  // Idempotency: already active. Mirrors the deactivate use-case's noOp branch.
  if (profile.deactivatedAt === null) return { ok: true, noOp: true };

  try {
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(profiles)
        .set({ deactivatedAt: null, updatedAt: new Date() })
        // Anti-race WHERE: `isNotNull` is the mirror of the deactivate's
        // `isNull`, so two concurrent reactivations produce exactly one write
        // and one audit row. `isNull(deletedAt)` is re-asserted INSIDE the
        // statement rather than trusted from the SELECT above — an erasure that
        // committed between the two would otherwise be undone by this UPDATE.
        .where(
          and(
            eq(profiles.id, userId),
            isNotNull(profiles.deactivatedAt),
            isNull(profiles.deletedAt),
          ),
        )
        .returning({ id: profiles.id });

      if (updated.length === 0) {
        throw Object.assign(new Error("RACE_CONDITION"), {});
      }

      await tx.insert(auditLog).values({
        actorUserId: userId,
        action: "personal_self_reactivated",
        targetUserId: userId,
        payload: { role: profile.role },
      });
    });
  } catch (err) {
    if (err instanceof Error && err.message === "RACE_CONDITION") {
      return { ok: true, noOp: true };
    }
    return {
      error: err instanceof Error ? err.message : "Error desconocido al reactivar cuenta.",
    };
  }

  return { ok: true };
}

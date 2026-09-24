// Capability helpers for institutional account management (Fase 5).
//
// All functions are pure — no DB access. The caller is responsible for loading
// any DB state and passing it in. This design keeps the helpers easily unit-
// testable and reusable for both UI gating (pre-check, cheap) and the server
// action (which then re-checks authoritatively inside a transaction).
//
// TOCTOU note: canDeactivateAdmin takes an activeAdminCount snapshot.
// The inner writer MUST re-query that count inside a SELECT FOR UPDATE
// transaction to defeat any race condition — the helper exists for UI gating
// only, NOT as the authoritative check.

export type ActorProfile = {
  id: string;
  // Mirrors `profiles.role` (db/schema.ts userRoleEnum). Spelled out rather
  // than imported so this domain module stays free of the Drizzle schema.
  role: "owner" | "vet" | "govt" | "admin" | "national";
  accountType: "personal" | "institutional";
  deactivatedAt: Date | null;
};

// Admin gate — shared primitive reused by all capability helpers below.
// An active institutional admin is required for every Fase 5 privileged action.
function isActiveAdmin(actor: ActorProfile): boolean {
  return (
    actor.accountType === "institutional" && actor.role === "admin" && actor.deactivatedAt === null
  );
}

// Can the actor create a new institutional account (govt or admin)?
// Only active institutional admins can create operators.
export function canCreateInstitutional(actor: ActorProfile): boolean {
  return isActiveAdmin(actor);
}

// Can the actor deactivate another admin?
//
// Rules:
// - Actor must be an active admin (isActiveAdmin gate).
// - Actor must NOT be the same user as the target (no self-deactivation).
// - activeAdminCount must be > 1 (the last admin cannot be removed from the system).
//
// IMPORTANT: activeAdminCount is a SNAPSHOT provided by the caller for UI
// pre-gating only. The writer MUST verify this count inside a FOR UPDATE
// transaction to prevent the last-admin TOCTOU race.
export function canDeactivateAdmin(
  actor: ActorProfile,
  targetAdminUserId: string,
  activeAdminCount: number,
): boolean {
  if (!isActiveAdmin(actor)) return false;
  if (actor.id === targetAdminUserId) return false; // self-deactivation denied
  if (activeAdminCount <= 1) return false; // last-admin invariant
  return true;
}

// Can the actor deactivate a govt?
// Only active institutional admins can override govt accounts.
// Govts cannot deactivate other govts — only admins can.
export function canDeactivateGovt(actor: ActorProfile): boolean {
  return isActiveAdmin(actor);
}

// Can the actor reset an institutional operator's credentials (generate magic link)?
export function canResetCredentials(actor: ActorProfile): boolean {
  return isActiveAdmin(actor);
}

// Can the actor assign a new locality to a govt?
export function canAssignGovtLocality(actor: ActorProfile): boolean {
  return isActiveAdmin(actor);
}

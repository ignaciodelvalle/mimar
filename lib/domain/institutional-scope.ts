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
//
// Admin authority (jurisdiction-admin): there is ONE definition of "platform
// admin" — isPlatformAdmin below — and ONE decision of what administrative
// authority an actor holds — decideAdminAuthority. The loader that feeds them
// from the database lives in
// src/modules/organizations/application/admin-authority/authority.ts; no other
// file may re-derive either (the five local isActiveAdmin copies that used to
// do so were removed).

export type ActorProfile = {
  id: string;
  // Mirrors `profiles.role` (db/schema.ts userRoleEnum). Spelled out rather
  // than imported so this domain module stays free of the Drizzle schema.
  role: "owner" | "vet" | "govt" | "admin" | "national";
  accountType: "personal" | "institutional";
  deactivatedAt: Date | null;
  // An erased (right-to-erasure, Ley 25.326 art. 16) profile holds no
  // authority whatever its role says. Required, not optional: a loader that
  // forgot to select it must fail to compile rather than read as "not erased".
  deletedAt: Date | null;
};

/**
 * The platform admin: an institutional account with role `admin` that is
 * neither deactivated nor erased. The single predicate behind every
 * platform-only capability below and behind requirePlatformAdmin.
 */
export function isPlatformAdmin(actor: ActorProfile): boolean {
  return (
    actor.accountType === "institutional" &&
    actor.role === "admin" &&
    actor.deactivatedAt === null &&
    actor.deletedAt === null
  );
}

/**
 * What administrative authority an actor holds.
 *   - platform:     the platform admin — acts anywhere, including country-wide.
 *   - jurisdiction: an active govt funcionario holding an ACTIVE jurisdiction
 *                   admin appointment — acts inside `provinceCode` only.
 *   - none:         everyone else, including a govt whose appointment is
 *                   missing or revoked. Fails closed to plain govt, never
 *                   upward.
 */
export type AdminAuthority =
  | { kind: "platform" }
  | { kind: "jurisdiction"; provinceCode: string }
  | { kind: "none" };

/**
 * `appointmentProvince` is the answer of the database's
 * public.jurisdiction_admin_province(user) — the province of the actor's
 * ACTIVE appointment whose implied whole-province grant is also active, or
 * null. The profile checks are repeated here so a stale or forged province
 * never lifts an account that is not an active institutional govt.
 */
export function decideAdminAuthority(
  actor: ActorProfile | null,
  appointmentProvince: string | null,
): AdminAuthority {
  if (!actor) return { kind: "none" };
  if (isPlatformAdmin(actor)) return { kind: "platform" };
  if (
    appointmentProvince !== null &&
    appointmentProvince !== "" &&
    actor.role === "govt" &&
    actor.accountType === "institutional" &&
    actor.deactivatedAt === null &&
    actor.deletedAt === null
  ) {
    return { kind: "jurisdiction", provinceCode: appointmentProvince };
  }
  return { kind: "none" };
}

/**
 * May this authority act on a target in `provinceCode`? `null` means the
 * target belongs to no province (a country-wide rule, a platform-only act):
 * only the platform admin may act on it.
 */
export function canActInProvince(authority: AdminAuthority, provinceCode: string | null): boolean {
  if (authority.kind === "platform") return true;
  if (authority.kind === "none") return false;
  return provinceCode !== null && provinceCode === authority.provinceCode;
}

// Can the actor create a new institutional account (govt or admin)?
// Only active institutional admins can create operators.
export function canCreateInstitutional(actor: ActorProfile): boolean {
  return isPlatformAdmin(actor);
}

// Can the actor deactivate another admin?
//
// Rules:
// - Actor must be the platform admin (isPlatformAdmin gate).
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
  if (!isPlatformAdmin(actor)) return false;
  if (actor.id === targetAdminUserId) return false; // self-deactivation denied
  if (activeAdminCount <= 1) return false; // last-admin invariant
  return true;
}

// Can the actor deactivate a govt?
// Only active institutional admins can override govt accounts.
// Govts cannot deactivate other govts — only admins can.
export function canDeactivateGovt(actor: ActorProfile): boolean {
  return isPlatformAdmin(actor);
}

// Can the actor reset an institutional operator's credentials (generate magic link)?
export function canResetCredentials(actor: ActorProfile): boolean {
  return isPlatformAdmin(actor);
}

// Can the actor assign a new locality to a govt?
export function canAssignGovtLocality(actor: ActorProfile): boolean {
  return isPlatformAdmin(actor);
}

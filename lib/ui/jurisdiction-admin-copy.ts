// The operator-facing copy for every refusal the database makes of a
// jurisdiction-admin act (migrations 0268/0269/0270). Pure and client-safe:
// the /admin/designaciones forms read it, and so do server writers that must
// never hand a raw trigger message to the UI (security review L5). The
// translation FROM a database error lives in
// lib/infra/jurisdiction-admin-refusals.ts.

export type JurisdictionAdminRefusal =
  | "PLATFORM_ONLY"
  | "NO_AUTHORITY"
  | "OUT_OF_PROVINCE"
  | "COUNTRY_WIDE"
  | "IMPLIED_GRANT_ACTIVE"
  | "APPOINTEE_INVALID"
  | "GRANT_INVALID"
  | "FOREIGN_GRANT"
  | "APPEND_ONLY"
  | "AUDIT_PROVINCE_MISMATCH"
  | "PROVINCE_TAKEN"
  | "USER_ALREADY_APPOINTED";

/** What an operator reads for each refusal (es-AR). */
export const JURISDICTION_ADMIN_REFUSAL_COPY: Readonly<Record<JurisdictionAdminRefusal, string>> = {
  PLATFORM_ONLY:
    "Solo el administrador de la plataforma puede designar o revocar administradores de jurisdicción.",
  NO_AUTHORITY: "No tenés permiso de administración para hacer este cambio.",
  OUT_OF_PROVINCE: "Solo podés actuar dentro de tu jurisdicción.",
  COUNTRY_WIDE: "No podés crear reglas para todo el país.",
  IMPLIED_GRANT_ACTIVE:
    "Esa concesión sostiene una designación de administrador de jurisdicción: revocá primero la designación.",
  APPOINTEE_INVALID: "Solo se puede designar a una cuenta de gobierno institucional activa.",
  GRANT_INVALID:
    "La persona necesita una concesión activa de toda la provincia para ser designada.",
  FOREIGN_GRANT: "Esa persona tiene concesiones en otra provincia. Revocalas antes de designarla.",
  APPEND_ONLY: "Esa designación ya fue revocada.",
  AUDIT_PROVINCE_MISMATCH: "No se pudo registrar el cambio en la auditoría. Probá de nuevo.",
  PROVINCE_TAKEN: "Esa provincia ya tiene un administrador de jurisdicción activo.",
  USER_ALREADY_APPOINTED: "Esa persona ya es administradora de otra jurisdicción.",
};

/**
 * What an operator reads when a delegated WRITER refuses a jurisdiction
 * admin before the database is asked (Phase 4). The writers decide; this is
 * only the copy (es-AR).
 */
export const JURISDICTION_ADMIN_WRITER_COPY = {
  /** An account outside the actor's province, or with no place at all. */
  CREATE_OUTSIDE_PROVINCE: "No podés crear funcionarios fuera de tu jurisdicción.",
  /** role admin | national requested by anyone but the platform admin. */
  CREATE_PLATFORM_ROLE:
    "Solo el administrador de la plataforma puede crear administradores o cuentas nacionales.",
  /** The actor targeted their own account. */
  SELF_DEACTIVATE: "No podés desactivar tu propia cuenta.",
  /** Any other target outside the actor's province (another appointee included). */
  OUT_OF_PROVINCE: "Solo podés actuar dentro de tu jurisdicción.",
  /** A rule with no province (country-wide or foreign country). */
  COUNTRY_WIDE: "No podés crear reglas para todo el país.",
  /** Neither the platform admin nor a live jurisdiction admin. */
  NO_AUTHORITY: "No tenés permiso de administración para hacer este cambio.",
} as const;

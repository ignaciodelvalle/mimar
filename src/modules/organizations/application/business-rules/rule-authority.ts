// Who may write a business rule, and where (jurisdiction-admin Phase 4).
//
// The platform admin writes any rule, country-wide included. A jurisdiction
// admin writes only a rule whose place lies wholly in their province — the
// place of the rule being created (the server-resolved unit / catalogue row /
// province), or the STORED place of the rule being updated or deleted, never
// what the form says. A rule with no province (country-wide, or a foreign
// country) is the platform admin's alone. Everyone else writes nothing.
//
// The database answers the same question on its own (0269/0270 rule guard +
// audit guard); this is the app's half, asked first and inside the writer's
// transaction so an operator reads a sentence instead of a trigger error.

import { pgError } from "@/lib/infra/db-errors";
import { jurisdictionAdminRefusal } from "@/lib/infra/jurisdiction-admin-refusals";
import {
  JURISDICTION_ADMIN_REFUSAL_COPY,
  JURISDICTION_ADMIN_WRITER_COPY,
} from "@/lib/ui/jurisdiction-admin-copy";
import {
  type AuthorityExecutor,
  hasAdminAuthority,
  requireJurisdictionAdminFor,
  requirePlatformAdmin,
} from "@/src/modules/organizations/application/admin-authority/authority";
import { provincesOfRulePlace } from "@/src/modules/organizations/application/admin-authority/target-province";

export type RulePlaceColumns = {
  jurisdictionCountry: string;
  jurisdictionProvince: string | null;
  authorityUnitId: string | null;
  localityId: string | null;
};

/** The es-AR refusal for `actorUserId` writing a rule at `place`, or null. */
export async function ruleWriteRefusal(
  exec: AuthorityExecutor,
  actorUserId: string,
  place: RulePlaceColumns,
): Promise<string | null> {
  if (!(await hasAdminAuthority(exec, actorUserId))) {
    return JURISDICTION_ADMIN_WRITER_COPY.NO_AUTHORITY;
  }
  const provinces = await provincesOfRulePlace(exec, place);
  if (await requireJurisdictionAdminFor(exec, actorUserId, provinces)) return null;
  return provinces.length === 0
    ? JURISDICTION_ADMIN_WRITER_COPY.COUNTRY_WIDE
    : JURISDICTION_ADMIN_WRITER_COPY.OUT_OF_PROVINCE;
}

/** Thrown inside a rule writer's transaction to roll it back with copy. */
export class RuleWriteRefused extends Error {}

/**
 * A rule writer's own, deliberate es-AR message (a duplicate rule, an invalid
 * payload). The ONLY error text besides RuleWriteRefused that reaches the UI
 * verbatim — anything else is logged and read as one generic sentence
 * (Phase-4 review LOW-2).
 */
export class RuleWriterError extends Error {}

export const RULE_NOT_FOUND = "Regla no encontrada";
export const RULE_WRITE_FAILED = "No se pudo guardar el cambio de la regla. Probá de nuevo.";

/**
 * The refusal for a rule id that matches no row. NO ORACLE (Phase-4 review
 * LOW-1): only the platform admin learns that the rule does not exist; an
 * actor without authority reads NO_AUTHORITY, and a jurisdiction admin reads
 * OUT_OF_PROVINCE — the same sentence a rule of another province gets.
 */
export async function missingRuleRefusal(
  exec: AuthorityExecutor,
  actorUserId: string,
): Promise<string> {
  if (await requirePlatformAdmin(exec, actorUserId)) return RULE_NOT_FOUND;
  if (!(await hasAdminAuthority(exec, actorUserId))) {
    return JURISDICTION_ADMIN_WRITER_COPY.NO_AUTHORITY;
  }
  return JURISDICTION_ADMIN_WRITER_COPY.OUT_OF_PROVINCE;
}

/** ruleWriteRefusal as a throw: rolls the writer's transaction back with copy. */
export async function assertRuleWritable(
  exec: AuthorityExecutor,
  actorUserId: string,
  place: RulePlaceColumns,
): Promise<void> {
  const refusal = await ruleWriteRefusal(exec, actorUserId, place);
  if (refusal) throw new RuleWriteRefused(refusal);
}

/**
 * What a rule writer returns for a failure: a database refusal of a
 * jurisdiction-admin act in es-AR (never the raw trigger text), a writer's
 * own deliberate message, else ONE generic sentence — a Postgres error, a
 * driver error or a bug is logged server-side and never shown raw (Phase-4
 * review LOW-2: its text can carry SQL, constraint names and row values).
 */
export function ruleWriterErrorMessage(err: unknown): string {
  const refusal = jurisdictionAdminRefusal(err);
  if (refusal) return JURISDICTION_ADMIN_REFUSAL_COPY[refusal];
  if (err instanceof RuleWriteRefused || err instanceof RuleWriterError) return err.message;
  console.error(
    pgError(err) ? "business rule writer: database error" : "business rule writer failed",
    err,
  );
  return RULE_WRITE_FAILED;
}

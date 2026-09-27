// The database's refusals of a jurisdiction-admin act, as codes the app can
// branch on and copy an operator can read (migrations 0268/0269/0270).
//
// Shared infrastructure (lib/, not a module): the organizations writers and
// the pets module's govt self-deactivation both translate these refusals, and
// module-to-module imports are fenced (lint:deps).
//
// Every trigger message starts with a token (`jurisdiction_admin_*`,
// `audit_province_mismatch`), and the two uniqueness walls are named partial
// indexes. Nothing here decides anything: it only TRANSLATES a refusal the
// database already made, so a raw trigger text never reaches the UI (security
// review L5) and an unknown error stays unknown (null) rather than being
// guessed into a friendlier one.

import { pgError } from "@/lib/infra/db-errors";
import type { JurisdictionAdminRefusal } from "@/lib/ui/jurisdiction-admin-copy";

export type { JurisdictionAdminRefusal };

// Longest tokens first is not needed: no token is a prefix of another.
const MESSAGE_TOKENS: ReadonlyArray<readonly [string, JurisdictionAdminRefusal]> = [
  ["jurisdiction_admin_platform_only", "PLATFORM_ONLY"],
  ["jurisdiction_admin_no_authority", "NO_AUTHORITY"],
  ["jurisdiction_admin_out_of_province", "OUT_OF_PROVINCE"],
  ["jurisdiction_admin_country_wide", "COUNTRY_WIDE"],
  ["jurisdiction_admin_implied_grant_active", "IMPLIED_GRANT_ACTIVE"],
  ["jurisdiction_admin_appointee_invalid", "APPOINTEE_INVALID"],
  ["jurisdiction_admin_grant_invalid", "GRANT_INVALID"],
  ["jurisdiction_admin_foreign_grant", "FOREIGN_GRANT"],
  ["jurisdiction_admin_append_only", "APPEND_ONLY"],
  ["audit_province_mismatch", "AUDIT_PROVINCE_MISMATCH"],
];

const UNIQUE_INDEXES: Readonly<Record<string, JurisdictionAdminRefusal>> = {
  jurisdiction_admin_appointments_one_active_per_province: "PROVINCE_TAKEN",
  jurisdiction_admin_appointments_one_active_per_user: "USER_ALREADY_APPOINTED",
};

/** The refusal `err` carries, or null when it is not one of ours. */
export function jurisdictionAdminRefusal(err: unknown): JurisdictionAdminRefusal | null {
  const pg = pgError(err);
  if (!pg) return null;
  if (pg.code === "23505" && pg.constraint && UNIQUE_INDEXES[pg.constraint]) {
    return UNIQUE_INDEXES[pg.constraint];
  }
  const message = pg.message ?? "";
  for (const [token, refusal] of MESSAGE_TOKENS) {
    if (message.startsWith(token)) return refusal;
  }
  return null;
}

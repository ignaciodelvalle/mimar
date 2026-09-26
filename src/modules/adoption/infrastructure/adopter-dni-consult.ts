// The adopter DNI oracle — ONE door, both guards inside it.
//
// "Does this DNI hold a miMAR account, and whose?" is an oracle over the DNI
// space. The PO kept it (confirming an adopter at the counter is the
// legitimate use, D4 2026-08-23) on two conditions: a per-organization
// ceiling (ADOPTER_DNI_CHECK_LIMITS) taken BEFORE the read, and a hashed
// pii_queried trail written AFTER it, found or not.
//
// Those guards used to live at each caller. The confirmation action and the
// contract route carried them; the finalize use case did not — a third,
// unmetered, unlogged door (security review, 2026-09-26). So the guards moved
// here and the raw lookup is NOT exported: every caller consults through
// consultAdopterAccountByDni, and a new caller cannot forget either guard.
// __tests__/adopter-dni-consult.test.ts fences that no other source names a
// DNI-keyed lookup.
//
// A refusal is not logged: rate_limit_buckets keeps counting past the limit,
// so the size of a sweep is already durable evidence, while logging every
// refusal would hand an attacker unbounded writes into audit_log.

import { sql } from "drizzle-orm";

import { db } from "@/db";
import { RateLimitError, enforceRateLimit } from "@/lib/infra/rate-limit";
import { hashDni } from "@/lib/utils/dni-hash";
import { logPiiQueryForAuthority } from "@/src/modules/organizations/application/admin-proposals/log-pii-query";

import { ADOPTER_DNI_CHECK_LIMITS } from "../domain/dni-check-policy";

export type AdopterAccount = {
  id: string;
  displayName: string;
  dniVerified: boolean;
  hasAuthAccount: boolean;
};

/**
 * The profile whose dniHash matches, with whether an auth.users row EXISTS
 * (a real registered account). `dniVerified` is intentionally NOT part of the
 * match contract (a walk-in adopter who registers on the spot has
 * dniVerified=false and must still match). `hasAuthAccount` is a raw-SQL
 * EXISTS because legacy stub profiles have NO auth row and no schema flag
 * distinguishes them. Callers MUST refuse when hasAuthAccount=false.
 *
 * Private on purpose — see the header.
 */
async function lookupAdopterByDni(dni: string): Promise<AdopterAccount | null> {
  const rows = await db.execute<{
    id: string;
    display_name: string;
    dni_verified: boolean;
    has_auth_account: boolean;
  }>(sql`
    SELECT p.id::text AS id,
           p.display_name AS display_name,
           p.dni_verified AS dni_verified,
           EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id) AS has_auth_account
    FROM profiles p
    WHERE p.dni_hash = ${hashDni(dni)}
    LIMIT 1
  `);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    displayName: row.display_name,
    dniVerified: row.dni_verified,
    hasAuthAccount: row.has_auth_account,
  };
}

/**
 * Consult the DNI space on behalf of `organizationId` (the ceiling's key — the
 * capability is the organization's, and a sweep from three staff accounts of
 * one shelter is one sweep), by `actorUserId` (the trail's actor).
 * "too_many" = over the ceiling; the read never ran.
 */
export async function consultAdopterAccountByDni(
  organizationId: string,
  actorUserId: string,
  dni: string,
): Promise<AdopterAccount | null | "too_many"> {
  try {
    await enforceRateLimit("adopter_dni_check", organizationId, ADOPTER_DNI_CHECK_LIMITS);
  } catch (err) {
    if (err instanceof RateLimitError) return "too_many";
    throw err;
  }
  const account = await lookupAdopterByDni(dni);
  // Awaited: the row is durable before the answer leaves the server. The DNI
  // travels HASHED (invariant 5), and a miss is logged like a hit — both
  // answers to "does this person exist" are the disclosure.
  await logPiiQueryForAuthority(
    actorUserId,
    hashDni(dni),
    account?.hasAuthAccount ? 1 : 0,
    "adopter_dni_check",
    { organization_id: organizationId },
  );
  return account;
}

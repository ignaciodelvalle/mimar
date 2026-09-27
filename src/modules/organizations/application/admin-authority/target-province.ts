// Where the TARGET of an administrative act lies (jurisdiction-admin design,
// "Target resolvers"). Every delegated writer asks one of these for the
// province it then hands to requireJurisdictionAdminFor — the province comes
// from the row being acted on (a unit, a rule, a funcionario's grants, a
// resolved catalogue place), never from what the caller typed.
//
// Executor-first, so a writer reads the target in its own transaction, next
// to the authority it checks.

import { sql } from "drizzle-orm";

import type { AuthorityExecutor } from "./authority";

/**
 * The provinces a govt funcionario's ACTIVE grants cover, and whether they
 * hold an active jurisdiction-admin appointment. Only `single` names a place
 * a jurisdiction admin may act in; `none` (no active grant) and `mixed`
 * (grants in two provinces) are platform-only targets.
 */
export type GovtTargetProvince =
  | { kind: "single"; provinceCode: string; isAppointee: boolean }
  | { kind: "none"; isAppointee: boolean }
  | { kind: "mixed"; isAppointee: boolean };

export async function govtTargetProvince(
  exec: AuthorityExecutor,
  userId: string,
): Promise<GovtTargetProvince> {
  const rows = (await exec.execute(sql`
    select coalesce(array_agg(distinct public.ar_province_code(g.jurisdiction_province))
                      filter (where public.ar_province_code(g.jurisdiction_province) is not null),
                    array[]::text[]) as codes,
           exists (select 1 from public.jurisdiction_admin_appointments a
                    where a.user_id = ${userId}::uuid and a.revoked_at is null) as appointee
      from public.govt_assignments g
     where g.user_id = ${userId}::uuid and g.revoked_at is null`)) as unknown as Array<{
    codes: string[];
    appointee: boolean;
  }>;
  const codes = rows[0]?.codes ?? [];
  const isAppointee = rows[0]?.appointee === true;
  if (codes.length === 1) return { kind: "single", provinceCode: codes[0], isAppointee };
  if (codes.length === 0) return { kind: "none", isAppointee };
  return { kind: "mixed", isAppointee };
}

/** The province code of a single-province target, or null (platform only). */
export function singleProvince(target: GovtTargetProvince): string | null {
  return target.kind === "single" ? target.provinceCode : null;
}

/**
 * The provinces a business rule's place names, through the database's own
 * definition (public.govt_business_rule_place_codes, 0269) — the one the rule
 * guard trigger uses, so the app and the database never disagree about where
 * a rule applies. Empty = country-wide (or a foreign country): platform only.
 */
export async function provincesOfRulePlace(
  exec: AuthorityExecutor,
  place: {
    jurisdictionCountry: string;
    jurisdictionProvince: string | null;
    authorityUnitId: string | null;
    localityId: string | null;
  },
): Promise<string[]> {
  // A rule outside Argentina has no province of ours: never delegated.
  if (place.jurisdictionCountry !== "AR") return [];
  const rows = (await exec.execute(sql`
    select public.govt_business_rule_place_codes(
      ${place.authorityUnitId}::uuid,
      ${place.localityId}::uuid,
      ${place.jurisdictionProvince}::text) as codes`)) as unknown as Array<{ codes: string[] }>;
  return rows[0]?.codes ?? [];
}

/**
 * The single province a set of resolved catalogue province NAMES lies in, or
 * null when there is none or more than one (both platform-only).
 */
export async function provinceOfProvinceNames(
  exec: AuthorityExecutor,
  provinceNames: readonly string[],
): Promise<string | null> {
  const codes = new Set<string | null>();
  for (const name of new Set(provinceNames)) {
    const rows = (await exec.execute(
      sql`select public.ar_province_code(${name}::text) as code`,
    )) as unknown as Array<{ code: string | null }>;
    codes.add(rows[0]?.code ?? null);
  }
  if (codes.size !== 1) return null;
  const [only] = codes;
  return only ?? null;
}

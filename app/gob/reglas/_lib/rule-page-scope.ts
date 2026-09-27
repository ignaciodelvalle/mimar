// Who may open the rule editor pages, and for which places (jurisdiction-admin
// Phase 6).
//
// The platform admin opens every jurisdiction. A govt with a LIVE
// jurisdiction-admin appointment opens only places of their own province; any
// other place answers 404 — the same as a place that does not exist, so the
// page is no oracle. Everyone else is sent home by the guard.
//
// This is the PAGE's narrowing only. Every rule writer re-derives the rule's
// province from the server-resolved place (create) or the stored row
// (update/delete) and refuses a country-wide or foreign-province rule inside
// its own transaction, whatever these pages render.

import { notFound } from "next/navigation";

import { requireAdministrationPrincipalOrRedirect } from "@/lib/infra/auth-guards";
import { provinceByName } from "@/lib/reference/ar-provincias";

/** `null` = every jurisdiction (the platform admin). */
export type RulePageScope = { provinceCode: string | null };

export async function requireRulePageScopeOrRedirect(): Promise<RulePageScope> {
  const { authority } = await requireAdministrationPrincipalOrRedirect();
  return { provinceCode: authority.kind === "jurisdiction" ? authority.provinceCode : null };
}

/** 404 unless the named place lies in the scope's province. */
export function assertPlaceInScope(
  scope: RulePageScope,
  country: string,
  provinceName: string | null,
): void {
  if (scope.provinceCode === null) return;
  if (country !== "AR" || provinceByName(provinceName)?.code !== scope.provinceCode) notFound();
}

/** 404 unless every province a stored rule's place names is the scope's own. */
export function assertRuleProvincesInScope(scope: RulePageScope, provinceCodes: string[]): void {
  if (scope.provinceCode === null) return;
  const own = scope.provinceCode;
  if (provinceCodes.length === 0 || provinceCodes.some((c) => c !== own)) notFound();
}

// lib/ui/scope-chrome.ts — C3 (ONE VIEWSCOPE, plan-maestro-integridad §C3).
//
// The ONE legitimate place a shared, session-wide chrome surface (a portal
// layout, a topbar scope chip) may turn an operator's jurisdiction assignments
// into words. A layout renders once per navigation and has NO access to a
// page's own searchParams/filter state — so it can only ever describe the
// operator's MANDATE (what they are ASSIGNED to), never the VIEW (what a
// specific page's filter currently shows). Conflating the two produced the
// verified S3 symptom: the /gob layout badge read "1774 LOCALIDADES" (a raw
// `jurisdictions.length`) while the page itself was filtered down to CABA — a
// minister reading that badge would attribute CABA-only numbers to a
// nationwide mandate.
//
// The fix is NOT to make the count smaller — it is to stop the shared chrome
// from claiming a NUMBER as if it were the view at all. `describeMandate`
// renders the operator's assignment scope in the same honest register every
// time; a page whose ACTIVE FILTER narrows below that mandate is responsible
// for its OWN "Vista: …" disclosure (see lib/ui/view-scope-caption.ts),
// derived from the resolved ProjectionContext the page already computed.
//
// Fenced: scripts/check-view-scope.ts (lint:view-scope) forbids the shared
// portal layouts from reading `jurisdictions.length` directly — this module is
// the sole allowlisted computation site.

import { isWholeProvinceAssignment } from "@/lib/domain/jurisdiction-canonical";
import { pluralizeEs } from "@/lib/utils/format";

export type MandateJurisdiction = { province: string; locality: string };

/**
 * Describe a GOVT operator's MANDATE — the jurisdiction(s) their account is
 * assigned to — as an honest es-AR fragment (no role prefix; callers already
 * render "GOB"/"SUPERADMIN" as a separate chip code). NEVER call this for an
 * admin: admin's mandate is universal ("Nacional"), not a jurisdiction list —
 * callers branch on `role === "admin"` before reaching this function.
 *
 * Cases (mirrors the plan's examples exactly):
 *  - no assignments            → "Sin localidades asignadas"
 *  - one WHOLE-PROVINCE assignment → the bare province name ("CABA") — never a
 *    locality-shaped label, since the assignment already covers the whole
 *    province at census grain (isWholeProvinceLocality / the generic
 *    locality === "" form both count — mirrors isSubProvincialScope's own
 *    subsumption so the wording and the query semantics never disagree).
 *  - one SPECIFIC locality      → "{locality}, {province}"
 *  - multiple, all one province → "{N} localidades · {province}"
 *  - multiple, several provinces → "{N} localidades · {M} provincias"
 */
export function describeMandate(jurisdictions: readonly MandateJurisdiction[]): string {
  if (jurisdictions.length === 0) return "Sin localidades asignadas";

  if (jurisdictions.length === 1) {
    const [j] = jurisdictions;
    if (isWholeProvinceAssignment(j)) return j.province;
    return `${j.locality}, ${j.province}`;
  }

  const provinces = [...new Set(jurisdictions.map((j) => j.province))];
  const localidadesWord = pluralizeEs(jurisdictions.length, "localidad");
  if (provinces.length === 1) {
    return `${jurisdictions.length} ${localidadesWord} · ${provinces[0]}`;
  }
  return `${jurisdictions.length} ${localidadesWord} · ${provinces.length} provincias`;
}

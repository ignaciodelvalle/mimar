import { hasNationalReadScope } from "@/lib/domain/jurisdiction-canonical";
import type { AdminOrGovtJurisdiction } from "@/lib/infra/auth-guards";

/**
 * Concise es-AR scope label for the panorama masthead + footer, derived from the
 * operator's assigned jurisdictions.
 *
 * SHARED between /gob/panorama and /admin/panorama: both routes admit a govt-role
 * session (an admin may view /gob; a govt operator may reach /admin/panorama — the
 * Q12 designed-for case), so both must render the SAME honest scope string. It was
 * previously inlined only in the gob page, which let /admin keep a hardcoded
 * "Nacional · todas las provincias" that lied for a bounded govt operator landing
 * there (Cursor QA 2026-07-16). One source of truth prevents that drift.
 *
 * Admin (universal) or a zero-jurisdiction account → national. A bounded operator
 * → their real jurisdiction(s).
 *
 * Past the enumeration threshold the label states the COUNT, never the bare
 * province. Collapsing "5 CABA barrios" to "CABA" reads as the whole province —
 * and the map deliberately paints the whole province as context while the data
 * stays scoped (PRESENTATION-ONLY, see app/gob/panorama/page.tsx), so a bare
 * province label is the one thing standing between the operator and believing
 * they see all of it. QA ronda 5 (2026-07-16): a 5-barrio operator saw ~48
 * comunas coloured under a label reading "CABA" and a Registros tab returning 5
 * rows, and could not tell which surface to trust. Same idiom as the
 * multi-province branch below ("4 provincias").
 */
export function panoramaScopeLabel(role: string, jurisdictions: AdminOrGovtJurisdiction[]): string {
  if (hasNationalReadScope(role) || jurisdictions.length === 0) {
    return "Nacional · todas las provincias";
  }
  const provinces = [...new Set(jurisdictions.map((j) => j.province))];
  if (provinces.length === 1) {
    const localities = [...new Set(jurisdictions.map((j) => j.locality))];
    if (localities.length <= 2) return `${provinces[0]} · ${localities.join(", ")}`;
    return `${provinces[0]} · ${localities.length} localidades`;
  }
  return provinces.length <= 3 ? provinces.join(", ") : `${provinces.length} provincias`;
}

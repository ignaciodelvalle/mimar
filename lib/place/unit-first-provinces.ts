// The provinces whose govt grants are meant to live on authority units
// (localidades CABA + Córdoba, 2026-10, PO decision 2026-10-02).
//
// Grants are born legacy — matched by their (province, locality) NAME pair —
// and are confirmed onto a unit in a second step (/admin/localidades). In these
// two provinces a grant left on its name is a gap: in Córdoba seven pairs of
// towns share a name (San Pedro, San Vicente, La Puerta, …), so a legacy grant
// on one of them sees both. Elsewhere the name path stays the accepted state
// until that province gets the same treatment.
//
// Read by the account-creation nudge (components/institutional/
// UnitAssignmentNudge.tsx) and the read-only legacy-grant check
// (scripts/place-legacy-grants.ts), so both name the same provinces.

import { provinceByCode, provinceByName } from "@/lib/reference/ar-provincias";

export const UNIT_FIRST_PROVINCE_CODES = ["AR-C", "AR-X"] as const;

/** The ISO code when `province` (a name or a code) is a unit-first province, else null. */
export function unitFirstProvinceCode(province: string | null | undefined): string | null {
  const code = (provinceByCode(province) ?? provinceByName(province))?.code ?? null;
  return code !== null && (UNIT_FIRST_PROVINCE_CODES as readonly string[]).includes(code)
    ? code
    : null;
}

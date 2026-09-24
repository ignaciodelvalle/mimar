// Argentine provinces + CABA. ISO 3166-2:AR codes are the canonical identifier;
// names and slugs are for display and routing. The 24 entries match the
// authoritative ISO list (https://en.wikipedia.org/wiki/ISO_3166-2:AR).
//
// Why codes: free-text province names ("CABA" / "Ciudad Autónoma de Buenos
// Aires" / "C.A.B.A.") would all aggregate as separate keys and silently
// break k-anonymity rollups (AGENTS.md → Aggregation & privacy policy).
// Stable codes solve that at the data layer. `provinceByName` is the
// alias-tolerant import-time resolver — useful when we migrate existing
// rows or accept free-text input from older form posts.
//
// The legacy `PROVINCIAS` export (flat `readonly string[]` of names) is
// preserved as a derived alias so the existing form call sites
// (PetForm.tsx, WelfareReportForm.tsx) keep compiling unchanged. They
// migrate to consume `PROVINCES` directly when PR D refactors them through
// the shared `<LocationFields>` component.

// THE LIST ITSELF LIVES IN `@dim/contract/reference` (L3·0 of the locality
// plan, 2026-09-08): the native locality picker asks for the province first, so
// the phone needs the same 24 rows offline. Re-exported rather than copied, the
// way the breed catalogs moved — one list, every consumer.
import { PROVINCES, type ReferenceProvince } from "@dim/contract/reference";

export { PROVINCES };

export type Province = ReferenceProvince;

export type ProvinceCode = (typeof PROVINCES)[number]["code"];

// Common informal abbreviations and formal phrasings that won't match a
// province name even after normalization. Hoisted to module scope so the
// object isn't reconstructed on every provinceByName call.
const ALIAS_TO_CODE: Record<string, ProvinceCode> = {
  // CABA variants
  cabba: "AR-C", // common typo
  capital: "AR-C",
  "capital federal": "AR-C",
  "ciudad autonoma de buenos aires": "AR-C",
  "ciudad de buenos aires": "AR-C",
  // Buenos Aires (provincia) variants
  "bs as": "AR-B", // common Argentine postal/journalistic abbreviation
  "bs aires": "AR-B",
  "provincia de buenos aires": "AR-B",
};

/**
 * Look up a province by its ISO 3166-2:AR code (e.g. "AR-C").
 * Returns `null` for unknown codes.
 */
export function provinceByCode(code: string | null | undefined): Province | null {
  if (!code) return null;
  return PROVINCES.find((p) => p.code === code) ?? null;
}

/**
 * Look up a province by display name with tolerance for whitespace, case,
 * diacritics, and common aliases (especially for CABA). Returns `null` for
 * unknown names. Use this when normalizing user input or existing free-text
 * rows during migration.
 *
 * Examples:
 *   provinceByName("CABA")                              → AR-C
 *   provinceByName("C.A.B.A.")                          → AR-C
 *   provinceByName("Ciudad Autónoma de Buenos Aires")   → AR-C
 *   provinceByName("Capital Federal")                   → AR-C
 *   provinceByName("cordoba")                           → AR-X
 *   provinceByName("Tucuman")                           → AR-T
 *   provinceByName("Río Negro")                         → AR-R
 *   provinceByName("rio negro")                         → AR-R
 *   provinceByName("Patagonia")                         → null
 */
export function provinceByName(name: string | null | undefined): Province | null {
  if (!name) return null;
  const normalized = normalize(name);
  if (!normalized) return null;

  const aliased = ALIAS_TO_CODE[normalized];
  if (aliased) return provinceByCode(aliased);

  // Match against normalized province names + slugs.
  for (const p of PROVINCES) {
    if (normalize(p.name) === normalized) return p;
    if (p.slug === normalized) return p;
  }
  return null;
}

/**
 * Normalize a string for case-insensitive, diacritic-insensitive lookup.
 * Trim, casefold, NFD-decompose, strip combining marks via the Unicode
 * Mark property `\p{M}` (requires the `u` flag), collapse internal
 * whitespace, and remove dots (so "C.A.B.A." normalizes to "caba").
 */
function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

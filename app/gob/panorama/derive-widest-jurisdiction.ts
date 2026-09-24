// Pure widest-jurisdiction decision helpers for the /gob/panorama page.
//
// Extracted out of page.tsx (rather than exported from it) because a Next.js
// `page.tsx` may only export the framework's own reserved names (`default`,
// `metadata`, `dynamic`, ...) — the generated route type-check
// (`.next/types/app/gob/panorama/page.ts`) hard-fails on any other named
// export. Living here makes both helpers importable AND unit-testable
// without pulling in the page's route-export constraints.

import { isWholeProvinceLocality } from "@/lib/domain/jurisdiction-canonical";
import type { AdminOrGovtJurisdiction } from "@/lib/infra/auth-guards";
import { provinceByName } from "@/lib/reference/ar-provincias";

/**
 * BUG FIX (widest-jurisdiction default): derive the operator's WIDEST jurisdiction
 * so the initial view defaults to it instead of the whole country.
 *
 * Robust by construction: province names are resolved with the ALIAS-TOLERANT
 * `provinceByName` (NOT the alias-fragile PROVINCE_ISO_MAP, which lacks the CABA
 * long-form key and would silently empty the set — dropping even a single-province
 * operator to national). Whole-province markers subsume their localities, so a
 * whole-CABA assignment seeds the province, never a spurious locality.
 *
 * Returns:
 *  - `{ provinceCode: null }` — 0 jurisdictions (admin/universal) OR the scope
 *    genuinely spans >1 province → national default.
 *  - `{ provinceCode, localityName: null }` — exactly 1 province, but a
 *    whole-province marker or multiple distinct localities → seed the province.
 *  - `{ provinceCode, localityName }` — exactly 1 province and exactly 1 specific
 *    locality → seed province + locality.
 *
 * PURE — only in-memory lookups (provinceByName, isWholeProvinceLocality), no
 * DB, no network. Unit-tested directly in `__tests__/derive-widest-jurisdiction.test.ts`.
 */
export function deriveWidestJurisdiction(jurisdictions: AdminOrGovtJurisdiction[]): {
  provinceCode: string | null;
  localityName: string | null;
} {
  const provinceCodes = new Set<string>();
  for (const j of jurisdictions) {
    const code = provinceByName(j.province)?.code;
    if (code) provinceCodes.add(code);
  }
  if (provinceCodes.size !== 1) return { provinceCode: null, localityName: null };
  const [provinceCode] = [...provinceCodes];

  // A whole-province assignment governs the entire province → seed the province,
  // never a locality (it subsumes every locality/barrio within it).
  const hasWholeProvince = jurisdictions.some((j) =>
    isWholeProvinceLocality(j.province, j.locality),
  );
  const specificLocalities = new Set(
    jurisdictions
      .filter((j) => j.locality && !isWholeProvinceLocality(j.province, j.locality))
      .map((j) => j.locality),
  );
  if (!hasWholeProvince && specificLocalities.size === 1) {
    return { provinceCode, localityName: [...specificLocalities][0] };
  }
  return { provinceCode, localityName: null };
}

/**
 * G1 (out-of-scope bounce): is the requested province within a GOVT operator's
 * jurisdiction? Compares by ISO code via the ALIAS-TOLERANT `provinceByName` so a
 * stored alias-form province name can never spuriously read as out-of-scope.
 *
 * GOVT-ONLY: admin scope is universal (every province valid) and MUST be checked
 * by the caller before calling this. PURE — in-memory lookups only, unit-tested
 * in `__tests__/derive-widest-jurisdiction.test.ts`.
 */
export function isProvinceInGovtScope(
  jurisdictions: AdminOrGovtJurisdiction[],
  provinceCode: string,
): boolean {
  return jurisdictions.some((j) => provinceByName(j.province)?.code === provinceCode);
}

/**
 * Resolve the `initialDivisionLocality` seed slug from the DB lookup of
 * `widest.localityName` (see `localityByName` at the page's call site) — kept
 * as a thin, pure wrapper so the GRACEFUL fallback is unit-testable without a DB.
 *
 * GRACEFUL: a locality name that doesn't resolve to a known slug (a stale or
 * mistyped govt_assignments row — `localityByName` returns `null`) falls back
 * to `undefined` (province-level seed only), never a crash and never an
 * `undefined`-flavored slug string reaching the console.
 */
export function resolveSeedLocalitySlug(
  seedLocalityRow: { localitySlug: string } | null,
): string | undefined {
  return seedLocalityRow?.localitySlug ?? undefined;
}

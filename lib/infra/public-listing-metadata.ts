// Shared title-location resolution for the /perdidas and /adoptar public
// listings' generateMetadata (audit A03-G11, 2026-09).
//
// Both pages used to interpolate the raw, unvalidated `provincia`/`localidad`
// query params straight into the <title> — no catalog check, no length cap
// (contrast the `visto` bucket filter, validated against LOST_TIME_BUCKETS).
// Not XSS: React escapes the <title> text node. The residue is search-result
// title poisoning / index pollution — `GET /perdidas?localidad=<attacker
// copy>` yields an indexable page (robots.ts allows the whole tree on
// purpose) with an attacker-chosen title, and nothing collapsed the parameter
// space back onto the canonical page.
//
// The fix has two parts:
//   1. Only a province/locality that RESOLVES against the real catalog earns
//      a place in the title — an unresolvable pair renders no location bit
//      at all, same as if the params were absent.
//   2. Both pages carry `alternates.canonical` pointing at their bare path,
//      so every filtered variant collapses onto the one indexable URL.
//
// Locality resolution is DB-backed (ar_localities has no static export, same
// reason `lib/infra/jurisdiction-validation.ts` is async) — acceptable here
// because generateMetadata already runs server-side per request, same as the
// page body's own DB reads.

import { type Locality, localityByName } from "@/lib/infra/ar-localidades";
import { provinceByName } from "@/lib/reference/ar-provincias";

export type CanonicalTitleLocation = {
  /** Canonical province display name, or null when unresolved/absent. */
  province: string | null;
  /** Canonical locality display name, or null when unresolved/absent. */
  locality: string | null;
};

export async function resolveCanonicalTitleLocation(input: {
  rawProvince?: string;
  rawLocality?: string;
}): Promise<CanonicalTitleLocation> {
  const province = provinceByName(input.rawProvince);
  if (!province) return { province: null, locality: null };

  const locality = input.rawLocality
    ? await localityByName(province.code as Locality["provinceCode"], input.rawLocality)
    : null;

  return {
    province: province.name,
    locality: locality ? locality.localityName : null,
  };
}

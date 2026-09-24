// Canonical jurisdiction resolution for server actions that persist
// (province, locality) text pairs.
//
// Resolves a free-text (province, locality) input into the catalog's
// canonical display names — or throws a JurisdictionValidationError with a
// human-readable message when the input doesn't match.
//
// Anchors against:
//   - lib/ar-provincias.ts → provinceByCode / provinceByName (tolerates
//     ISO 3166-2:AR code, full name, or common aliases like "CABA")
//   - lib/ar-localidades.ts → localityByName (slug-first then case-insensitive)
//
// Callers that already have the canonical INDEC id (from LocalityCombobox)
// should prefer `resolveCanonicalJurisdictionById` for a single-query path
// that skips the name-based fallback.

import { type Locality, localityByIndecId, localityByName } from "@/lib/infra/ar-localidades";
import { type Province, provinceByCode, provinceByName } from "@/lib/reference/ar-provincias";

export type CanonicalJurisdiction = {
  province: Province;
  locality: Locality;
};

export class JurisdictionValidationError extends Error {
  readonly code: "INVALID_PROVINCE" | "INVALID_LOCALITY";
  constructor(code: "INVALID_PROVINCE" | "INVALID_LOCALITY", message: string) {
    super(message);
    this.name = "JurisdictionValidationError";
    this.code = code;
  }
}

export async function resolveCanonicalJurisdiction(input: {
  rawProvince: string;
  rawLocality: string;
}): Promise<CanonicalJurisdiction> {
  const province = provinceByCode(input.rawProvince) ?? provinceByName(input.rawProvince);
  if (!province) {
    throw new JurisdictionValidationError(
      "INVALID_PROVINCE",
      `Provincia '${input.rawProvince}' no es válida.`,
    );
  }
  const locality = await localityByName(
    province.code as Locality["provinceCode"],
    input.rawLocality,
  );
  if (!locality) {
    throw new JurisdictionValidationError(
      "INVALID_LOCALITY",
      `Localidad '${input.rawLocality}' no figura en el catálogo INDEC para ${province.name}.`,
    );
  }
  return { province, locality };
}

export async function resolveCanonicalJurisdictionById(input: {
  indecId: string;
}): Promise<CanonicalJurisdiction> {
  const locality = await localityByIndecId(input.indecId);
  if (!locality) {
    throw new JurisdictionValidationError(
      "INVALID_LOCALITY",
      `INDEC id '${input.indecId}' no encontrado en el catálogo.`,
    );
  }
  const province = provinceByCode(locality.provinceCode);
  if (!province) {
    // Should never happen if the catalog and provincias list stay in sync.
    throw new JurisdictionValidationError(
      "INVALID_PROVINCE",
      `Provincia '${locality.provinceCode}' no figura en el catálogo de provincias.`,
    );
  }
  return { province, locality };
}

// Soft variant — returns canonical names when the input resolves cleanly,
// otherwise falls back to trimmed input as-is.
//
// NOTE: Most server-side callers have been migrated to `resolveCanonicalJurisdiction`
// (the strict path). `tryResolveCanonicalJurisdiction` is kept for callers where
// the locality is genuinely optional (e.g. service-offerings, which may have no
// operational scope set yet), or as a documented exception with a narrowly-scoped
// tolerant path. Do NOT use it as a shortcut for new actions.
//
// Strict callers (admin-side `createInstitutionalAccountForAuthority` and
// `assignGovtLocalityForAuthority`) keep using `resolveCanonicalJurisdiction`
// directly so a govt assignment can never land off-catalog.
export async function tryResolveCanonicalJurisdiction(input: {
  rawProvince: string;
  rawLocality: string;
}): Promise<{
  province: string;
  locality: string;
  canonical: boolean;
  /** ar_localities uuid PK when the pair resolved, else null. Structural
   * locality-attribution FK value (migration 0147). */
  localityId: string | null;
}> {
  const rawProvince = input.rawProvince.trim();
  const rawLocality = input.rawLocality.trim();
  if (!rawProvince || !rawLocality) {
    return { province: rawProvince, locality: rawLocality, canonical: false, localityId: null };
  }
  try {
    const resolved = await resolveCanonicalJurisdiction({ rawProvince, rawLocality });
    return {
      province: resolved.province.name,
      locality: resolved.locality.localityName,
      canonical: true,
      localityId: resolved.locality.id,
    };
  } catch {
    return { province: rawProvince, locality: rawLocality, canonical: false, localityId: null };
  }
}

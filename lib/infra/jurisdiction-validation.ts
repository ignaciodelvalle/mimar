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

import type { NamePlaceMethod } from "@/lib/domain/place";
import {
  type Locality,
  localitiesByName,
  localityByIndecId,
  localityByName,
} from "@/lib/infra/ar-localidades";
import { type Province, provinceByCode, provinceByName } from "@/lib/reference/ar-provincias";

export type CanonicalJurisdiction = {
  province: Province;
  locality: Locality;
};

/**
 * - INVALID_PROVINCE: the province names no province.
 * - INVALID_LOCALITY: the catalogue has no such locality there (or no such id).
 * - AMBIGUOUS_LOCALITY: the NAME names two or more catalogue rows in that
 *   province (a within-province homonym) and no id said which one.
 */
export type JurisdictionValidationCode =
  | "INVALID_PROVINCE"
  | "INVALID_LOCALITY"
  | "AMBIGUOUS_LOCALITY";

export class JurisdictionValidationError extends Error {
  readonly code: JurisdictionValidationCode;
  constructor(code: JurisdictionValidationCode, message: string) {
    super(message);
    this.name = "JurisdictionValidationError";
    this.code = code;
  }
}

/**
 * LEGACY — settles a within-province homonym by taking the alphabetically first
 * department (`localityByName`). No write path may use it: the write gate
 * (`normalizeLocationForWrite`) resolves names through
 * {@link resolveUniqueJurisdiction}. Its remaining callers are the seed
 * scripts, the geocoding route (localidades-por-id B3) and the historical
 * backfill (B5), each named in that plan.
 */
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

export type UniqueJurisdiction = CanonicalJurisdiction & {
  /** Whether the text matched the catalogue's own spelling or a folded variant. */
  method: NamePlaceMethod;
};

/**
 * Resolve a (province, locality NAME) pair ONLY when the name names exactly one
 * live catalogue row in that province (localidades-por-id A9, P1).
 *
 * @throws {JurisdictionValidationError} INVALID_PROVINCE, INVALID_LOCALITY (no
 *   row), or AMBIGUOUS_LOCALITY (two or more rows — Mechita in Alberti and in
 *   Bragado). The caller that can ask the person which one refuses; the caller
 *   that must not block a report stores the place at province level.
 */
export async function resolveUniqueJurisdiction(input: {
  rawProvince: string;
  rawLocality: string;
}): Promise<UniqueJurisdiction> {
  const province = provinceByCode(input.rawProvince) ?? provinceByName(input.rawProvince);
  if (!province) {
    throw new JurisdictionValidationError(
      "INVALID_PROVINCE",
      `Provincia '${input.rawProvince}' no es válida.`,
    );
  }
  const candidates = await localitiesByName(
    province.code as Locality["provinceCode"],
    input.rawLocality,
  );
  if (candidates.length === 0) {
    throw new JurisdictionValidationError(
      "INVALID_LOCALITY",
      `Localidad '${input.rawLocality}' no figura en el catálogo INDEC para ${province.name}.`,
    );
  }
  if (candidates.length > 1) {
    throw new JurisdictionValidationError(
      "AMBIGUOUS_LOCALITY",
      `Hay más de una localidad llamada ${candidates[0].localityName} en ${province.name}. Elegila de la lista para indicar cuál.`,
    );
  }
  const [locality] = candidates;
  return {
    province,
    locality,
    method:
      locality.localityName === input.rawLocality.trim()
        ? "exact_name_unique"
        : "folded_name_unique",
  };
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

// Soft variant — returns canonical names when the input names exactly ONE
// catalogue row, otherwise falls back to trimmed input as-is. An ambiguous name
// (a within-province homonym) is a miss here too, flagged `ambiguous: true` so
// the caller can store the place at province level instead of the raw name
// every same-named municipality's grant would match (localidades-por-id A9).
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
  /** True when the name named two or more rows in the province. */
  ambiguous: boolean;
  method: NamePlaceMethod | "unresolved";
}> {
  const rawProvince = input.rawProvince.trim();
  const rawLocality = input.rawLocality.trim();
  const miss = {
    province: rawProvince,
    locality: rawLocality,
    canonical: false,
    localityId: null,
    ambiguous: false,
    method: "unresolved" as const,
  };
  if (!rawProvince || !rawLocality) return miss;
  try {
    const resolved = await resolveUniqueJurisdiction({ rawProvince, rawLocality });
    return {
      province: resolved.province.name,
      locality: resolved.locality.localityName,
      canonical: true,
      localityId: resolved.locality.id,
      ambiguous: false,
      method: resolved.method,
    };
  } catch (err) {
    if (err instanceof JurisdictionValidationError && err.code === "AMBIGUOUS_LOCALITY") {
      // The province is real (the resolver checked it before counting rows).
      const province = provinceByCode(rawProvince) ?? provinceByName(rawProvince);
      return { ...miss, province: province?.name ?? rawProvince, ambiguous: true };
    }
    return miss;
  }
}

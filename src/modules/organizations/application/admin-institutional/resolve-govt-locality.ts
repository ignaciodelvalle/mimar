// Resolves ONE locality an admin grants to a govt operator (C2b).
//
// Both admin writers (createInstitutionalAccountForAuthority and
// assignGovtLocalityForAuthority) used to hand `normalizeLocationForWrite` a
// (province, NAME) pair with `localityIndecId: null`. The name path is
// `localityByName`, which settles a within-province homonym by taking the
// alphabetically first department — so an admin who was SHOWN Mechita (Alberti)
// and Mechita (Bragado) and tapped the second one granted the first. The picker
// already resolved the INDEC id of the row that was tapped; the forms dropped it.
//
// This is the citizen fix (A2-alta-asentar-03) applied to the grant:
//   - the INDEC id wins when the form sends one, cross-checked against the
//     claimed province (a body whose halves disagree is refused, not repaired);
//   - with no id, the name is accepted ONLY when it names exactly one live
//     catalogue row in that province. An ambiguous name is refused: guessing a
//     department on the screen that hands out authority is the defect itself.
//     Since localidades-por-id A9 the write gate itself refuses it
//     (AMBIGUOUS_LOCALITY) for every strict writer; this file keeps its own
//     wording for the admin forms.
//
// Returns the canonical names (still the display source and the scope key) plus
// the ar_localities uuid PK, which govt_assignments.locality_id records
// (migration 0246).

import {
  CoordError,
  JurisdictionValidationError,
  normalizeLocationForWrite,
} from "@/lib/domain/location-normalize";

export type ResolvedGovtLocality = {
  province: string;
  locality: string;
  /** ar_localities uuid PK of the granted row. */
  localityId: string;
};

export async function resolveGovtLocality(input: {
  province: string;
  locality: string;
  localityIndecId?: string | null;
}): Promise<ResolvedGovtLocality | { error: string }> {
  const indecId = input.localityIndecId?.trim() || null;
  let normalized: Awaited<ReturnType<typeof normalizeLocationForWrite>>;
  try {
    normalized = await normalizeLocationForWrite(
      {
        province: input.province,
        provinceCode: null,
        locality: input.locality,
        localityIndecId: indecId,
        lat: null,
        lng: null,
        address: null,
      },
      { locality: "strict" },
    );
  } catch (err) {
    if (err instanceof JurisdictionValidationError && err.code === "AMBIGUOUS_LOCALITY") {
      return {
        error: `VALIDATION_ERROR: Hay más de una localidad llamada ${input.locality.trim()} en ${input.province.trim()}. Elegila de la lista para indicar cuál.`,
      };
    }
    if (err instanceof JurisdictionValidationError) return { error: err.message };
    if (err instanceof CoordError) return { error: err.message };
    throw err;
  }

  const province = normalized.province;
  const locality = normalized.locality;
  const localityId = normalized.localityId;
  if (!province || !locality || !localityId) {
    // Strict mode only passes through when province or locality is absent;
    // the callers' schemas require both, so this is a malformed body.
    return { error: "VALIDATION_ERROR: Elegí la localidad de la lista." };
  }

  return { province, locality, localityId };
}

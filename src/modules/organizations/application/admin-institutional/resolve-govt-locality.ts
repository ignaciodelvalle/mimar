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
//
// Returns the canonical names (still the display source and the scope key) plus
// the ar_localities uuid PK, which govt_assignments.locality_id records
// (migration 0246).

import { and, count, eq, isNull } from "drizzle-orm";

import { arLocalities, db } from "@/db";
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

  if (!indecId && (await homonymCount(localityId)) > 1) {
    return {
      error: `VALIDATION_ERROR: Hay más de una localidad llamada ${locality} en ${province}. Elegila de la lista para indicar cuál.`,
    };
  }

  return { province, locality, localityId };
}

/** Live catalogue rows sharing the resolved row's (province, name). */
async function homonymCount(localityId: string): Promise<number> {
  const [row] = await db
    .select({ provinceCode: arLocalities.provinceCode, localityName: arLocalities.localityName })
    .from(arLocalities)
    .where(eq(arLocalities.id, localityId))
    .limit(1);
  if (!row) return 0;
  const [{ n }] = await db
    .select({ n: count() })
    .from(arLocalities)
    .where(
      and(
        eq(arLocalities.provinceCode, row.provinceCode),
        eq(arLocalities.localityName, row.localityName),
        isNull(arLocalities.removedAt),
      ),
    );
  return n;
}

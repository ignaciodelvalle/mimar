// normalizeJurisdiction — form-data parser for the (country, province,
// locality) triple a govt business rule is keyed on (A10-3).
//
// Why it is not trim-only any more: `resolveBusinessRule` matches a rule to a
// pet by EXACT string equality against `pets.jurisdiction_locality`, which the
// pet write paths store in the catalog's canonical spelling. The province half
// was already safe (migration 0055's CHECK), but the locality column has no
// CHECK and no catalog lookup, so "palermo" or a stale INDEC spelling persisted
// and the rule governed zero pets while `/gob/reglas` showed it as configured.
//
// The pair now goes through the same gate `createPetAction` uses
// (`normalizeLocationForWrite({ locality: "strict" })`, which delegates to
// `resolveCanonicalJurisdiction`), so the stored locality is the catalog's
// `locality_name` or the write is refused. Lives in the application module,
// not the "use server" shim, per the action line-budget fence.

import { canonicalProvinceNameForStorage } from "@/lib/domain/jurisdiction-canonical";
import {
  JurisdictionValidationError,
  normalizeLocationForWrite,
} from "@/lib/domain/location-normalize";

export type RuleJurisdiction = {
  country: string;
  province: string | null;
  locality: string | null;
};

export type NormalizeJurisdictionResult =
  | { ok: true; value: RuleJurisdiction }
  | { ok: false; error: string };

/** The form's fields, trimmed, empty → null. No catalog lookup. */
export function readJurisdictionFields(formData: FormData): RuleJurisdiction {
  const text = (name: string): string | null => {
    const raw = (formData.get(name) as string | null)?.trim();
    return raw ? raw : null;
  };
  return {
    country: text("jurisdictionCountry") ?? "AR",
    province: text("jurisdictionProvince"),
    locality: text("jurisdictionLocality"),
  };
}

/**
 * Resolves the rule's jurisdiction against the catalog.
 *
 * - No province → national rule; a locality without a province is refused
 *   (the cascade is province first, then locality).
 * - Province only → canonical province name, or refused if it is not one.
 * - Province + locality → `resolveCanonicalJurisdiction`, or refused.
 * - A non-AR country has no catalog to resolve against: passed through.
 */
export async function normalizeJurisdiction(
  formData: FormData,
): Promise<NormalizeJurisdictionResult> {
  const raw = readJurisdictionFields(formData);
  if (raw.country !== "AR") return { ok: true, value: raw };

  if (raw.province === null) {
    if (raw.locality !== null) {
      return { ok: false, error: "Elegí la provincia antes que la localidad." };
    }
    return { ok: true, value: raw };
  }

  const province = canonicalProvinceNameForStorage(raw.province);
  if (province === null) {
    return { ok: false, error: `Provincia '${raw.province}' no es válida.` };
  }
  if (raw.locality === null) {
    return { ok: true, value: { country: raw.country, province, locality: null } };
  }

  try {
    const canonical = await normalizeLocationForWrite(
      {
        province,
        provinceCode: null,
        locality: raw.locality,
        localityIndecId: null,
        lat: null,
        lng: null,
        address: null,
      },
      { locality: "strict" },
    );
    return {
      ok: true,
      value: { country: raw.country, province: canonical.province, locality: canonical.locality },
    };
  } catch (err) {
    if (err instanceof JurisdictionValidationError) return { ok: false, error: err.message };
    throw err;
  }
}

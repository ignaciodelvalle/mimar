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
//
// THE PLACE BY ID (localidades-por-id D4). A homonym (Mechita, partido Alberti
// and partido Bragado) used to be refused here: the name could not say which
// one. The wizard now sends the picked row's INDEC id
// (`jurisdictionLocalityIndecId`), which resolves exactly one row, or a
// CONFIRMED authority unit (`jurisdictionUnitId`). normalizeRuleJurisdiction
// returns that place with the names; the writer keys the rule on it.

import { and, eq } from "drizzle-orm";

import { authorityUnits, db } from "@/db";
import { canonicalProvinceNameForStorage } from "@/lib/domain/jurisdiction-canonical";
import {
  JurisdictionValidationError,
  normalizeLocationForWrite,
} from "@/lib/domain/location-normalize";
import { provinceByName } from "@/lib/reference/ar-provincias";

export type RuleJurisdiction = {
  country: string;
  province: string | null;
  locality: string | null;
};

/** Which place the rule is keyed on: a catalogue row, a unit, or neither. */
export type RulePlace = {
  localityId: string | null;
  authorityUnitId: string | null;
  placeMethod: string | null;
};

const NO_PLACE: RulePlace = { localityId: null, authorityUnitId: null, placeMethod: null };

export type NormalizeJurisdictionResult =
  | { ok: true; value: RuleJurisdiction }
  | { ok: false; error: string };

export type NormalizeRuleJurisdictionResult =
  | { ok: true; value: RuleJurisdiction; place: RulePlace }
  | { ok: false; error: string };

type Reader = Pick<typeof db, "select">;

function text(formData: FormData, name: string): string | null {
  const raw = (formData.get(name) as string | null)?.trim();
  return raw ? raw : null;
}

/** The form's fields, trimmed, empty → null. No catalog lookup. */
export function readJurisdictionFields(formData: FormData): RuleJurisdiction {
  return {
    country: text(formData, "jurisdictionCountry") ?? "AR",
    province: text(formData, "jurisdictionProvince"),
    locality: text(formData, "jurisdictionLocality"),
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
  const r = await normalizeRuleJurisdiction(formData);
  return r.ok ? { ok: true, value: r.value } : r;
}

/** A CONFIRMED unit of the province (localidades-por-id D4); never a draft. */
async function unitPlace(
  unitId: string,
  province: string,
  exec: Reader,
): Promise<NormalizeRuleJurisdictionResult | { ok: true; unitName: string | null; level: string }> {
  const code = provinceByName(province)?.code ?? null;
  const [unit] = await exec
    .select({
      id: authorityUnits.id,
      name: authorityUnits.name,
      level: authorityUnits.level,
      status: authorityUnits.status,
    })
    .from(authorityUnits)
    .where(and(eq(authorityUnits.id, unitId), eq(authorityUnits.provinceCode, code ?? "")))
    .limit(1);
  if (!unit) return { ok: false, error: "Esa unidad de autoridad no es de la provincia elegida." };
  if (unit.status !== "confirmed") {
    return {
      ok: false,
      error:
        "Esa unidad todavía no está confirmada con la autoridad; no puede tener reglas propias.",
    };
  }
  return { ok: true, unitName: unit.level === "provincial" ? null : unit.name, level: unit.level };
}

/** normalizeJurisdiction plus the place the rule is keyed on. */
export async function normalizeRuleJurisdiction(
  formData: FormData,
  exec: Reader = db,
): Promise<NormalizeRuleJurisdictionResult> {
  const raw = readJurisdictionFields(formData);
  if (raw.country !== "AR") return { ok: true, value: raw, place: NO_PLACE };

  if (raw.province === null) {
    if (raw.locality !== null) {
      return { ok: false, error: "Elegí la provincia antes que la localidad." };
    }
    return { ok: true, value: raw, place: NO_PLACE };
  }

  const province = canonicalProvinceNameForStorage(raw.province);
  if (province === null) {
    return { ok: false, error: `Provincia '${raw.province}' no es válida.` };
  }

  const unitId = text(formData, "jurisdictionUnitId");
  if (unitId) {
    const unit = await unitPlace(unitId, province, exec);
    if (!unit.ok) return unit;
    if (!("unitName" in unit)) return unit;
    return {
      ok: true,
      value: { country: raw.country, province, locality: unit.unitName },
      place: { localityId: null, authorityUnitId: unitId, placeMethod: null },
    };
  }

  if (raw.locality === null) {
    return { ok: true, value: { country: raw.country, province, locality: null }, place: NO_PLACE };
  }

  try {
    const canonical = await normalizeLocationForWrite(
      {
        province,
        provinceCode: null,
        locality: raw.locality,
        // The row the person picked: resolves a homonym exactly (P1).
        localityIndecId: text(formData, "jurisdictionLocalityIndecId"),
        lat: null,
        lng: null,
        address: null,
      },
      { locality: "strict" },
    );
    return {
      ok: true,
      value: { country: raw.country, province: canonical.province, locality: canonical.locality },
      place: canonical.localityId
        ? {
            localityId: canonical.localityId,
            authorityUnitId: null,
            placeMethod: canonical.placeMethod,
          }
        : NO_PLACE,
    };
  } catch (err) {
    if (err instanceof JurisdictionValidationError) return { ok: false, error: err.message };
    throw err;
  }
}

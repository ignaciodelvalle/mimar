// Pure form-parsing for the pets domain.
// Zero external imports — no @/db, drizzle-orm, or next imports allowed.
// Extracted from app/actions/pets.ts parsePetForm + helpers.

import { canonicalProvinceNameForStorage } from "@/lib/domain/jurisdiction-canonical";
import { parseLocationFromFormData } from "@/lib/domain/location-value";
import {
  type PermanentCondition,
  type PetAge,
  TRAINING_LEVEL_VALUES,
  type TrainingLevel,
  detectContactInfoInFreeText,
  estimatedBirthDateFromAge,
  sanitizeConditionCodes,
} from "@dim/contract/reference";
import type { ParsedPet } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type AcquisitionMethod =
  | "adopted"
  | "purchased"
  | "found_stray"
  | "gift"
  | "born_in_litter"
  | "other";

const ACQUISITION_METHODS: readonly AcquisitionMethod[] = [
  "adopted",
  "purchased",
  "found_stray",
  "gift",
  "born_in_litter",
  "other",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * PetForm submits the conditions as a CSV string. Sanitize via the
 * catalog to drop anything not currently recognized.
 */
function parsePermanentConditions(formData: FormData): PermanentCondition[] {
  const raw = String(formData.get("permanentConditions") ?? "");
  const candidates = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return sanitizeConditionCodes(candidates);
}

/**
 * Drop disclose flag if no conditions were selected. The form does this
 * in the UI (disabled checkbox) but the server needs to defend too.
 */
export function normalizeDisclose(parsed: ParsedPet): boolean {
  if (parsed.permanentConditions.length === 0) return false;
  return parsed.discloseConditionsPublicly;
}

/**
 * When 'otra' is not selected, drop the free-text field.
 */
export function normalizeConditionsOther(parsed: ParsedPet): string | null {
  if (!parsed.permanentConditions.includes("otra")) return null;
  return parsed.permanentConditionsOther;
}

// The privacy guard on "otra condición" (`detectContactInfoInFreeText`) and the
// age → birth-date arithmetic (`estimatedBirthDateFromAge`) moved to
// `@dim/contract/reference` (owner-pet-actions, 2026-10-01), unchanged, so the
// app's "Editar datos" and the v1 alta run the same rule this parser runs.

/** One age field: blank → null, a negative → 0, garbage → 0. */
function parseAgeField(formData: FormData, key: "ageYears" | "ageMonths"): number | null {
  const raw = String(formData.get(key) ?? "").trim();
  return raw ? Math.max(0, Number.parseInt(raw, 10) || 0) : null;
}

/**
 * The two age fields AS POSTED. `parsePetForm` turns them into a date; the edit
 * path also needs them raw, to ask `resolveEditedBirthDate` whether the person
 * changed the age at all or posted back the one the form showed.
 */
export function parseAgeFromFormData(formData: FormData): PetAge {
  return {
    years: parseAgeField(formData, "ageYears"),
    months: parseAgeField(formData, "ageMonths"),
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Parses raw FormData into a ParsedPet value object.
 * Returns { parsed: ParsedPet, error: null } on success,
 * or { parsed: null, error: string } on validation failure.
 *
 * NOTE: This function applies normalizeDisclose and normalizeConditionsOther
 * inline so the returned ParsedPet is already fully normalized.
 */
export function parsePetForm(
  formData: FormData,
): { parsed: ParsedPet; error: null } | { parsed: null; error: string } {
  const name = String(formData.get("name") ?? "").trim();
  const species = String(formData.get("species") ?? "").trim();
  if (!name) return { parsed: null, error: "Falta el nombre." };
  if (!species) return { parsed: null, error: "Falta la especie." };

  const loc = parseLocationFromFormData(formData);

  // Locality is required — pets must always have a jurisdiction (PO decision
  // 2026-07-08: a serious national registry needs at least the barrio/localidad
  // as epidemiological signal). Existing pets without a locality are forced to
  // set one via a movement.
  const localityNameRaw = loc.locality ?? "";
  if (!localityNameRaw) {
    return { parsed: null, error: "LOCALITY_REQUIRED" };
  }

  // The locality MUST come from the autocomplete — a real `ar_localities` row,
  // which always carries its province. A value typed by hand that never
  // resolved to a catalog result arrives with an empty province: reject it so
  // free text can never enter the registry as a locality. The strict INDEC
  // (province, locality) pair check still runs downstream in the action.
  const provinceForStorage = canonicalProvinceNameForStorage(loc.provinceCode ?? "");
  if (!provinceForStorage) {
    return { parsed: null, error: "LOCALITY_UNRESOLVED" };
  }

  const sexRaw = String(formData.get("sex") ?? "unknown");
  const sex: "male" | "female" | "unknown" =
    sexRaw === "male" || sexRaw === "female" ? sexRaw : "unknown";

  const dateOfBirth = estimatedBirthDateFromAge(parseAgeFromFormData(formData), new Date());
  const birthDateIsEstimated = dateOfBirth !== null;

  const breed = String(formData.get("breed") ?? "").trim() || null;
  const microchipId = String(formData.get("microchipId") ?? "").trim() || null;

  const favouriteFoodsList = (formData.getAll("favouriteFoods") as string[])
    .map((s) => s.trim())
    .filter(Boolean);
  const favouriteFoodsOther = String(formData.get("favouriteFoodsOther") ?? "").trim();
  const favouriteFoods = [
    ...favouriteFoodsList,
    ...favouriteFoodsOther
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ];

  const knownAllergiesList = (formData.getAll("knownAllergies") as string[])
    .map((s) => s.trim())
    .filter(Boolean);
  const knownAllergiesOther = String(formData.get("knownAllergiesOther") ?? "").trim();
  const knownAllergies = [
    ...knownAllergiesList,
    ...knownAllergiesOther
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ];

  const trainingLevelRaw = String(formData.get("trainingLevel") ?? "").trim();
  const trainingLevel: TrainingLevel | null = (TRAINING_LEVEL_VALUES as readonly string[]).includes(
    trainingLevelRaw,
  )
    ? (trainingLevelRaw as TrainingLevel)
    : null;

  const acquisitionMethodRaw = String(formData.get("acquisitionMethod") ?? "").trim();
  const acquisitionMethod: AcquisitionMethod | null = (
    ACQUISITION_METHODS as readonly string[]
  ).includes(acquisitionMethodRaw)
    ? (acquisitionMethodRaw as AcquisitionMethod)
    : null;

  const custodyKindRaw = String(formData.get("custodyKind") ?? "owner").trim();
  const custodyKind: "owner" | "foster_in_transit" =
    custodyKindRaw === "foster_in_transit" ? "foster_in_transit" : "owner";

  const permanentConditions = parsePermanentConditions(formData);
  const discloseRaw = formData.get("discloseConditionsPublicly") === "true";

  const draft: ParsedPet = {
    name,
    species,
    sex,
    breed,
    dateOfBirth,
    birthDateIsEstimated,
    color: String(formData.get("color") ?? "").trim() || null,
    microchipId,
    microchipCountryCode: microchipId
      ? String(formData.get("microchipCountryCode") ?? "").trim() || null
      : null,
    microchipImplantedAt: microchipId
      ? String(formData.get("microchipImplantedAt") ?? "").trim() || null
      : null,
    microchipImplantedBy: microchipId
      ? String(formData.get("microchipImplantedBy") ?? "").trim() || null
      : null,
    microchipLocation: microchipId
      ? String(formData.get("microchipLocation") ?? "").trim() || null
      : null,
    estimatedWeightKg: String(formData.get("estimatedWeightKg") ?? "").trim() || null,
    favouriteFoods,
    knownAllergies,
    trainingLevel,
    insuranceCompany: String(formData.get("insuranceCompany") ?? "").trim() || null,
    insurancePolicyNumber: String(formData.get("insurancePolicyNumber") ?? "").trim() || null,
    jurisdictionProvince: provinceForStorage,
    jurisdictionLocality: loc.locality,
    // The row the person picked, not just its name — the action resolves the
    // catalogue with it so a homonym is not settled alphabetically (L2-8).
    localityIndecId: loc.localityIndecId,
    acquisitionMethod,
    emergencyInfoVisible: formData.get("emergencyInfoVisible") === "true",
    permanentConditions,
    permanentConditionsOther: String(formData.get("permanentConditionsOther") ?? "").trim() || null,
    discloseConditionsPublicly: discloseRaw,
    custodyKind,
  };

  // Normalize derived booleans inline — callers get a ready-to-use ParsedPet.
  const parsed: ParsedPet = {
    ...draft,
    discloseConditionsPublicly: normalizeDisclose(draft),
    permanentConditionsOther: normalizeConditionsOther(draft),
  };

  // PII guard: the "otra condición" free text can render on the public
  // credential (discloseConditionsPublicly / Tier-2 público). Reject saves
  // that contain phone/email so contact data never reaches a public surface
  // by accident — regardless of the current disclose flag, which the owner
  // can flip later without re-editing the text.
  if (parsed.permanentConditionsOther) {
    const contactKind = detectContactInfoInFreeText(parsed.permanentConditionsOther);
    if (contactKind) {
      return {
        parsed: null,
        error:
          "La descripción de la condición no puede incluir teléfonos ni emails: puede mostrarse en la credencial pública. Escribila sin datos de contacto.",
      };
    }
  }

  return { parsed, error: null };
}

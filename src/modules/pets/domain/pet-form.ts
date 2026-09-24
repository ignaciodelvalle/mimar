// Pure form-parsing for the pets domain.
// Zero external imports — no @/db, drizzle-orm, or next imports allowed.
// Extracted from app/actions/pets.ts parsePetForm + helpers.

import { canonicalProvinceNameForStorage } from "@/lib/domain/jurisdiction-canonical";
import { parseLocationFromFormData } from "@/lib/domain/location-value";
import {
  type PermanentCondition,
  sanitizeConditionCodes,
} from "@/lib/reference/permanent-conditions";
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

const TRAINING_LEVELS = ["none", "basic", "intermediate", "advanced", "professional"] as const;
type TrainingLevel = (typeof TRAINING_LEVELS)[number];

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

// Email: anything shaped like local@domain.tld.
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]{2,}/;
// Phone candidate: a run of digits with common separators. Flagged only when
// the run contains 9+ digits — AR numbers have 10 (or 8 local + area handled
// by the +9 threshold), while dates ("01/02/2020" splits on "/") and dosage
// counts stay well below it.
const PHONE_CANDIDATE_PATTERN = /\+?\d[\d\s().-]*\d/g;

/**
 * Privacy guard for owner free text that can render on PUBLIC surfaces
 * (permanentConditionsOther shows on /p/[publicToken] via
 * discloseConditionsPublicly and the Tier-2 medical view). Detects contact
 * info an owner may have pasted by accident so the save path can reject it
 * instead of publishing PII (Ley 25.326 hardening, 2026-07-04).
 *
 * Pure function — conservative heuristics, no external imports.
 */
export function detectContactInfoInFreeText(text: string): "email" | "phone" | null {
  if (EMAIL_PATTERN.test(text)) return "email";
  for (const candidate of text.match(PHONE_CANDIDATE_PATTERN) ?? []) {
    const digits = candidate.replace(/\D/g, "");
    if (digits.length >= 9) return "phone";
  }
  return null;
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

  const ageYearsRaw = String(formData.get("ageYears") ?? "").trim();
  const ageMonthsRaw = String(formData.get("ageMonths") ?? "").trim();
  const ageYears = ageYearsRaw ? Math.max(0, Number.parseInt(ageYearsRaw, 10) || 0) : null;
  const ageMonths = ageMonthsRaw ? Math.max(0, Number.parseInt(ageMonthsRaw, 10) || 0) : null;
  let dateOfBirth: string | null = null;
  let birthDateIsEstimated = false;
  if (ageYears !== null || ageMonths !== null) {
    const totalMonths = (ageYears ?? 0) * 12 + (ageMonths ?? 0);
    const dob = new Date();
    dob.setMonth(dob.getMonth() - totalMonths);
    dateOfBirth = dob.toISOString().slice(0, 10);
    birthDateIsEstimated = true;
  }

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
  const trainingLevel: TrainingLevel | null = (TRAINING_LEVELS as readonly string[]).includes(
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

// Curated catalog of common veterinary medications used in Argentina (dogs and cats).
// Dose values are conservative typical-range references for the species — they are NOT a
// substitute for veterinary prescription. Specific brand/molecule references should be
// added/corrected by a domain SME.
//
// Code values stay English (stable identifiers). Labels are es-AR Spanish.
// Species filter: a drug appears in the picker only when the pet's species is included.

export type DrugSpecies = "dog" | "cat";

export type DrugCategory =
  | "antibiotic"
  | "nsaid"
  | "analgesic"
  | "corticoid"
  | "cardiac"
  | "dermatologic"
  | "endocrine"
  | "gastric"
  | "behavioral"
  | "other";

export type FrequencyKind =
  | "once_daily"
  | "twice_daily"
  | "three_times_daily"
  | "four_times_daily"
  | "single_dose"
  | "custom";

export type DrugDef = {
  code: string; // stable id — never localize
  label: string; // es-AR display label
  brandNames?: string[]; // common AR brand names
  species: DrugSpecies[]; // dog, cat — or both
  category: DrugCategory;
  typicalDose: string; // text range, not computed per-kg
  typicalFrequency: FrequencyKind;
};

export const DRUG_CATALOG: readonly DrugDef[] = [
  // ─── Antibiotics ───────────────────────────────────────────────────────────
  {
    code: "amoxicillin",
    label: "Amoxicilina",
    brandNames: ["Clavamox"],
    species: ["dog", "cat"],
    category: "antibiotic",
    typicalDose: "10–20 mg/kg",
    typicalFrequency: "twice_daily",
  },
  {
    code: "amoxicillin_clavulanate",
    label: "Amoxicilina + ácido clavulánico",
    brandNames: ["Clavamox", "Synulox"],
    species: ["dog", "cat"],
    category: "antibiotic",
    typicalDose: "12.5–25 mg/kg",
    typicalFrequency: "twice_daily",
  },
  {
    code: "cephalexin",
    label: "Cefalexina",
    species: ["dog", "cat"],
    category: "antibiotic",
    typicalDose: "22 mg/kg",
    typicalFrequency: "twice_daily",
  },
  {
    code: "enrofloxacin",
    label: "Enrofloxacina",
    brandNames: ["Baytril"],
    species: ["dog", "cat"],
    category: "antibiotic",
    typicalDose: "5 mg/kg",
    typicalFrequency: "once_daily",
  },
  {
    code: "metronidazole",
    label: "Metronidazol",
    brandNames: ["Flagyl"],
    species: ["dog", "cat"],
    category: "antibiotic",
    typicalDose: "10–15 mg/kg",
    typicalFrequency: "twice_daily",
  },
  {
    code: "doxycycline",
    label: "Doxiciclina",
    species: ["dog", "cat"],
    category: "antibiotic",
    typicalDose: "5–10 mg/kg",
    typicalFrequency: "once_daily",
  },

  // ─── NSAIDs / Anti-inflammatory ────────────────────────────────────────────
  {
    code: "meloxicam",
    label: "Meloxicam",
    brandNames: ["Metacam"],
    species: ["dog", "cat"],
    category: "nsaid",
    typicalDose: "0.1 mg/kg (mantenimiento)",
    typicalFrequency: "once_daily",
  },
  {
    code: "carprofen",
    label: "Carprofeno",
    brandNames: ["Rimadyl"],
    species: ["dog"],
    category: "nsaid",
    typicalDose: "2 mg/kg",
    typicalFrequency: "twice_daily",
  },
  {
    code: "firocoxib",
    label: "Firocoxib",
    brandNames: ["Previcox"],
    species: ["dog"],
    category: "nsaid",
    typicalDose: "5 mg/kg",
    typicalFrequency: "once_daily",
  },

  // ─── Analgesia ─────────────────────────────────────────────────────────────
  {
    code: "tramadol",
    label: "Tramadol",
    species: ["dog", "cat"],
    category: "analgesic",
    typicalDose: "2–5 mg/kg",
    typicalFrequency: "three_times_daily",
  },
  {
    code: "gabapentin",
    label: "Gabapentina",
    species: ["dog", "cat"],
    category: "analgesic",
    typicalDose: "10–20 mg/kg",
    typicalFrequency: "twice_daily",
  },

  // ─── Corticoids ─────────────────────────────────────────────────────────────
  {
    code: "prednisone",
    label: "Prednisona",
    species: ["dog", "cat"],
    category: "corticoid",
    typicalDose: "0.5–1 mg/kg",
    typicalFrequency: "once_daily",
  },
  {
    code: "dexamethasone",
    label: "Dexametasona",
    species: ["dog", "cat"],
    category: "corticoid",
    typicalDose: "0.1–0.2 mg/kg",
    typicalFrequency: "once_daily",
  },

  // ─── Cardiac ────────────────────────────────────────────────────────────────
  {
    code: "enalapril",
    label: "Enalapril",
    species: ["dog", "cat"],
    category: "cardiac",
    typicalDose: "0.5 mg/kg",
    typicalFrequency: "once_daily",
  },
  {
    code: "pimobendan",
    label: "Pimobendan",
    brandNames: ["Vetmedin"],
    species: ["dog"],
    category: "cardiac",
    typicalDose: "0.25 mg/kg",
    typicalFrequency: "twice_daily",
  },
  {
    code: "furosemide",
    label: "Furosemida",
    brandNames: ["Lasix"],
    species: ["dog", "cat"],
    category: "cardiac",
    typicalDose: "1–2 mg/kg",
    typicalFrequency: "twice_daily",
  },

  // ─── Dermatologic ───────────────────────────────────────────────────────────
  {
    code: "ciclosporin",
    label: "Ciclosporina",
    brandNames: ["Atopica"],
    species: ["dog", "cat"],
    category: "dermatologic",
    typicalDose: "5 mg/kg",
    typicalFrequency: "once_daily",
  },
  {
    code: "oclacitinib",
    label: "Oclacitinib",
    brandNames: ["Apoquel"],
    species: ["dog"],
    category: "dermatologic",
    typicalDose: "0.4–0.6 mg/kg",
    typicalFrequency: "twice_daily",
  },

  // ─── Endocrine ──────────────────────────────────────────────────────────────
  {
    code: "levothyroxine",
    label: "Levotiroxina",
    species: ["dog", "cat"],
    category: "endocrine",
    typicalDose: "0.02 mg/kg",
    typicalFrequency: "twice_daily",
  },
  {
    code: "trilostane",
    label: "Trilostano",
    brandNames: ["Vetoryl"],
    species: ["dog"],
    category: "endocrine",
    typicalDose: "2 mg/kg",
    typicalFrequency: "once_daily",
  },

  // ─── Gastric ────────────────────────────────────────────────────────────────
  {
    code: "omeprazole",
    label: "Omeprazol",
    species: ["dog", "cat"],
    category: "gastric",
    typicalDose: "1 mg/kg",
    typicalFrequency: "once_daily",
  },
  {
    code: "maropitant",
    label: "Maropitant",
    brandNames: ["Cerenia"],
    species: ["dog", "cat"],
    category: "gastric",
    typicalDose: "2 mg/kg",
    typicalFrequency: "once_daily",
  },
  {
    code: "sucralfate",
    label: "Sucralfato",
    species: ["dog", "cat"],
    category: "gastric",
    typicalDose: "0.5–1 g (perros) / 0.25 g (gatos)",
    typicalFrequency: "three_times_daily",
  },

  // ─── Behavioral ─────────────────────────────────────────────────────────────
  {
    code: "fluoxetine",
    label: "Fluoxetina",
    species: ["dog", "cat"],
    category: "behavioral",
    typicalDose: "1 mg/kg",
    typicalFrequency: "once_daily",
  },
  {
    code: "trazodone",
    label: "Trazodona",
    species: ["dog"],
    category: "behavioral",
    typicalDose: "3–7 mg/kg",
    typicalFrequency: "twice_daily",
  },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

export function findDrug(code: string | null | undefined): DrugDef | null {
  if (!code) return null;
  return DRUG_CATALOG.find((d) => d.code === code) ?? null;
}

export function drugsForSpecies(species: string | null | undefined): readonly DrugDef[] {
  if (species === "dog" || species === "cat") {
    return DRUG_CATALOG.filter((d) => d.species.includes(species));
  }
  // For "other", null, or companion species not yet catalogued
  // (rabbit, guinea_pig, ferret), show the full catalog. The dose
  // ranges are canine/feline-typed so they are NOT prescriptive for
  // exotics — picker is intentionally informational + the actual dose
  // is free text. Species-tagged entries land as the catalog grows.
  return DRUG_CATALOG;
}

export function searchDrugsByLabel(query: string): readonly DrugDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return DRUG_CATALOG;
  return DRUG_CATALOG.filter((d) => d.label.toLowerCase().includes(q));
}

export function findDrugByLabel(label: string): DrugDef | null {
  const target = label.trim().toLowerCase();
  return DRUG_CATALOG.find((d) => d.label.toLowerCase() === target) ?? null;
}

// ─── Antimicrobial classification (AMR surveillance, metric A12) ──────────────
//
// The AMR / antimicrobial-use-density metric needs to know whether a
// `medication_started` event refers to an antimicrobial drug. The curated
// DRUG_CATALOG is the single source of truth: today the only antimicrobial
// category is "antibiotic". When the catalog grows to include other
// antimicrobial classes (antifungals, antivirals, antiparasitics used for
// AMR-relevant indications), add the categories to ANTIMICROBIAL_CATEGORIES.
//
// Classification confidence (umbrella §7): a `drug_code` present in the catalog
// is classified deterministically (antibiotic → antimicrobial). A `drug_code`
// NOT in the catalog is UNKNOWN, not "non-antimicrobial". Callers computing the
// A12 density must keep unknown-code counts separate and label them as
// "clasificación provisional" rather than folding them into a confident rate.

/** DrugCategory values that count as antimicrobial for AMR surveillance. */
export const ANTIMICROBIAL_CATEGORIES: readonly DrugCategory[] = ["antibiotic"];

/**
 * Returns true when the drug code is a KNOWN antimicrobial in the catalog.
 *
 * Returns false for:
 *  - known non-antimicrobial drugs (e.g. "meloxicam"), and
 *  - unknown / unclassifiable codes (null, empty, or not in the catalog).
 *
 * Because false conflates "known non-antimicrobial" with "unknown", callers
 * that need to surface classification uncertainty (metric A12) should also use
 * `isClassifiedDrug(code)` to detect unknown codes and report them as a
 * provisional raw count instead of a rate.
 */
export function isAntimicrobial(code: string | null | undefined): boolean {
  const drug = findDrug(code);
  if (!drug) return false;
  return ANTIMICROBIAL_CATEGORIES.includes(drug.category);
}

/**
 * Returns true when the drug code exists in the curated catalog (i.e. its
 * antimicrobial status can be classified confidently). Unknown codes return
 * false so the AMR metric can route them to a provisional bucket.
 */
export function isClassifiedDrug(code: string | null | undefined): boolean {
  return findDrug(code) !== null;
}

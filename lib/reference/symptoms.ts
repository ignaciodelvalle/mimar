// Symptom catalog for the surveillance pipeline.
//
// Each symptom has stable codes, es-AR labels, synonyms for fuzzy matching,
// and links to diseases with specificity grades (high / medium / low).
//
// The catalog lives in code (not DB) so changes are git-tracked and zero-migration.
// When the admin page gains a catalog editor, move to a DB table — schema-ready.
//
// See docs/superpowers/specs/2026-05-17-symptom-disease-surveillance-design.md §4.1.

import type { DiseaseSpecies } from "./diseases";

export type SymptomCategory =
  | "general" // fever, lethargy, weight loss
  | "gastrointestinal" // vomiting, diarrhea, jaundice
  | "respiratory" // cough, nasal discharge, dyspnea
  | "neurological" // seizures, paralysis, hypersalivation
  | "dermatological" // skin lesions, hair loss, bleeding
  | "behavioral"; // aggression, behavioral changes

export type Specificity = "high" | "medium" | "low";

export type SymptomDiseaseLink = {
  disease_code: string; // matches diseases.ts code
  specificity: Specificity;
};

export type SymptomDef = {
  code: string; // stable identifier, snake_case
  label: string; // es-AR display label
  category: SymptomCategory;
  species: DiseaseSpecies[];
  synonyms: readonly string[]; // alternative phrasings the owner might type
  related_diseases: readonly SymptomDiseaseLink[];
};

export const SYMPTOMS: readonly SymptomDef[] = [
  // ─── General ────────────────────────────────────────────────────────────
  {
    code: "high_fever",
    label: "Fiebre alta",
    category: "general",
    species: ["dog", "cat"],
    synonyms: ["fiebre", "fiebre alta", "temperatura", "caliente", "calentura"],
    related_diseases: [
      { disease_code: "leptospirosis", specificity: "medium" },
      { disease_code: "distemper", specificity: "medium" },
      { disease_code: "parvovirus", specificity: "medium" },
      { disease_code: "babesiosis", specificity: "high" },
      { disease_code: "ehrlichiosis", specificity: "medium" },
      { disease_code: "feline_panleukopenia", specificity: "medium" },
    ],
  },
  {
    code: "lethargy",
    label: "Letargo / decaimiento",
    category: "general",
    species: ["dog", "cat"],
    synonyms: [
      "decaído",
      "decaida",
      "decaimiento",
      "sin energía",
      "apagado",
      "apagada",
      "triste",
      "letargo",
    ],
    related_diseases: [
      { disease_code: "leptospirosis", specificity: "low" },
      { disease_code: "distemper", specificity: "low" },
      { disease_code: "parvovirus", specificity: "low" },
    ],
  },
  {
    code: "weight_loss",
    label: "Pérdida de peso",
    category: "general",
    species: ["dog", "cat"],
    synonyms: ["adelgazó", "adelgazo", "pierde peso", "bajó de peso", "flaco", "muy flaco"],
    related_diseases: [
      { disease_code: "visceral_leishmaniasis", specificity: "medium" },
      { disease_code: "tuberculosis", specificity: "medium" },
      { disease_code: "feline_leukemia", specificity: "medium" },
      { disease_code: "feline_immunodeficiency", specificity: "medium" },
    ],
  },
  {
    code: "anorexia",
    label: "Falta de apetito",
    category: "general",
    species: ["dog", "cat"],
    synonyms: ["no come", "no quiere comer", "falta de apetito", "anorexia", "rechaza la comida"],
    related_diseases: [
      { disease_code: "leptospirosis", specificity: "low" },
      { disease_code: "parvovirus", specificity: "low" },
      { disease_code: "distemper", specificity: "low" },
    ],
  },

  // ─── Gastrointestinal ──────────────────────────────────────────────────
  {
    code: "vomiting",
    label: "Vómitos",
    category: "gastrointestinal",
    species: ["dog", "cat"],
    synonyms: ["vomita", "vómito", "vómitos", "está vomitando", "devuelve la comida"],
    related_diseases: [
      { disease_code: "leptospirosis", specificity: "medium" },
      { disease_code: "parvovirus", specificity: "high" },
      { disease_code: "feline_panleukopenia", specificity: "high" },
    ],
  },
  {
    code: "bloody_diarrhea",
    label: "Diarrea con sangre",
    category: "gastrointestinal",
    species: ["dog", "cat"],
    synonyms: [
      "diarrea con sangre",
      "caca con sangre",
      "diarrea hemorrágica",
      "deposiciones con sangre",
    ],
    related_diseases: [
      { disease_code: "parvovirus", specificity: "high" },
      { disease_code: "feline_panleukopenia", specificity: "high" },
    ],
  },
  {
    code: "diarrhea",
    label: "Diarrea",
    category: "gastrointestinal",
    species: ["dog", "cat"],
    synonyms: ["diarrea", "suelta", "deposiciones blandas", "caca floja"],
    related_diseases: [
      { disease_code: "parvovirus", specificity: "medium" },
      { disease_code: "feline_panleukopenia", specificity: "medium" },
      { disease_code: "distemper", specificity: "low" },
    ],
  },
  {
    code: "jaundice",
    label: "Ictericia (color amarillento)",
    category: "gastrointestinal",
    species: ["dog", "cat"],
    synonyms: ["amarillo", "amarilla", "ojos amarillos", "encías amarillas", "ictericia"],
    related_diseases: [
      { disease_code: "leptospirosis", specificity: "high" },
      { disease_code: "babesiosis", specificity: "medium" },
    ],
  },

  // ─── Respiratory ────────────────────────────────────────────────────────
  {
    code: "cough",
    label: "Tos",
    category: "respiratory",
    species: ["dog", "cat"],
    synonyms: ["tose", "tos", "tosiendo"],
    related_diseases: [
      { disease_code: "tuberculosis", specificity: "medium" },
      { disease_code: "distemper", specificity: "medium" },
    ],
  },
  {
    code: "nasal_discharge",
    label: "Secreción nasal",
    category: "respiratory",
    species: ["dog", "cat"],
    synonyms: ["moco", "mocos", "secreción nasal", "le sale moco", "le moquea la nariz"],
    related_diseases: [{ disease_code: "distemper", specificity: "high" }],
  },
  {
    code: "difficulty_breathing",
    label: "Dificultad para respirar",
    category: "respiratory",
    species: ["dog", "cat"],
    synonyms: ["respira mal", "le cuesta respirar", "agitada", "agitado", "disnea"],
    related_diseases: [{ disease_code: "tuberculosis", specificity: "medium" }],
  },

  // ─── Neurological ───────────────────────────────────────────────────────
  {
    code: "seizures",
    label: "Convulsiones",
    category: "neurological",
    species: ["dog", "cat"],
    synonyms: ["convulsión", "convulsiones", "convulsiona", "ataques", "espasmos"],
    related_diseases: [
      { disease_code: "rabies_suspected", specificity: "medium" },
      { disease_code: "distemper", specificity: "high" },
    ],
  },
  {
    code: "paralysis",
    label: "Parálisis",
    category: "neurological",
    species: ["dog", "cat"],
    synonyms: ["paralizado", "paralizada", "no se mueve", "no puede caminar", "parálisis"],
    related_diseases: [
      { disease_code: "rabies_suspected", specificity: "high" },
      { disease_code: "distemper", specificity: "medium" },
    ],
  },
  {
    code: "hypersalivation",
    label: "Salivación excesiva",
    category: "neurological",
    species: ["dog", "cat"],
    synonyms: [
      "babea",
      "baba",
      "babea mucho",
      "salivación",
      "hipersalivación",
      "saliva mucho",
      "le cae baba",
    ],
    related_diseases: [{ disease_code: "rabies_suspected", specificity: "high" }],
  },
  {
    code: "aggression_unusual",
    label: "Agresividad inusual",
    category: "behavioral",
    species: ["dog", "cat"],
    synonyms: [
      "agresivo",
      "agresiva",
      "muy agresivo",
      "agresividad",
      "muerde sin razón",
      "ataca sin razón",
    ],
    related_diseases: [{ disease_code: "rabies_suspected", specificity: "high" }],
  },
  {
    code: "behavioral_changes",
    label: "Cambios de comportamiento",
    category: "behavioral",
    species: ["dog", "cat"],
    synonyms: [
      "raro",
      "rara",
      "está raro",
      "está rara",
      "actúa raro",
      "comportamiento diferente",
      "cambios",
    ],
    related_diseases: [
      { disease_code: "rabies_suspected", specificity: "high" },
      { disease_code: "distemper", specificity: "low" },
    ],
  },
  {
    code: "hydrophobia",
    label: "Miedo al agua",
    category: "behavioral",
    species: ["dog", "cat"],
    synonyms: ["miedo al agua", "rechaza el agua", "no toma agua", "hidrofobia", "le teme al agua"],
    related_diseases: [{ disease_code: "rabies_suspected", specificity: "high" }],
  },
  {
    code: "disorientation",
    label: "Desorientación",
    category: "neurological",
    species: ["dog", "cat"],
    synonyms: ["desorientada", "desorientado", "perdido", "perdida", "se choca", "tropieza"],
    related_diseases: [
      { disease_code: "distemper", specificity: "medium" },
      { disease_code: "rabies_suspected", specificity: "medium" },
    ],
  },

  // ─── Dermatological / Hematological ─────────────────────────────────────
  {
    code: "skin_lesions",
    label: "Lesiones en la piel",
    category: "dermatological",
    species: ["dog", "cat"],
    synonyms: ["lesiones", "heridas", "llagas", "úlceras", "costras"],
    related_diseases: [{ disease_code: "visceral_leishmaniasis", specificity: "high" }],
  },
  {
    code: "hair_loss",
    label: "Pérdida de pelo / alopecia",
    category: "dermatological",
    species: ["dog", "cat"],
    synonyms: ["pierde pelo", "se le cae el pelo", "alopecia", "pelado", "calvicie"],
    related_diseases: [{ disease_code: "visceral_leishmaniasis", specificity: "medium" }],
  },
  {
    code: "bleeding",
    label: "Sangrado",
    category: "dermatological",
    species: ["dog", "cat"],
    synonyms: ["sangra", "sangrado", "hemorragia", "le sangra"],
    related_diseases: [
      { disease_code: "leptospirosis", specificity: "medium" },
      { disease_code: "ehrlichiosis", specificity: "medium" },
    ],
  },
  {
    code: "nose_bleeding",
    label: "Sangrado nasal",
    category: "dermatological",
    species: ["dog", "cat"],
    synonyms: ["sangra por la nariz", "sangrado nasal", "epistaxis", "le sale sangre por la nariz"],
    related_diseases: [
      { disease_code: "visceral_leishmaniasis", specificity: "high" },
      { disease_code: "ehrlichiosis", specificity: "medium" },
    ],
  },
];

export function findSymptom(code: string): SymptomDef | null {
  return SYMPTOMS.find((s) => s.code === code) ?? null;
}

export function symptomsForSpecies(species: string | null): readonly SymptomDef[] {
  if (!species || species === "other") return SYMPTOMS;
  return SYMPTOMS.filter(
    (s) =>
      s.species.includes("any" as DiseaseSpecies) || s.species.includes(species as DiseaseSpecies),
  );
}

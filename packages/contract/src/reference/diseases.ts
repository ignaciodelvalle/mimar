// Curated catalog of diseases relevant to companion-animal death recording.
// The `reportable` flag marks diseases that require notification to Argentine
// sanitary authorities (SENASA / Ministerio de Salud zoonosis surveillance
// programs). Specific law/resolution references should be added per entry by
// a domain SME — they are intentionally omitted here rather than guessed.
//
// Species filter: a disease appears in the picker only when the pet's species
// is in `species` (or `species` includes "any"). Behaviour per species:
//   - "dog" / "cat" → species-tagged + any.
//   - "other" or null → full catalog (no info to filter by).
//   - any other companion species (rabbit, guinea_pig, ferret, …) → any-tagged
//     only, since the catalog is dog/cat-centric. The "any" zoonoses still
//     apply (rabia, leptospirosis, tbc, carbunclo, toxoplasmosis-ish).
//     Add species-specific entries as the catalog evolves.

export type DiseaseSpecies = "dog" | "cat" | "any";

export type DiseaseDef = {
  code: string; // stable identifier — never localize
  label: string; // es-AR display label
  species: DiseaseSpecies[]; // filter for the form picker
  reportable: boolean; // true = required notification per AR zoonosis frameworks
};

export const DISEASES: readonly DiseaseDef[] = [
  // Reportable (zoonoses per Argentine federal animal health frameworks)
  {
    code: "rabies_confirmed",
    label: "Rabia (confirmada)",
    species: ["dog", "cat"],
    reportable: true,
  },
  {
    code: "rabies_suspected",
    label: "Sospecha de rabia",
    species: ["dog", "cat"],
    reportable: true,
  },
  { code: "leptospirosis", label: "Leptospirosis", species: ["dog", "cat"], reportable: true },
  {
    code: "canine_brucellosis",
    label: "Brucelosis canina (B. canis)",
    species: ["dog"],
    reportable: true,
  },
  {
    code: "visceral_leishmaniasis",
    label: "Leishmaniasis visceral",
    species: ["dog"],
    reportable: true,
  },
  {
    code: "hydatidosis",
    label: "Hidatidosis (Equinococosis)",
    species: ["dog"],
    reportable: true,
  },
  { code: "tuberculosis", label: "Tuberculosis", species: ["dog", "cat"], reportable: true },
  { code: "anthrax", label: "Carbunclo (Ántrax)", species: ["dog", "cat"], reportable: true },
  { code: "toxoplasmosis", label: "Toxoplasmosis", species: ["cat"], reportable: true },
  // Common non-reportable (catalog completeness so owners can pick a real name)
  { code: "distemper", label: "Moquillo (Distemper canino)", species: ["dog"], reportable: false },
  { code: "parvovirus", label: "Parvovirus canino", species: ["dog"], reportable: false },
  {
    code: "feline_panleukopenia",
    label: "Panleucopenia felina",
    species: ["cat"],
    reportable: false,
  },
  {
    code: "feline_infectious_peritonitis",
    label: "Peritonitis infecciosa felina (PIF)",
    species: ["cat"],
    reportable: false,
  },
  { code: "feline_leukemia", label: "Leucemia felina (FeLV)", species: ["cat"], reportable: false },
  {
    code: "feline_immunodeficiency",
    label: "Inmunodeficiencia felina (FIV)",
    species: ["cat"],
    reportable: false,
  },
  { code: "ehrlichiosis", label: "Ehrlichiosis canina", species: ["dog"], reportable: false },
  { code: "babesiosis", label: "Babesiosis", species: ["dog", "cat"], reportable: false },
  // Fallback
  { code: "other", label: "Otra (especificar en detalle)", species: ["any"], reportable: false },
];

export function findDisease(code: string | null | undefined): DiseaseDef | null {
  if (!code) return null;
  return DISEASES.find((d) => d.code === code) ?? null;
}

export function diseasesForSpecies(species: string | null | undefined): readonly DiseaseDef[] {
  // For "other" or null, show the full catalog (no filtering).
  if (!species || species === "other") return DISEASES;
  // Dog/cat get the species-specific filter.
  if (species === "dog" || species === "cat") {
    return DISEASES.filter((d) => d.species.includes("any") || d.species.includes(species));
  }
  // Companion species not yet in the catalog (rabbit, guinea_pig, ferret, …):
  // surface only the cross-species zoonoses (`any`-tagged) instead of an
  // empty picker. Species-specific entries land when the catalog grows.
  return DISEASES.filter((d) => d.species.includes("any"));
}

export function isReportable(diseaseCode: string | null | undefined): boolean {
  const def = findDisease(diseaseCode);
  return def?.reportable === true;
}

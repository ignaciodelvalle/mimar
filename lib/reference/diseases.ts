// `lib/reference/diseases` — the disease catalog, re-exported from the contract.
//
// THE DATA MOVED TO `packages/contract/src/reference/diseases.ts` ON 2026-09-08,
// and this file stayed so the eight server-side consumers keep their import
// path. The precedent is `DANGEROUS_BREED_REGISTRIES`, which made the same trip
// three days earlier for the same reason.
//
// WHY IT MOVED. The native app's death form has to draw a disease picker, and a
// picker that cannot name the codes the server accepts can only produce a 400.
// The catalog qualifies for `@dim/contract/reference` on that module's own
// stated terms — "a list whose CONTENT is the same everywhere and whose
// staleness is measured in months" — and it qualified before it moved: the file
// had zero imports, no `server-only`, and no runtime dependency of any kind.
//
// WHAT DID NOT MOVE, and the boundary is the same one that module draws: the
// disease MATCHER (`lib/domain/symptom-matcher.ts`) stays server-side. Naming
// the catalog is a list a client may render; deciding that a person's free text
// means "rabia" is a judgement the server makes, with consequences a client must
// not be able to reach — an outbreak signal and a fan-out to a health authority.

export {
  DISEASES,
  type DiseaseDef,
  type DiseaseSpecies,
  diseasesForSpecies,
  findDisease,
  isReportable,
} from "@dim/contract/reference";

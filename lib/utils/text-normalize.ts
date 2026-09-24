// Canonical text-normalize helper for diacritic/case-insensitive fuzzy
// matching. Extracted from two near-duplicate local implementations
// (lib/domain/symptom-matcher.ts, lib/domain/vaccine-reminder-state.ts) when
// lib/reference/vaccine-fuzzy-match.ts needed the same behavior — three
// copies was the trigger to extract, not two.
//
// Strips Unicode combining marks (category M) left behind by NFD
// decomposition of accented Latin characters — "Antirrábica" → "antirrabica",
// "Vómitos" → "vomitos" — then collapses whitespace and trims.
//
// Both original call sites re-export this under their own `normalize` name
// so their existing callers (incl. src/modules/events/application/medical/
// vaccination-use-case.ts and deworming-use-case.ts, which import `normalize`
// from lib/domain/vaccine-reminder-state.ts) are unaffected.
export function normalizeText(input: string): string {
  return input.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/\s+/g, " ").trim();
}

// THE HARD GATE — atender vaccine catalog gate (PO decision, #5).
//
// An unmatched/uncatalogued vaccine free-text must NEVER commit as-is to the
// government vaccination registry through the walk-in signing surface. Pure
// decision function over lib/reference/vaccine-fuzzy-match.ts — no DOM, no
// network — so the SAME logic drives both the client picker
// ([publicToken]/AtenderVaccinationGate.tsx) and the server-side mirror
// (atenderVaccinationAction, defense in depth: a client that skips the
// picker must still be rejected server-side unless it flagged the note).
//
// Conservative by construction — mirrors VACCINE_AUTOSELECT_CONFIDENCE's own
// contract: `matchVaccineFreeText`'s `resolveAmbiguousTies` already guarantees
// at most ONE candidate can sit at/above the cutoff, so checking the top
// candidate's confidence alone is sufficient to know an autoselect is
// unambiguous — no separate tie check needed here.
//
// PO decision (2026-07-18): an uncatalogued vaccine is never silently accepted
// as ordinary free text and never auto-added to the catalog (no migration) —
// it is flagged in the notes field so the record stays honest about its
// provenance ("vacuna no catalogada: <typed name>").

import {
  VACCINE_AUTOSELECT_CONFIDENCE,
  type VaccineMatchCandidate,
  matchVaccineFreeText,
} from "@/lib/reference/vaccine-fuzzy-match";

/** Prefix written into `notes` when the vet explicitly bypasses the catalog
 * gate for a name with no confident match. Exported so both the client gate
 * and the server-side mirror check for the SAME literal string. */
export const UNCATALOGUED_VACCINE_NOTE_PREFIX = "vacuna no catalogada:";

/** How many pickable candidates the review card shows at most. */
const MAX_REVIEW_CANDIDATES = 3;

export type VaccineGateDecision =
  | { kind: "autoselect"; canonicalName: string }
  | { kind: "review"; candidates: VaccineMatchCandidate[] };

/**
 * Resolves the gate for a typed free-text vaccine name against the species
 * catalog. "autoselect" → safe to submit the canonical name silently.
 * "review" → block submission; the caller must show the (possibly empty)
 * candidate list plus a "no está en el catálogo — continuar igual" escape
 * hatch.
 */
export function resolveVaccineGate(
  typedName: string,
  species: "dog" | "cat" | "other",
): VaccineGateDecision {
  const candidates = matchVaccineFreeText(typedName, species);
  const top = candidates[0];
  if (top && top.confidence >= VACCINE_AUTOSELECT_CONFIDENCE) {
    return { kind: "autoselect", canonicalName: top.vaccine.name };
  }
  return { kind: "review", candidates: candidates.slice(0, MAX_REVIEW_CANDIDATES) };
}

/** Appends the uncatalogued-vaccine flag to whatever notes the vet already
 * typed. The typed name is preserved verbatim — never silently dropped. */
export function withUncataloguedVaccineFlag(notes: string, typedName: string): string {
  const flag = `${UNCATALOGUED_VACCINE_NOTE_PREFIX} ${typedName}`;
  const trimmed = notes.trim();
  return trimmed ? `${trimmed}\n${flag}` : flag;
}

/** True when `notes` already carries the uncatalogued-vaccine flag — the
 * server-side mirror's escape hatch (atenderVaccinationAction). */
export function hasUncataloguedVaccineFlag(notes: string | null | undefined): boolean {
  return typeof notes === "string" && notes.includes(UNCATALOGUED_VACCINE_NOTE_PREFIX);
}

/** Normalizes a pet's species column value to the 3-way union
 * matchVaccineFreeText expects — anything that isn't dog/cat matches the
 * "other" pool (mirrors lib/reference/lookups.ts vaccinesForSpecies). */
export function speciesForVaccineMatch(species: string): "dog" | "cat" | "other" {
  return species === "dog" || species === "cat" ? species : "other";
}

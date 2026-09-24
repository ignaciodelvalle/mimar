// Server-side breed catalog enforcement — QA finding A4 (2026-08-13).
//
// The alta form's breed field was a native <datalist>: it SUGGESTS catalog
// entries but accepts anything, and the server persisted whatever arrived
// ("Raza-Falsa-CW0813" landed in staging). The catalog conversion of
// components/PetForm.tsx (2026-08-13) fixed the EDIT surface, but a UI
// control is not a boundary — any writer that skips the form (crafted
// request, CSV import, another client) still wrote free text, and a
// misspelled PPP breed silently escaped a LEGAL regime.
//
// This is the missing server half: every pet write site resolves the breed
// through the same matcher the classifiers use (case/accent folding +
// curated colloquial aliases) and persists the CANONICAL catalog label, or
// rejects. One deliberate exception: an UPDATE that re-submits the pet's
// currently stored breed unchanged is accepted even when off-catalog
// (QA A5 — a legacy value must survive an unrelated profile edit; the
// alternative is a <select> that silently WIPES a recorded breed).

import { breedListIncludes, breedsForSpecies, resolveBreedLabel } from "@/lib/reference/breeds";

/** Field error shown when a submitted breed is not in the species catalog. */
export const BREED_NOT_IN_CATALOG_MSG = "Elegí una raza de la lista.";

export type BreedWriteResolution =
  | { ok: true; breed: string | null }
  | { ok: false; error: string };

/**
 * Resolve a submitted breed to the canonical catalog label for `species`,
 * or reject.
 *
 *   - empty / null → ok with null (breed stays optional everywhere)
 *   - identical to `storedBreed` → ok, unchanged (grandfather rule: legacy
 *     off-catalog values survive edits; only NEW values are gated)
 *   - resolves (folding + aliases) to a label in the species catalog →
 *     ok with the CANONICAL label ("pitbull" → "Pit Bull Terrier")
 *   - anything else → rejection with a Spanish field error
 *
 * The species catalog always includes the two special options ("Mixto /
 * Cruza", "Pura raza no listada"), so every species — including those with
 * no named breed list — has valid choices. A label that resolves to a
 * DIFFERENT species' catalog (a dog registered as "Persa") is rejected: the
 * matcher searches all catalogs, so the species membership check here is
 * what keeps cross-species labels out.
 */
export function resolveBreedForWrite(
  species: string,
  breed: string | null | undefined,
  opts: { storedBreed?: string | null } = {},
): BreedWriteResolution {
  const trimmed = breed?.trim() ?? "";
  if (trimmed.length === 0) return { ok: true, breed: null };

  const stored = opts.storedBreed?.trim() ?? "";
  if (stored.length > 0 && trimmed === stored) return { ok: true, breed: stored };

  const resolved = resolveBreedLabel(trimmed);
  if (resolved !== null && breedListIncludes(breedsForSpecies(species), resolved)) {
    return { ok: true, breed: resolved };
  }
  return { ok: false, error: BREED_NOT_IN_CATALOG_MSG };
}

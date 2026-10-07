// Folding typed text for a search, the one way both clients do it.
//
// A person types "dalmata" and means "Dálmata"; types "frances" and means
// "Francés". The web's breed search folds accents and the app's did not — the
// app matched with `toLowerCase().includes`, so "dalmata" found nothing (finding
// of the 2026-10-07 component audit). One function, in the package both sides
// import, so a search that folds on one surface folds on the other.
//
// NFD splits an accented letter into its base letter plus a combining mark;
// dropping the marks (Unicode category M) leaves the base. "ñ" folds to "n" — a
// search for "pequenes" finding "Pequeñés" is the forgiving direction. Case is
// folded after, so the result is comparable with `includes`.
//
// `\p{M}` with the `u` flag is already in the app's bundle through
// `locality-copy.ts`, which is why this is not a hand-written code-point loop.

/** Lowercase, accents and combining marks removed. Does not trim. */
export function foldForSearch(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * Whether `candidate` contains what was typed, ignoring case and accents. An
 * empty (or all-space) query matches everything — the caller decides whether
 * an empty query should list everything or nothing.
 */
export function matchesSearch(candidate: string, query: string): boolean {
  const needle = foldForSearch(query.trim());
  return needle.length === 0 || foldForSearch(candidate).includes(needle);
}

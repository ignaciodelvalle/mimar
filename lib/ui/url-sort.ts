// url-sort — URL-driven column sort for operator tables (Lote Q, Q4).
//
// Generalizes the sort model PanoramaDataTable proved (SortKey/SortDir +
// aria-sort), moved OUT of client useState and INTO the URL: the sort key and
// direction live in searchParams (?orden=<key>&dir=asc|desc), every mutation
// commits via serverNavCommit (the sanctioned full-document navigation —
// engram #621/#622), and the SERVER component re-sorts its rows before
// rendering. That makes a sort shareable, bookmarkable, and capturable by
// "Copiar vista" / saved views — none of which a useState sort survives.
//
// HONESTY RULE (the reason this module is small): a screen may only adopt
// URL sort when the sort param actually reaches the code that produces the
// FULL displayed set — an unpaginated server array re-sorted before render,
// or a query whose ORDER BY takes the param. Client-sorting one page of a
// keyset-paginated queue would claim an order over rows the page never saw.
// Paginated screens whose cursor encodes a fixed ordering contract
// (casos/maltrato) therefore stay OFF this primitive until their cursors
// learn direction — documented at those call sites, not silently worked
// around here.
//
// This module is pure (no React, no navigation) — the committing <th> lives
// in components/ui/dashboard/OpSortHeader.tsx.

/** searchParam carrying the sort key. es-AR param names, per URL conventions
 * (period/provincia/zona…): the URL is user-facing surface. */
export const URL_SORT_KEY_PARAM = "orden";
/** searchParam carrying the sort direction ("asc" | "desc"). */
export const URL_SORT_DIR_PARAM = "dir";

export type UrlSortDir = "asc" | "desc";

export type UrlSort<K extends string = string> = {
  key: K;
  dir: UrlSortDir;
};

/**
 * Parse ?orden=&dir= against the screen's closed key set. Fail-closed: an
 * unknown `orden` returns the fallback WHOLE (key and dir) — honoring a
 * stray `dir` against the default key would render an order the URL never
 * legitimately named. A valid `orden` with a missing/invalid `dir` takes the
 * fallback direction.
 */
export function parseUrlSort<K extends string>(
  sp: { orden?: string; dir?: string },
  allowedKeys: readonly K[],
  fallback: UrlSort<K>,
): UrlSort<K> {
  if (!sp.orden || !(allowedKeys as readonly string[]).includes(sp.orden)) {
    return fallback;
  }
  const dir: UrlSortDir = sp.dir === "asc" || sp.dir === "desc" ? sp.dir : fallback.dir;
  return { key: sp.orden as K, dir };
}

/**
 * The param updates a click on `clickedKey` commits — PanoramaDataTable's
 * toggle semantics: same column flips the direction; a new column starts at
 * that column's own default (desc for measures, asc for names — the caller
 * declares it per column).
 */
export function nextUrlSortParams<K extends string>(
  current: UrlSort<K>,
  clickedKey: K,
  clickedDefaultDir: UrlSortDir,
): Record<string, string> {
  const dir: UrlSortDir =
    current.key === clickedKey ? (current.dir === "asc" ? "desc" : "asc") : clickedDefaultDir;
  return { [URL_SORT_KEY_PARAM]: clickedKey, [URL_SORT_DIR_PARAM]: dir };
}

/** aria-sort value for a header cell — same mapping PanoramaDataTable pins. */
export function ariaSortValue(
  active: boolean,
  dir: UrlSortDir,
): "ascending" | "descending" | "none" {
  return active ? (dir === "asc" ? "ascending" : "descending") : "none";
}

/**
 * Sort a server array by a per-key comparator map, ascending by definition of
 * each comparator; `dir === "desc"` negates. Returns a COPY — server
 * components must not mutate fetched arrays other projections may share.
 */
export function sortRowsByUrlSort<T, K extends string>(
  rows: readonly T[],
  sort: UrlSort<K>,
  comparators: Record<K, (a: T, b: T) => number>,
): T[] {
  const cmp = comparators[sort.key];
  const copy = [...rows];
  copy.sort((a, b) => (sort.dir === "asc" ? cmp(a, b) : -cmp(a, b)));
  return copy;
}

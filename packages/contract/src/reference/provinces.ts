// The 24 Argentine jurisdictions (23 provinces + CABA) — the catalog a
// province-first picker renders (L3·0 of the locality plan, PO decision
// 2026-09-08: web AND mobile converge on the province → locality cascade).
//
// WHY IT LIVES HERE. The native locality picker needs the list with no signal
// and no round trip, and this is the one package a React Native app installs.
// It is exactly the kind of thing this package's `reference` entry point says it
// is for: a catalog whose content is the same everywhere and whose staleness is
// measured in decades. It decides nothing — the pair (province, locality) is
// still resolved by the server against `ar_localities` in `strict` mode.
//
// ONE COPY. `lib/reference/ar-provincias.ts` re-exports `PROVINCES` from here
// rather than declaring it (the same move the breed catalogs made), so the web's
// canonical-name checks, the migrations' CHECK list and the phone read the same
// 24 rows.
//
// ISO 3166-2:AR codes are the identifier; `name` is the canonical DISPLAY name
// stored in the jurisdiction columns ("CABA", not "Ciudad Autónoma de Buenos
// Aires" — that longer form is the INDEC catalog's own province label).

export type ReferenceProvince = {
  /** ISO 3166-2:AR code, e.g. "AR-C" for CABA. The canonical identifier. */
  readonly code: string;
  /** Display name in Spanish (Rioplatense usage), e.g. "Buenos Aires". */
  readonly name: string;
  /** URL-safe slug derived from the name, e.g. "buenos-aires". */
  readonly slug: string;
};

export const PROVINCES = [
  { code: "AR-B", name: "Buenos Aires", slug: "buenos-aires" },
  { code: "AR-C", name: "CABA", slug: "caba" },
  { code: "AR-K", name: "Catamarca", slug: "catamarca" },
  { code: "AR-H", name: "Chaco", slug: "chaco" },
  { code: "AR-U", name: "Chubut", slug: "chubut" },
  { code: "AR-X", name: "Córdoba", slug: "cordoba" },
  { code: "AR-W", name: "Corrientes", slug: "corrientes" },
  { code: "AR-E", name: "Entre Ríos", slug: "entre-rios" },
  { code: "AR-P", name: "Formosa", slug: "formosa" },
  { code: "AR-Y", name: "Jujuy", slug: "jujuy" },
  { code: "AR-L", name: "La Pampa", slug: "la-pampa" },
  { code: "AR-F", name: "La Rioja", slug: "la-rioja" },
  { code: "AR-M", name: "Mendoza", slug: "mendoza" },
  { code: "AR-N", name: "Misiones", slug: "misiones" },
  { code: "AR-Q", name: "Neuquén", slug: "neuquen" },
  { code: "AR-R", name: "Río Negro", slug: "rio-negro" },
  { code: "AR-A", name: "Salta", slug: "salta" },
  { code: "AR-J", name: "San Juan", slug: "san-juan" },
  { code: "AR-D", name: "San Luis", slug: "san-luis" },
  { code: "AR-Z", name: "Santa Cruz", slug: "santa-cruz" },
  { code: "AR-S", name: "Santa Fe", slug: "santa-fe" },
  { code: "AR-G", name: "Santiago del Estero", slug: "santiago-del-estero" },
  { code: "AR-V", name: "Tierra del Fuego", slug: "tierra-del-fuego" },
  { code: "AR-T", name: "Tucumán", slug: "tucuman" },
] as const satisfies readonly ReferenceProvince[];

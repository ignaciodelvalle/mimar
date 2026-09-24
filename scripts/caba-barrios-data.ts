/**
 * CABA barrios — canonical reference data for jurisdiction distribution.
 *
 * Single source of truth shared by:
 *   - scripts/redistribute-caba-barrios.ts (one-shot migration that relabels the
 *     placeholder-locality CABA rows to real barrios), and
 *   - scripts/seed-panorama.ts (so fresh re-seeds distribute CABA pets across
 *     barrios instead of the whole-city "Ciudad Autónoma de Buenos Aires" blob).
 *
 * WHY THIS EXISTS
 * INDEC's CPPDyL dataset treats CABA as a SINGLE locality ("Ciudad Autónoma de
 * Buenos Aires", category='componente' in ar_localities — the whole-city
 * operator placeholder, NOT a barrio). The 48 barrios (Ley CABA 1.777) are
 * imported by scripts/import-caba-barrios.ts. The centroids below are the
 * source of truth those imports write into ar_localities.latitude/longitude,
 * so the panorama seed's loadLocalities() (which filters `latitude IS NOT
 * NULL`) keeps them and CABA pets distribute across real barrios instead of
 * collapsing onto the whole-city placeholder blob.
 *
 * The 48 names below are byte-identical to scripts/import-caba-barrios.ts's
 * canonical Ley 1.777 register (so a relabeled pet points at a real
 * ar_localities row). Slugs match public/geo/caba-barrios.geojson `code` and
 * lib/infra/geo-join.ts `normalizeBarioCode`, so the choropleth join lights up.
 *
 * CENTROIDS were computed once from public/geo/caba-barrios.geojson (area-
 * weighted polygon centroid of each barrio's exterior ring) and frozen here so
 * the seed is self-contained and deterministic (no runtime geojson parse).
 *
 * WEIGHTS approximate each barrio's 2010 census population (in thousands),
 * rounded to an integer. Every barrio has a positive weight so the choropleth /
 * points look populated citywide, while the large barrios (Palermo, Caballito,
 * Recoleta, Flores, Belgrano, Balvanera, Almagro…) absorb proportionally more.
 */

export const CABA_PROVINCE = "CABA";

/**
 * The INDEC whole-city placeholder locality. Any CABA pet/case/report sitting
 * here is the "blob" that the migration redistributes across real barrios.
 */
export const CABA_PLACEHOLDER_LOCALITY = "Ciudad Autónoma de Buenos Aires";

export interface CabaBarrio {
  /** Canonical display name (Ley CABA 1.777 register — matches ar_localities). */
  readonly name: string;
  /** geo-join slug (matches caba-barrios.geojson `code` + normalizeBarioCode). */
  readonly slug: string;
  /** Relative weight ≈ 2010 census population (thousands). Always > 0. */
  readonly weight: number;
  /** Area-weighted polygon centroid latitude. */
  readonly lat: number;
  /** Area-weighted polygon centroid longitude. */
  readonly lng: number;
}

/** The 48 official barrios of the Ciudad Autónoma de Buenos Aires. */
export const CABA_BARRIOS: readonly CabaBarrio[] = [
  { name: "Agronomía", slug: "agronomia", weight: 33, lat: -34.59294, lng: -58.48867 },
  { name: "Almagro", slug: "almagro", weight: 131, lat: -34.60923, lng: -58.42175 },
  { name: "Balvanera", slug: "balvanera", weight: 138, lat: -34.6091, lng: -58.40306 },
  { name: "Barracas", slug: "barracas", weight: 90, lat: -34.6464, lng: -58.38427 },
  { name: "Belgrano", slug: "belgrano", weight: 138, lat: -34.55474, lng: -58.45017 },
  { name: "Boedo", slug: "boedo", weight: 47, lat: -34.62996, lng: -58.41884 },
  { name: "Caballito", slug: "caballito", weight: 176, lat: -34.61682, lng: -58.4436 },
  { name: "Chacarita", slug: "chacarita", weight: 26, lat: -34.58837, lng: -58.45418 },
  { name: "Coghlan", slug: "coghlan", weight: 19, lat: -34.56062, lng: -58.47494 },
  { name: "Colegiales", slug: "colegiales", weight: 53, lat: -34.57464, lng: -58.45097 },
  { name: "Constitución", slug: "constitucion", weight: 44, lat: -34.62504, lng: -58.38439 },
  { name: "Flores", slug: "flores", weight: 150, lat: -34.6368, lng: -58.45827 },
  { name: "Floresta", slug: "floresta", weight: 38, lat: -34.62769, lng: -58.48359 },
  { name: "La Boca", slug: "la boca", weight: 45, lat: -34.63107, lng: -58.35682 },
  { name: "La Paternal", slug: "la paternal", weight: 34, lat: -34.59742, lng: -58.46867 },
  { name: "Liniers", slug: "liniers", weight: 44, lat: -34.64379, lng: -58.51913 },
  { name: "Mataderos", slug: "mataderos", weight: 63, lat: -34.65837, lng: -58.50174 },
  { name: "Monserrat", slug: "monserrat", weight: 40, lat: -34.61268, lng: -58.37965 },
  { name: "Monte Castro", slug: "monte castro", weight: 36, lat: -34.6193, lng: -58.50658 },
  { name: "Nueva Pompeya", slug: "nueva pompeya", weight: 42, lat: -34.65052, lng: -58.41888 },
  { name: "Núñez", slug: "nunez", weight: 51, lat: -34.54328, lng: -58.46259 },
  { name: "Palermo", slug: "palermo", weight: 226, lat: -34.57385, lng: -58.42234 },
  {
    name: "Parque Avellaneda",
    slug: "parque avellaneda",
    weight: 53,
    lat: -34.64864,
    lng: -58.47646,
  },
  { name: "Parque Chacabuco", slug: "parque chacabuco", weight: 40, lat: -34.63594, lng: -58.4377 },
  { name: "Parque Chas", slug: "parque chas", weight: 20, lat: -34.58552, lng: -58.47912 },
  {
    name: "Parque Patricios",
    slug: "parque patricios",
    weight: 41,
    lat: -34.63755,
    lng: -58.40168,
  },
  { name: "Puerto Madero", slug: "puerto madero", weight: 6, lat: -34.6092, lng: -58.35638 },
  { name: "Recoleta", slug: "recoleta", weight: 165, lat: -34.58578, lng: -58.39494 },
  { name: "Retiro", slug: "retiro", weight: 28, lat: -34.5884, lng: -58.376 },
  { name: "Saavedra", slug: "saavedra", weight: 47, lat: -34.55308, lng: -58.48874 },
  { name: "San Cristóbal", slug: "san cristobal", weight: 45, lat: -34.62386, lng: -58.40189 },
  { name: "San Nicolás", slug: "san nicolas", weight: 32, lat: -34.60367, lng: -58.38052 },
  { name: "San Telmo", slug: "san telmo", weight: 24, lat: -34.62152, lng: -58.37155 },
  { name: "Vélez Sársfield", slug: "velez sarsfield", weight: 33, lat: -34.63136, lng: -58.49328 },
  { name: "Versalles", slug: "versalles", weight: 14, lat: -34.63012, lng: -58.52242 },
  { name: "Villa Crespo", slug: "villa crespo", weight: 87, lat: -34.59883, lng: -58.44273 },
  {
    name: "Villa del Parque",
    slug: "villa del parque",
    weight: 55,
    lat: -34.60425,
    lng: -58.49068,
  },
  { name: "Villa Devoto", slug: "villa devoto", weight: 68, lat: -34.60235, lng: -58.51428 },
  {
    name: "Villa General Mitre",
    slug: "villa general mitre",
    weight: 33,
    lat: -34.61003,
    lng: -58.46894,
  },
  { name: "Villa Lugano", slug: "villa lugano", weight: 112, lat: -34.67499, lng: -58.47617 },
  { name: "Villa Luro", slug: "villa luro", weight: 32, lat: -34.63641, lng: -58.50273 },
  { name: "Villa Ortúzar", slug: "villa ortuzar", weight: 24, lat: -34.58097, lng: -58.46765 },
  { name: "Villa Pueyrredón", slug: "villa pueyrredon", weight: 41, lat: -34.5821, lng: -58.5035 },
  { name: "Villa Real", slug: "villa real", weight: 15, lat: -34.61949, lng: -58.52604 },
  { name: "Villa Riachuelo", slug: "villa riachuelo", weight: 10, lat: -34.69186, lng: -58.46335 },
  {
    name: "Villa Santa Rita",
    slug: "villa santa rita",
    weight: 33,
    lat: -34.61619,
    lng: -58.48296,
  },
  { name: "Villa Soldati", slug: "villa soldati", weight: 44, lat: -34.66542, lng: -58.44658 },
  { name: "Villa Urquiza", slug: "villa urquiza", weight: 90, lat: -34.57154, lng: -58.48786 },
] as const;

/** Set of the 48 canonical barrio names — for "is this already a real barrio?" checks. */
export const CABA_BARRIO_NAMES: ReadonlySet<string> = new Set(CABA_BARRIOS.map((b) => b.name));

/**
 * Sum of all barrio weights. Used by the SQL weighted-pick modulo in
 * scripts/redistribute-caba-barrios.ts (see pickExpr / barriosCte there).
 */
export const CABA_TOTAL_WEIGHT: number = CABA_BARRIOS.reduce((s, b) => s + b.weight, 0);

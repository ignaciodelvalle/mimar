// The words a citizen sees on the locality field — ONE copy for web and app.
//
// "Localidad" is INDEC's technical term, and testers read it as "a town" and
// then could not find the barrio or the conurbano town they live in (the
// catalogue carries Lomas de Zamora, not Banfield — aliases now bridge that).
// The citizen-facing field says what people actually type. Officials' screens
// (gob/admin/panorama filters) keep "Localidad": that audience uses the
// technical term and works with the larger units on purpose.
//
// Pure data and string functions, no runtime dependency — the native app
// imports this directly (see ./index.ts).

/** The field label, web and app alike. */
export const LOCALITY_FIELD_LABEL = "Ciudad, pueblo o barrio";

/** The field placeholder: the kind of name to type, by example. */
export const LOCALITY_FIELD_PLACEHOLDER = "Ej.: Banfield, Ramos Mejía, Villa María";

/** What a search result needs to be described. Structural, so both the web's
 * `LocalitySearchResult` and the wire's `LocalityV1` satisfy it. */
export type DescribableLocality = {
  localityName: string;
  provinceCode: string;
  provinceName: string;
  departmentName: string | null;
  /** Set when the row was found through an alias (Banfield → Lomas de Zamora). */
  aliasName?: string;
};

function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

/**
 * The name on a result row: "Banfield (Lomas de Zamora)" for an alias — the
 * name the person typed, then the catalogue row picking it stores — or the
 * catalogue name itself.
 */
export function localityOptionLabel(r: DescribableLocality): string {
  return r.aliasName ? `${r.aliasName} (${r.localityName})` : r.localityName;
}

/**
 * The chosen-state line, naming the place and the unit that governs it:
 *   Banfield · partido de Lomas de Zamora, Buenos Aires
 *   Villa María · departamento General San Martín, Córdoba
 *   Palermo · barrio de la Ciudad de Buenos Aires
 * The parent is omitted when it only repeats the name (the "Lomas de Zamora"
 * row sits in partido Lomas de Zamora), and when the catalogue has none.
 */
export function describeChosenLocality(r: DescribableLocality): string {
  return `${chosenLocalityName(r)} · ${chosenLocalityParent(r)}`;
}

/** The name half of the chosen-state line: the alias when one was picked. */
export function chosenLocalityName(r: DescribableLocality): string {
  return r.aliasName ?? r.localityName;
}

/** The parent half: "partido de Lomas de Zamora, Buenos Aires". */
export function chosenLocalityParent(r: DescribableLocality): string {
  if (r.provinceCode === "AR-C") return "barrio de la Ciudad de Buenos Aires";
  const name = chosenLocalityName(r);
  const dept = r.departmentName?.trim();
  if (!dept || fold(dept) === fold(name)) return r.provinceName;
  const unit = r.provinceCode === "AR-B" ? `partido de ${dept}` : `departamento ${dept}`;
  return `${unit}, ${r.provinceName}`;
}

// CABA barrio -> comuna, from the official source (localidades-por-id C5).
//
// The 48 barrios of the Ciudad Autónoma de Buenos Aires are grouped into 15
// comunas by Ley CABA 1.777 (Ley Orgánica de Comunas, 2005). INDEC treats the
// comunas as CABA's departments (codes 02007 … 02105), so a barrio's comuna is
// its `department_code` / `department_name` in ar_localities, exactly as a
// Buenos Aires locality carries its partido.
//
// The mapping is NOT typed from memory: lib/reference/caba-barrio-comunas.json
// holds the official "Barrios por Comuna" resource VERBATIM (its provenance —
// URL, sha256, license, retrieval date — sits in the same file), plus the
// INDEC department code of each comuna from the Georef API. This module only
// reconciles the source's spelling with the catalogue's, and refuses to answer
// when the two disagree in any way: a barrio of either side left unmatched, a
// barrio matched twice, a comuna outside 1-15, or a comuna with no barrio.
//
// SPELLING. The source writes names in upper case without accents ("NUÑEZ",
// "SAN CRISTOBAL"); the catalogue writes them as the barrio polygons do
// ("Núñez", "San Cristóbal"). An accent/case fold settles 45 of them. The other
// three differ in WORDS, and each is resolved explicitly below — never by a
// fuzzy match.

import raw from "@/lib/reference/caba-barrio-comunas.json";

export type CabaComuna = {
  /** 1-15, as Ley 1.777 numbers them. */
  number: number;
  /** INDEC department code, e.g. "02007". */
  departmentCode: string;
  /** INDEC department name, e.g. "Comuna 1". */
  departmentName: string;
};

type Reference = {
  departments: Record<string, [string, string]>;
  rows: Array<[string, number]>;
};

const REFERENCE = raw as unknown as Reference;

/**
 * Source name -> catalogue name, where the two differ in more than accents and
 * case. The catalogue follows the official barrio polygons (Barrios CSV of the
 * same dataset, which writes "La Boca"); the per-comuna table shortens three.
 */
export const SOURCE_SPELLING: Readonly<Record<string, string>> = {
  BOCA: "La Boca",
  PATERNAL: "La Paternal",
  "VILLA GRAL. MITRE": "Villa General Mitre",
};

/**
 * Curated catalogue rows that are not barrios of their own but a part of one
 * (migration 0148: "Belgrano R" mirrors its parent barrio). They take the
 * parent's comuna. The official source does not name them; the parent does.
 */
export const CURATED_PARTS: Readonly<Record<string, string>> = {
  "Belgrano R": "Belgrano",
};

export const COMUNA_COUNT = 15;

function fold(name: string): string {
  return name.normalize("NFD").replace(/\p{M}/gu, "").toUpperCase().replace(/\s+/g, " ").trim();
}

/** The 15 comunas, by number. Throws when the department table is not exactly 1-15. */
export function cabaComunas(): ReadonlyMap<number, CabaComuna> {
  const out = new Map<number, CabaComuna>();
  for (const [key, [code, name]] of Object.entries(REFERENCE.departments)) {
    const n = Number(key);
    if (!Number.isInteger(n) || n < 1 || n > COMUNA_COUNT) {
      throw new Error(`caba-comunas: department key ${key} is not a comuna 1-${COMUNA_COUNT}`);
    }
    if (name !== `Comuna ${n}` || !/^02\d{3}$/.test(code)) {
      throw new Error(`caba-comunas: department entry "${key}" is ${code} "${name}"`);
    }
    out.set(n, { number: n, departmentCode: code, departmentName: name });
  }
  if (out.size !== COMUNA_COUNT) {
    throw new Error(
      `caba-comunas: the reference lists ${out.size} of the ${COMUNA_COUNT} departments`,
    );
  }
  return out;
}

/**
 * Every catalogue barrio name -> its comuna. `catalogueNames` are the 48
 * canonical barrio names (scripts/caba-barrios-data.ts). Throws, naming every
 * problem at once, unless each source row matches exactly one catalogue name,
 * each catalogue name exactly one source row, and every comuna 1-15 has at
 * least one barrio.
 */
export function reconcileCabaComunas(
  catalogueNames: readonly string[],
): ReadonlyMap<string, CabaComuna> {
  const comunas = cabaComunas();
  const problems: string[] = [];
  const byFold = new Map<string, string>();
  for (const name of catalogueNames) {
    const key = fold(name);
    if (byFold.has(key)) problems.push(`catalogue names "${name}" twice`);
    byFold.set(key, name);
  }

  const out = new Map<string, CabaComuna>();
  for (const [sourceName, n] of REFERENCE.rows) {
    const comuna = comunas.get(n);
    if (!comuna) {
      problems.push(`source row "${sourceName}" names comuna ${n}`);
      continue;
    }
    const explicit = SOURCE_SPELLING[sourceName];
    const name = explicit ?? byFold.get(fold(sourceName));
    if (!name || !byFold.has(fold(name))) {
      problems.push(`source row "${sourceName}" matches no catalogue barrio`);
      continue;
    }
    if (out.has(name)) {
      problems.push(`catalogue barrio "${name}" matched twice`);
      continue;
    }
    out.set(name, comuna);
  }
  for (const name of catalogueNames) {
    if (!out.has(name)) problems.push(`catalogue barrio "${name}" has no source row`);
  }
  const used = new Set([...out.values()].map((c) => c.number));
  for (const n of comunas.keys()) {
    if (!used.has(n)) problems.push(`comuna ${n} has no barrio`);
  }
  if (problems.length > 0) {
    throw new Error(
      `caba-comunas: the official source and the catalogue disagree:\n  ${problems.join("\n  ")}`,
    );
  }
  return out;
}

#!/usr/bin/env tsx
/**
 * Locality alias generator — the names people use that the catalogue does not.
 *
 * WHY
 * ---------------------------------------------------------------------------
 * `ar_localities` is INDEC's list of LOCALIDADES CENSALES. In Gran Buenos Aires
 * INDEC models the conurbano as one composite locality with ONE component per
 * partido, so "Lomas de Zamora" is a row and Banfield, Temperley, San Justo,
 * Ramos Mejía, Castelar, Haedo, Bernal and Martínez are not. Testers typed the
 * name of where they live, got "no encontramos", and concluded the field was
 * broken.
 *
 * The same public Georef dataset that feeds the catalogue also publishes the
 * ASENTAMIENTOS (BAHRA entities, components and simple localities, plus rural
 * parajes), and every one that is part of a census locality carries that census
 * locality's id (`localidad_censal.id`) — the exact `indec_id` of a catalogue
 * row. That id is the whole mapping: no name matching, no geometry, no guess.
 *
 * WHAT IT WRITES
 * ---------------------------------------------------------------------------
 * lib/reference/locality-aliases.json — `[aliasName, targetIndecId]` pairs,
 * sorted, one per line. The search (lib/infra/locality-aliases.ts) offers each
 * one as "Banfield (Lomas de Zamora)" and SELECTS THE TARGET ROW: the stored
 * locality is always a catalogue row, so routing, scope and events never see an
 * alias. Aliases are SEARCH ONLY — never a name→locality resolution path.
 *
 * WHAT IT DROPS (P1: never confuse places — a dropped alias costs a person a few
 * more letters; a wrong one files their pet under another municipality)
 *   · no-census-locality  — the asentamiento belongs to no census locality (the
 *                           ~10k rural parajes). There is no row to point at.
 *   · target-not-in-catalogue — its census locality is not a catalogue row (CABA
 *                           comunas, which the importer supersedes by barrios).
 *   · same-as-target      — the name IS its census locality's name.
 *   · already-in-catalogue — a catalogue row in the same province has that name
 *                           (Olivos, Quilmes): the row itself already answers.
 *   · sources-disagree    — the BAHRA localidades endpoint and the asentamientos
 *                           download name different census localities for it.
 *   · shares-name-with-unmapped-place — a same-name place in the province has no
 *                           catalogue row to point at (a rural paraje): the
 *                           mapped one would be the only one offered, so neither is.
 *   · ambiguous           — the same name in one province points at two or more
 *                           census localities (Villa Adelina, Tortuguitas, Gerli).
 * The runtime re-checks the second and fourth against the LIVE catalogue, so a
 * catalogue update can only make an alias disappear, never point it elsewhere.
 *
 * SOURCES (public open data, datos.gob.ar — Servicio de Normalización de Datos
 * Geográficos, https://datosgobar.github.io/georef-ar-api/)
 *   --asentamientos=<path|url>  default https://infra.datos.gob.ar/georef/asentamientos.json
 *   --bahra=<path|url>          default https://apis.datos.gob.ar/georef/api/localidades?max=5000&formato=json&campos=completo
 *   --censales=<path|url>       default https://infra.datos.gob.ar/georef/localidades_censales.csv
 *                               (the importer's own source: scripts/import-indec-localities.ts)
 *
 * Run:
 *   pnpm tsx scripts/generate-locality-aliases.ts           # fetch, write, report
 *   pnpm tsx scripts/generate-locality-aliases.ts --check   # exit 1 if the file would change
 *
 * Idempotent: same inputs, byte-identical output (no timestamps in the file).
 * No database access — the catalogue side is the importer's CSV.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { parse } from "csv-parse/sync";

import { INDEC_PROV_TO_ISO } from "@/lib/infra/geo-join";
import { isSupersededByAltSource } from "@/lib/reference/locality-integrity";
import { localitySlug } from "@/lib/reference/locality-slug";

const DEFAULTS = {
  asentamientos: "https://infra.datos.gob.ar/georef/asentamientos.json",
  bahra: "https://apis.datos.gob.ar/georef/api/localidades?max=5000&formato=json&campos=completo",
  censales: "https://infra.datos.gob.ar/georef/localidades_censales.csv",
} as const;

const OUTPUT_PATH = join(
  import.meta.dirname ?? __dirname,
  "..",
  "lib",
  "reference",
  "locality-aliases.json",
);

/** One Georef asentamiento / BAHRA localidad, reduced to what the mapping reads. */
export type GeorefPlace = {
  nombre: string;
  categoria: string;
  provincia: { id: string };
  departamento: { id: string | null } | null;
  localidad_censal: { id: string | null } | null;
};

/** One catalogue row, as the importer's CSV ships it. */
export type CensusLocality = { id: string; nombre: string; provinciaId: string };

export type DropReason =
  | "no-census-locality"
  | "target-not-in-catalogue"
  | "same-as-target"
  | "already-in-catalogue"
  | "sources-disagree"
  | "shares-name-with-unmapped-place"
  | "ambiguous";

export type AliasBuild = {
  /** [aliasName, targetIndecId], sorted by target then alias. */
  aliases: Array<[string, string]>;
  dropped: Record<DropReason, number>;
  /** Distinct (province, name) considered — the denominator of the report. */
  considered: number;
};

type Candidate = { name: string; target: string | null; reason: DropReason | null };

type Lookups = {
  byId: Map<string, CensusLocality>;
  catalogueNames: Set<string>;
  bahraTarget: Map<string, Set<string>>;
};

function buildLookups(input: {
  bahra: readonly GeorefPlace[];
  censales: readonly CensusLocality[];
}): Lookups {
  // A census locality whose province the catalogue takes from another source is
  // not a catalogue row (CABA: the importer supersedes INDEC's comunas by the 48
  // barrios), so nothing may point at it.
  const live = input.censales.filter(
    (c) =>
      !isSupersededByAltSource({
        provinceCode: INDEC_PROV_TO_ISO[c.provinciaId] ?? "",
        source: "indec_cppdyl",
      }),
  );
  // BAHRA's view of each (province, department, name) → census locality, used
  // only to catch a disagreement between the two publications.
  const bahraTarget = new Map<string, Set<string>>();
  for (const p of input.bahra) {
    const key = `${p.provincia.id}|${p.departamento?.id ?? ""}|${localitySlug(p.nombre)}`;
    const set = bahraTarget.get(key) ?? new Set<string>();
    set.add(p.localidad_censal?.id ?? "");
    bahraTarget.set(key, set);
  }
  return {
    byId: new Map(live.map((c) => [c.id, c])),
    catalogueNames: new Set(
      input.censales.map((c) => `${c.provinciaId}|${localitySlug(c.nombre)}`),
    ),
    bahraTarget,
  };
}

/** Why one entry cannot be an alias, or null when it can. */
function classify(p: GeorefPlace, slug: string, l: Lookups): DropReason | null {
  const censal = p.localidad_censal?.id ?? null;
  if (!censal) return "no-census-locality";
  const target = l.byId.get(censal);
  if (!target) return "target-not-in-catalogue";
  if (localitySlug(target.nombre) === slug) return "same-as-target";
  if (l.catalogueNames.has(`${p.provincia.id}|${slug}`)) return "already-in-catalogue";
  const seen = l.bahraTarget.get(`${p.provincia.id}|${p.departamento?.id ?? ""}|${slug}`);
  if (seen && (seen.size !== 1 || !seen.has(censal))) return "sources-disagree";
  return null;
}

/** One (province, name) group → its alias, or the reason it is dropped whole. */
function settleGroup(candidates: Candidate[]): [string, string] | DropReason {
  const usable = candidates.filter((c) => c.reason === null);
  // Nothing usable: report the group under its most specific reason.
  if (usable.length === 0) return mostSpecific(candidates.map((c) => c.reason as DropReason));
  // A name that ALSO names an unsafe entry in the same province (a disagreement,
  // or the catalogue row itself) is not offered for any of its targets.
  const unsafe = candidates.find(
    (c) => c.reason === "sources-disagree" || c.reason === "already-in-catalogue",
  );
  if (unsafe) return unsafe.reason as DropReason;
  // A same-name place in this province that the catalogue cannot hold — a rural
  // paraje with no census locality, or one whose census locality is not a row.
  // Offering the mappable one ("San Justo (La Matanza)") would be the ONLY San
  // Justo a person from the unmapped one sees, and nothing on screen would tell
  // them it is not theirs. Conservative on purpose (P1): the name is dropped.
  if (
    candidates.some(
      (c) => c.reason === "no-census-locality" || c.reason === "target-not-in-catalogue",
    )
  ) {
    return "shares-name-with-unmapped-place";
  }
  // One name, two census localities in one province. Mostly a place that
  // straddles a partido line (Villa Adelina: San Isidro AND Vicente López;
  // Tortuguitas: three partidos), where the person typing it often does not
  // know which side they live on — offering both invites the wrong pick, and a
  // wrong pick files the pet under the other municipality. Dropped whole.
  const targets = [...new Set(usable.map((c) => c.target as string))];
  if (targets.length !== 1) return "ambiguous";
  return [usable[0].name, targets[0]];
}

/**
 * The pure mapping. Every drop is counted under exactly one reason, and a
 * (province, name) is dropped as a whole the moment any entry for it is unsafe —
 * never "keep the one that looks right".
 */
export function buildLocalityAliases(input: {
  asentamientos: readonly GeorefPlace[];
  bahra: readonly GeorefPlace[];
  censales: readonly CensusLocality[];
}): AliasBuild {
  const lookups = buildLookups(input);
  const dropped: Record<DropReason, number> = {
    "no-census-locality": 0,
    "target-not-in-catalogue": 0,
    "same-as-target": 0,
    "already-in-catalogue": 0,
    "sources-disagree": 0,
    "shares-name-with-unmapped-place": 0,
    ambiguous: 0,
  };

  // Group every entry by (province, name): the unit a person types.
  const groups = new Map<string, Candidate[]>();
  for (const p of input.asentamientos) {
    const slug = localitySlug(p.nombre);
    if (!slug) continue;
    const key = `${p.provincia.id}|${slug}`;
    const list = groups.get(key) ?? [];
    list.push({
      name: p.nombre.trim(),
      target: p.localidad_censal?.id ?? null,
      reason: classify(p, slug, lookups),
    });
    groups.set(key, list);
  }

  const out: Array<[string, string]> = [];
  for (const candidates of groups.values()) {
    const settled = settleGroup(candidates);
    if (typeof settled === "string") dropped[settled] += 1;
    else out.push(settled);
  }

  out.sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0], "es") : a[1] < b[1] ? -1 : 1));
  return { aliases: out, dropped, considered: groups.size };
}

const REASON_ORDER: DropReason[] = [
  "sources-disagree",
  "shares-name-with-unmapped-place",
  "ambiguous",
  "already-in-catalogue",
  "same-as-target",
  "target-not-in-catalogue",
  "no-census-locality",
];

function mostSpecific(reasons: DropReason[]): DropReason {
  for (const r of REASON_ORDER) if (reasons.includes(r)) return r;
  return "no-census-locality";
}

/** One pair per line — reviewable diffs, and the shape biome keeps as is. */
export function renderAliasFile(aliases: ReadonlyArray<[string, string]>): string {
  const lines = aliases.map(([n, id]) => `    ${JSON.stringify([n, id]).replace(",", ", ")}`);
  return `{\n  "aliases": [\n${lines.join(",\n")}\n  ]\n}\n`;
}

async function load(pathOrUrl: string): Promise<string> {
  if (/^https?:\/\//.test(pathOrUrl)) {
    const res = await fetch(pathOrUrl);
    if (!res.ok) throw new Error(`GET ${pathOrUrl} → ${res.status}`);
    return res.text();
  }
  return readFileSync(pathOrUrl, "utf8");
}

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

async function main(): Promise<void> {
  const [asentRaw, bahraRaw, censalesRaw] = await Promise.all([
    load(arg("asentamientos") ?? DEFAULTS.asentamientos),
    load(arg("bahra") ?? DEFAULTS.bahra),
    load(arg("censales") ?? DEFAULTS.censales),
  ]);
  const asentamientos = (JSON.parse(asentRaw) as { asentamientos: GeorefPlace[] }).asentamientos;
  const bahra = (JSON.parse(bahraRaw) as { localidades: GeorefPlace[] }).localidades;
  const censales = (
    parse(censalesRaw, { columns: true, skip_empty_lines: true }) as Array<Record<string, string>>
  ).map((r) => ({ id: r.id, nombre: r.nombre, provinciaId: r.provincia_id }));

  // A truncated download must not silently shrink the file.
  if (asentamientos.length < 10_000 || bahra.length < 3_000 || censales.length < 3_500) {
    throw new Error(
      `Refusing a partial source: ${asentamientos.length} asentamientos, ${bahra.length} BAHRA, ${censales.length} censales`,
    );
  }

  const build = buildLocalityAliases({ asentamientos, bahra, censales });
  const rendered = renderAliasFile(build.aliases);

  console.log(
    `sources: ${asentamientos.length} asentamientos, ${bahra.length} BAHRA localidades, ${censales.length} census localities`,
  );
  console.log(`(province, name) groups considered: ${build.considered}`);
  console.log(`aliases written: ${build.aliases.length}`);
  for (const [reason, n] of Object.entries(build.dropped)) console.log(`  dropped ${reason}: ${n}`);

  if (process.argv.includes("--check")) {
    const current = readFileSync(OUTPUT_PATH, "utf8");
    if (current !== rendered) {
      console.error("lib/reference/locality-aliases.json is stale — re-run the generator.");
      process.exit(1);
    }
    console.log("locality-aliases.json is current.");
    return;
  }
  writeFileSync(OUTPUT_PATH, rendered, "utf8");
  console.log(`wrote ${OUTPUT_PATH}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

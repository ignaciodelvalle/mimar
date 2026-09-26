#!/usr/bin/env tsx
/**
 * Local-government reference generator — which official local government
 * (municipio, comuna, comisión de fomento, …) governs each census locality.
 *
 * WHY
 * ---------------------------------------------------------------------------
 * The authority-unit seed (lib/place/authority-units-plan.ts) used to propose
 * one unit per INDEC department outside Buenos Aires. A department is not a
 * government there: Córdoba has 427 local governments in 26 departments, Santa
 * Fe 365 in 19. The official Georef datasets name the local government of each
 * locality (`gobierno_local_id` / `gobierno_local_nombre`, renamed from
 * `municipio_*` in Aug 2026), and that id is what a unit must be keyed by.
 *
 * The seed reads THIS committed file, never the network: a seed that depends
 * on datos.gob.ar being up would make db:bootstrap flaky, and a reviewed diff
 * of this file is how a change in the official data reaches the units.
 *
 * SOURCES (public open data, datos.gob.ar — Servicio de Normalización de Datos
 * Geográficos, https://datosgobar.github.io/georef-ar-api/)
 *   --censales=<path|url>   default https://infra.datos.gob.ar/georef/localidades_censales.csv
 *                           (the catalogue importer's own source)
 *   --bahra=<path|url>      default https://infra.datos.gob.ar/georef/localidades.csv
 *                           (BAHRA localities; each carries its census locality id)
 *   --gobiernos=<path|url>  default https://infra.datos.gob.ar/georef/gobiernos_locales.csv
 *
 * THE RULE (per census locality; no name matching, no geometry, no guess)
 *   The census CSV links only ~2,700 of ~4,000 localities to a local
 *   government, while the BAHRA localities file — same publisher, same
 *   Last-Modified — links almost all of them, on the SAME census id (or on
 *   components that carry it as `localidad_censal_id`). So the government of a
 *   census locality is the set of every government those official rows name:
 *     · exactly one           → that government;
 *     · two or more           → DISPUTED (sources-disagree when the census row
 *                               and its own BAHRA row differ, components-disagree
 *                               when its components straddle two governments);
 *     · none                  → no entry. The provincial unit covers it.
 *   When the census row names none, every component must name one: a locality
 *   only partly covered is DISPUTED (partially-covered), never completed.
 *   CABA is left out: its catalogue rows are the 48 barrios, and the whole city
 *   is ONE ciudad unit (its comunas are submunicipal).
 *
 * WHAT IT WRITES
 * ---------------------------------------------------------------------------
 * lib/reference/locality-gobierno-local.json — one entry per line, sorted:
 *   governments: gobierno_local_id → [province ISO code, category, name]
 *                (only governments some locality points at)
 *   localities:  census locality id (ar_localities.indec_id) → gobierno_local_id
 *   disputed:    census locality id → why it has no government
 *
 * Run:
 *   pnpm tsx scripts/generate-locality-gobierno-local.ts          # fetch, write, report
 *   pnpm tsx scripts/generate-locality-gobierno-local.ts --check  # exit 1 if the file would change
 *
 * Idempotent: same inputs, byte-identical output (no timestamps in the file).
 * No database access.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { parse } from "csv-parse/sync";

import { INDEC_PROV_TO_ISO } from "@/lib/infra/geo-join";
import {
  type DisputeReason,
  LOCAL_GOVERNMENT_CATEGORIES,
  type LocalGovernmentCategory,
} from "@/lib/place/authority-units-plan";
import { isSupersededByAltSource } from "@/lib/reference/locality-integrity";

const DEFAULTS = {
  censales: "https://infra.datos.gob.ar/georef/localidades_censales.csv",
  bahra: "https://infra.datos.gob.ar/georef/localidades.csv",
  gobiernos: "https://infra.datos.gob.ar/georef/gobiernos_locales.csv",
} as const;

const OUTPUT_PATH = join(
  import.meta.dirname ?? __dirname,
  "..",
  "lib",
  "reference",
  "locality-gobierno-local.json",
);

/** One census locality row (localidades_censales.csv). */
export type CensusRow = {
  id: string;
  provinciaId: string;
  gobiernoLocalId: string;
};

/** One BAHRA locality row (localidades.csv). */
export type BahraRow = {
  id: string;
  localidadCensalId: string;
  gobiernoLocalId: string;
};

/** One local government (gobiernos_locales.csv). */
export type GovernmentRow = {
  id: string;
  provinciaId: string;
  categoria: string;
  nombre: string;
};

export type GobiernoLocalBuild = {
  governments: Record<string, [string, LocalGovernmentCategory, string]>;
  localities: Record<string, string>;
  disputed: Record<string, DisputeReason>;
};

/**
 * The publisher spells one Jujuy category with a grave accent
 * ("Comisiòn Municipal") — a typo of "Comisión Municipal", fixed here so the
 * category list stays closed. Any OTHER unknown category throws: a new kind of
 * local government is a decision for a person, not for this script.
 */
export function normaliseCategory(raw: string): LocalGovernmentCategory {
  const c = raw.normalize("NFC").trim().replace("Comisiòn", "Comisión");
  if ((LOCAL_GOVERNMENT_CATEGORIES as readonly string[]).includes(c)) {
    return c as LocalGovernmentCategory;
  }
  throw new Error(`Unknown local government category "${raw}": map it in authority-units-plan`);
}

/** Every BAHRA row that speaks for a census locality: its own row (same id) and its components. */
function indexBahra(bahra: readonly BahraRow[]): Map<string, BahraRow[]> {
  const bahraFor = new Map<string, BahraRow[]>();
  for (const b of bahra) {
    for (const key of new Set([b.id, b.localidadCensalId])) {
      if (!key) continue;
      const list = bahraFor.get(key) ?? [];
      list.push(b);
      bahraFor.set(key, list);
    }
  }
  return bahraFor;
}

/** The government of one census locality, why it has none, or null when nobody names one. */
function resolveOne(
  c: CensusRow,
  provinceCode: string,
  rows: readonly BahraRow[],
  govById: ReadonlyMap<string, GovernmentRow>,
): { gid: string } | { reason: DisputeReason } | null {
  const named = new Set<string>();
  if (c.gobiernoLocalId) named.add(c.gobiernoLocalId);
  for (const r of rows) if (r.gobiernoLocalId) named.add(r.gobiernoLocalId);
  if (named.size === 0) return null;

  const own = rows.find((r) => r.id === c.id);
  if (c.gobiernoLocalId && own?.gobiernoLocalId && own.gobiernoLocalId !== c.gobiernoLocalId) {
    return { reason: "sources-disagree" };
  }
  if (named.size > 1) return { reason: "components-disagree" };
  if (!c.gobiernoLocalId && rows.some((r) => !r.gobiernoLocalId)) {
    return { reason: "partially-covered" };
  }
  const gid = [...named][0] as string;
  const gov = govById.get(gid);
  // A government the publisher does not list, or one of another province:
  // pointing a locality at it would cross a province line.
  if (!gov || INDEC_PROV_TO_ISO[gov.provinciaId] !== provinceCode) {
    return { reason: "government-outside-province" };
  }
  return { gid };
}

export function buildGobiernoLocal(input: {
  censales: readonly CensusRow[];
  bahra: readonly BahraRow[];
  gobiernos: readonly GovernmentRow[];
}): GobiernoLocalBuild {
  const govById = new Map(input.gobiernos.map((g) => [g.id, g]));
  const bahraFor = indexBahra(input.bahra);
  const localities: Record<string, string> = {};
  const disputed: Record<string, DisputeReason> = {};
  const used = new Set<string>();

  for (const c of [...input.censales].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const provinceCode = INDEC_PROV_TO_ISO[c.provinciaId];
    if (!provinceCode) continue;
    if (isSupersededByAltSource({ provinceCode, source: "indec_cppdyl" })) continue;
    const resolved = resolveOne(c, provinceCode, bahraFor.get(c.id) ?? [], govById);
    if (!resolved) continue;
    if ("reason" in resolved) {
      disputed[c.id] = resolved.reason;
      continue;
    }
    localities[c.id] = resolved.gid;
    used.add(resolved.gid);
  }

  const governments: GobiernoLocalBuild["governments"] = {};
  for (const id of [...used].sort()) {
    const g = govById.get(id) as GovernmentRow;
    governments[id] = [
      INDEC_PROV_TO_ISO[g.provinciaId] as string,
      normaliseCategory(g.categoria),
      g.nombre.normalize("NFC").trim(),
    ];
  }
  return { governments, localities, disputed };
}

/** One entry per line — reviewable diffs, and the shape biome keeps as is. */
export function renderGobiernoLocalFile(build: GobiernoLocalBuild): string {
  const block = (entries: Array<[string, unknown]>) =>
    entries
      .map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v).replace(/","/g, '", "')}`)
      .join(",\n");
  const sorted = <T>(o: Record<string, T>) =>
    Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{\n  "governments": {\n${block(sorted(build.governments))}\n  },\n  "localities": {\n${block(sorted(build.localities))}\n  },\n  "disputed": {\n${block(sorted(build.disputed))}\n  }\n}\n`;
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

function csv(raw: string): Array<Record<string, string>> {
  return parse(raw, { columns: true, skip_empty_lines: true, bom: true }) as Array<
    Record<string, string>
  >;
}

async function main(): Promise<void> {
  const [censalesRaw, bahraRaw, gobiernosRaw] = await Promise.all([
    load(arg("censales") ?? DEFAULTS.censales),
    load(arg("bahra") ?? DEFAULTS.bahra),
    load(arg("gobiernos") ?? DEFAULTS.gobiernos),
  ]);
  const censales = csv(censalesRaw).map((r) => ({
    id: r.id ?? "",
    provinciaId: r.provincia_id ?? "",
    gobiernoLocalId: r.gobierno_local_id ?? "",
  }));
  const bahra = csv(bahraRaw).map((r) => ({
    id: r.id ?? "",
    localidadCensalId: r.localidad_censal_id ?? "",
    gobiernoLocalId: r.gobierno_local_id ?? "",
  }));
  const gobiernos = csv(gobiernosRaw).map((r) => ({
    id: r.id ?? "",
    provinciaId: r.provincia_id ?? "",
    categoria: r.categoria ?? "",
    nombre: r.nombre ?? "",
  }));

  // A truncated download must not silently shrink the file.
  if (censales.length < 3_500 || bahra.length < 3_500 || gobiernos.length < 2_000) {
    throw new Error(
      `Refusing a partial source: ${censales.length} censales, ${bahra.length} BAHRA, ${gobiernos.length} gobiernos locales`,
    );
  }

  const build = buildGobiernoLocal({ censales, bahra, gobiernos });
  const rendered = renderGobiernoLocalFile(build);

  console.log(
    `sources: ${censales.length} census localities, ${bahra.length} BAHRA localities, ${gobiernos.length} local governments`,
  );
  console.log(
    `localities with a government: ${Object.keys(build.localities).length}; governments referenced: ${Object.keys(build.governments).length}; disputed: ${Object.keys(build.disputed).length}`,
  );

  if (process.argv.includes("--check")) {
    const current = readFileSync(OUTPUT_PATH, "utf8");
    if (current !== rendered) {
      console.error("lib/reference/locality-gobierno-local.json is stale — re-run the generator.");
      process.exit(1);
    }
    console.log("locality-gobierno-local.json is current.");
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

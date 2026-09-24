// Regenerate `public/geo/ar-departments.geojson` — the departamento polygons the
// Panorama locality choropleth draws when a single province is scoped
// (components/panorama/SituationalMap.tsx → division-fill.ts).
//
// WHY THIS EXISTS
// ----------------
// The file shipped originally was simplified so aggressively that coastal AMBA
// partidos collapsed into quadrilaterals — Avellaneda (06035) was a literal
// 4-point triangle spilling across the Río de la Plata, San Isidro (06756) the
// same. At operational (locality) zoom over AMBA this rendered as a giant orange
// spike over the water. Root cause was SOURCE-GEOMETRY COARSENESS (per-feature
// Douglas–Peucker at a huge tolerance), not a winding/projection/render bug.
//
// SOURCE (official, open licence)
// -------------------------------
// Georef — Servicio de Normalización de Datos Geográficos de Argentina
// (JGM / datos.gob.ar). The "base completa" NDJSON carries FULL-resolution IGN
// geometry plus INDEC 5-digit codes:
//
//   https://infra.datos.gob.ar/georef/departamentos.ndjson   (~76 MB, IGN, v12.1.0+)
//
// Licence: open (datos.gob.ar). Provenance: INDEC + IGN.
// NOTE: the sibling `.geojson` endpoint serves georef's own SIMPLIFIED geometry
// (Avellaneda is still a quad there) — do NOT use it. Only the NDJSON base dump
// is full resolution.
//
// PROPERTY MAPPING
// ----------------
// Source record: { id: "06035", nombre: "Avellaneda", geometria: {…}, … }
// Our contract (lib/infra/geo-join.ts): { code: <INDEC 5-digit>, name }.
//   id → code (already 5-digit INDEC), nombre → name.
//
// FILTERING (keeps parity with the historical 513-feature set)
// ------------------------------------------------------------
//   - Drop "94028" (Antártida Argentina): its polygon extends to the South Pole
//     (lat −90); it is not an operational department and the original file
//     excluded it. Including it paints a continent-sized blob.
//   - Drop "02xxx" (the 15 CABA comunas): CABA (AR-C) drills to BARRIOS, not
//     departamentos (division-fill.ts), so the departamentos file intentionally
//     carries no CABA feature. → 529 − 1 − 15 = 513 features, exactly the codes
//     the previous file shipped.
//
// SIMPLIFICATION (topology-aware, reproducible)
// ---------------------------------------------
// mapshaper (Visvalingam, `keep-shapes`, `-clean`) at 4 %. Topology-aware simplify
// shares boundaries between neighbouring partidos so they don't gap/overlap the
// way per-feature turf simplify would. 4 % holds the full file at ~2.2 MB (target
// ≤ 2.5 MB; the file is fetched once client-side, then filtered per province) while
// restoring the AMBA coastline (Avellaneda 5 → ~20 vertices). Precision is rounded
// to 4 decimals (~11 m) — ample for a choropleth, and a big size win.
//
// USAGE
//   pnpm tsx scripts/prep-geo-departments.ts                 # download + build
//   pnpm tsx scripts/prep-geo-departments.ts --source <path> # reuse a local NDJSON
//   pnpm tsx scripts/prep-geo-departments.ts --keep <n>      # override simplify %
//
// Requires `npx mapshaper` (auto-fetched by npx if not installed). Deterministic:
// same source + same flags → same output.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SOURCE_URL = "https://infra.datos.gob.ar/georef/departamentos.ndjson";
const OUT_PATH = join(process.cwd(), "public", "geo", "ar-departments.geojson");
const DEFAULT_KEEP_PCT = 4;

type Georef = { id?: string; nombre?: string; geometria?: GeoJSON.Geometry };

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** True for a code we intentionally exclude to preserve the 513-feature parity. */
function isExcluded(code: string): boolean {
  return code === "94028" || code.startsWith("02");
}

async function loadSourceNdjson(): Promise<string> {
  const local = arg("--source");
  if (local) {
    console.log(`Reading source NDJSON from ${local}`);
    return readFileSync(local, "utf8");
  }
  console.log(`Downloading source NDJSON: ${SOURCE_URL}`);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`Source download failed: HTTP ${res.status}`);
  return await res.text();
}

/** NDJSON → filtered full-resolution FeatureCollection with our {code,name} schema. */
function buildFeatureCollection(ndjson: string): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  let excluded = 0;
  for (const line of ndjson.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const rec = JSON.parse(trimmed) as Georef;
    if (!rec.id || !rec.geometria) continue; // skip the NDJSON metadata header line
    const code = String(rec.id);
    if (isExcluded(code)) {
      excluded += 1;
      continue;
    }
    features.push({
      type: "Feature",
      properties: { code, name: rec.nombre ?? "" },
      geometry: rec.geometria,
    });
  }
  console.log(
    `Parsed ${features.length} departamentos (excluded ${excluded}: Antártida + CABA comunas)`,
  );
  return { type: "FeatureCollection", features };
}

/** Topology-aware simplify via mapshaper. Returns the simplified GeoJSON string. */
function simplify(fc: GeoJSON.FeatureCollection, keepPct: number): string {
  const work = mkdtempSync(join(tmpdir(), "geo-prep-"));
  const inPath = join(work, "in.geojson");
  const outPath = join(work, "out.geojson");
  writeFileSync(inPath, JSON.stringify(fc));
  try {
    const mapshaperArgs = [
      inPath,
      "-simplify",
      `${keepPct}%`,
      "keep-shapes",
      "visvalingam",
      "-clean",
      "-o",
      "precision=0.0001",
      "format=geojson",
      outPath,
    ];
    // Prefer a locally-installed mapshaper; otherwise let npx fetch it.
    const runner = resolveMapshaper();
    execFileSync(runner.cmd, [...runner.prefix, ...mapshaperArgs], { stdio: "inherit" });
    return readFileSync(outPath, "utf8");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function resolveMapshaper(): { cmd: string; prefix: string[] } {
  const localBin = join(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? "mapshaper.cmd" : "mapshaper",
  );
  if (existsSync(localBin)) return { cmd: localBin, prefix: [] };
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  return { cmd: npx, prefix: ["--yes", "mapshaper@0.6.111"] };
}

async function main(): Promise<void> {
  const keepPct = Number(arg("--keep") ?? DEFAULT_KEEP_PCT);
  const ndjson = await loadSourceNdjson();
  const fc = buildFeatureCollection(ndjson);
  const simplified = simplify(fc, keepPct);

  // Sanity-check the mapshaper output before we overwrite the shipped file.
  const parsed = JSON.parse(simplified) as GeoJSON.FeatureCollection;
  const codes = new Set(
    parsed.features.map((f) => String((f.properties as { code?: string })?.code ?? "")),
  );
  const prefixes = new Set([...codes].map((c) => c.slice(0, 2)));
  if (parsed.features.length !== fc.features.length) {
    throw new Error(
      `Feature count changed during simplify: ${fc.features.length} → ${parsed.features.length}`,
    );
  }
  writeFileSync(OUT_PATH, simplified);
  const bytes = Buffer.byteLength(simplified);
  console.log(
    `Wrote ${OUT_PATH}\n  features: ${parsed.features.length}  province prefixes: ${prefixes.size}  size: ${(bytes / 1e6).toFixed(2)} MB`,
  );
}

const calledDirectly = process.argv[1]?.endsWith("prep-geo-departments.ts");
if (calledDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

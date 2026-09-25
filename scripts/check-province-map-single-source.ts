// Province map single-source fence (localidades-por-id B2, audit R12).
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// "Which ISO code is this province name?" had several hand-written answers:
// two TypeScript maps in the panorama and dashboard code (plus a demo page), a
// CASE or VALUES list re-typed in six migrations, and the catalogue itself. They agreed on the day each was
// written, and nothing kept them agreeing. A place is about to be keyed by
// catalogue id with a province CODE next to it (scope, RLS and routing all
// compare codes from stage D), so a divergent copy stops being a cosmetic bug
// and becomes a row that one reader puts in Córdoba and another in nowhere.
//
// There is ONE list: `PROVINCES` in packages/contract/src/reference/provinces.ts
// (re-exported by lib/reference/ar-provincias.ts). SQL reads the same answer
// through `public.ar_province_code(name)` / `public.ar_province_name(code)`
// (migration 0249), whose bodies are compared with `PROVINCES` by
// __tests__/province-map-single-source.test.ts. Everything else DERIVES.
//
// WHAT COUNTS
//   A "pair line": a line (comments stripped) that holds a canonical province
//   name AND a quoted ISO code (`"AR-X"` / `'AR-X'`). A file with
//   MAP_THRESHOLD or more pair lines is a hand-written map. Scanned: the
//   TypeScript/JavaScript/SQL sources of the app, the packages, the scripts and
//   db/, never tests (a fixture may spell a province out on purpose).
//
//   The allowed maps are frozen with their exact count: the one source list,
//   migration 0249's two functions (the SQL face of that list, parity-tested),
//   and the migrations that re-typed it before this fence existed — immutable,
//   so they cannot be fixed in place.
//
// Run:  pnpm tsx scripts/check-province-map-single-source.ts   (or: pnpm lint:province-map)
// Exits 1 on a map outside the frozen list, on a frozen count that moved, or
// when the scan finds fewer pair lines than the floor (a broken scanner).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { PROVINCES } from "@/lib/reference/ar-provincias";

/** Pair lines at or above which a file is a hand-written province map. */
export const MAP_THRESHOLD = 3;

/**
 * Every file allowed to spell the map out, with its exact number of pair
 * lines. Never add an entry to make a new file pass: derive from `PROVINCES`
 * (TypeScript) or call `public.ar_province_code` (SQL).
 */
export const FROZEN_PROVINCE_MAPS: Readonly<Record<string, number>> = {
  // THE list.
  "packages/contract/src/reference/provinces.ts": 24,
  // Its SQL face (two functions × 24), parity-tested against the list.
  "db/migrations/0249_province_code_fns.sql": 48,
  // History: re-typed before this fence, immutable. Measured 2026-09-25.
  "db/migrations/0055_jurisdiction_province_canonical.sql": 24,
  "db/migrations/0060_ref_senasa_vocabularies.sql": 4,
  "db/migrations/0117_govt_assignments_locality_canonical.sql": 24,
  "db/migrations/0237_pets_locality_canonical.sql": 24,
  "db/migrations/0239_staging_schema_repair.sql": 4,
  // Three pairs per VALUES line.
  "db/migrations/0246_govt_assignments_locality_id.sql": 9,
};

/** Non-vacuity floor: the sum of the frozen list. A broken regex reads 0. */
export const MIN_PAIR_LINES = Object.values(FROZEN_PROVINCE_MAPS).reduce((a, b) => a + b, 0);

const CODE = /["']AR-[A-Z]["']/;
const NAMES = PROVINCES.map((p) => p.name);
// A name as a whole token: not preceded or followed by a letter (so "Chaco"
// inside "Chacomar" is not one, and "Buenos Aires" inside "CABA" never is).
const NAME = new RegExp(
  `(?<![\\p{L}])(?:${NAMES.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\p{L}])`,
  "u",
);

/**
 * Strip comments, keeping line breaks: block comments always, then `--` line
 * comments in SQL and `//` line comments elsewhere (`i--` is not a comment).
 */
export function stripComments(source: string, sql: boolean): string {
  const noBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return sql ? noBlocks.replace(/--[^\n]*/g, "") : noBlocks.replace(/(^|[^:"'])\/\/[^\n]*/g, "$1");
}

/** How many lines of `source` pair a canonical province name with an ISO code. */
export function countPairLines(source: string, sql = false): number {
  return stripComments(source, sql)
    .split("\n")
    .filter((line) => CODE.test(line) && NAME.test(line)).length;
}

export type SourceFile = { file: string; source: string };

export function evaluate(files: readonly SourceFile[]): {
  violations: Array<{ file: string; lines: number; frozen: number }>;
  total: number;
} {
  const violations: Array<{ file: string; lines: number; frozen: number }> = [];
  const seen = new Set<string>();
  let total = 0;
  for (const { file, source } of files) {
    const lines = countPairLines(source, file.endsWith(".sql"));
    total += lines;
    seen.add(file);
    const frozen = FROZEN_PROVINCE_MAPS[file];
    if (frozen !== undefined) {
      if (lines !== frozen) violations.push({ file, lines, frozen });
    } else if (lines >= MAP_THRESHOLD) {
      violations.push({ file, lines, frozen: 0 });
    }
  }
  for (const [file, frozen] of Object.entries(FROZEN_PROVINCE_MAPS)) {
    if (!seen.has(file)) violations.push({ file, lines: 0, frozen });
  }
  return { violations, total };
}

const ROOTS = ["app", "components", "lib", "src", "scripts", "packages", "apps", "db"];
const SKIP_DIRS = new Set(["node_modules", "__tests__", ".next", "dist", "build", ".expo"]);
const EXTENSIONS = /\.(ts|tsx|mts|cts|js|mjs|sql)$/;
const TEST_FILE = /\.(test|spec)\.[a-z]+$/;

export function readSources(root = "."): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (EXTENSIONS.test(entry) && !TEST_FILE.test(entry)) {
        out.push({
          file: relative(root, path).split(sep).join("/"),
          source: readFileSync(path, "utf8"),
        });
      }
    }
  };
  for (const r of ROOTS) walk(join(root, r));
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

function main(): void {
  const files = readSources();
  const { violations, total } = evaluate(files);

  if (total < MIN_PAIR_LINES) {
    console.error(
      `\n✗ only ${total} province name/code pair line(s) seen across ${files.length} files (floor ${MIN_PAIR_LINES}). The scanner is broken, not the code.`,
    );
    process.exit(1);
  }
  if (violations.length > 0) {
    console.error("\n✗ a hand-written province name → code map outside the frozen list:");
    for (const v of violations) {
      console.error(`  ${v.file}: ${v.lines} pair line(s), frozen at ${v.frozen}`);
    }
    console.error(
      "\n  One list: derive from PROVINCES (lib/reference/ar-provincias.ts) in TypeScript, call public.ar_province_code / public.ar_province_name in SQL. A frozen count that moved means that file changed: re-measure it.",
    );
    process.exit(1);
  }
  console.log(
    `✓ province map single-source fence clean — ${files.length} files, ${total} pair line(s) in ${Object.keys(FROZEN_PROVINCE_MAPS).length} frozen file(s), no other map.`,
  );
}

if (process.argv[1]?.includes("check-province-map-single-source")) {
  main();
}

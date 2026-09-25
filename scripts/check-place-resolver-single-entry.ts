// Place resolver single-entry fence (localidades-por-id B3).
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// "Which catalogue row does this (province, NAME) pair mean?" used to be asked
// in a dozen places with a dozen answers. The worst of them, `localityByName`,
// settles a name two municipalities share by taking the alphabetically first
// department — Mechita (Bragado) filed as Mechita (Alberti) — and every caller
// that reached for it inherited the defect without knowing it existed (P1:
// never confuse places).
//
// There is now ONE resolver, lib/place/resolve-place.ts: an explicit id, then a
// name only when it names one row, then a corroborated pin, else UNRESOLVED —
// with the homonyms or nearby rows as candidates, never one chosen. The
// name→row lookups themselves live in lib/infra/ar-localidades.ts and
// lib/infra/jurisdiction-validation.ts; lib/place/ composes them.
//
// This fence stops the number of OTHER callers from growing. The ones that
// exist today are frozen file by file with their exact count; stage E of
// localidades-por-id drives the list to zero. A new caller resolves through
// lib/place/, or does not resolve names at all.
//
// WHAT COUNTS
//   A line (comments stripped) that CALLS one of LOOKUPS — not its definition,
//   not an import. Scanned: app, components, lib, src, scripts (TypeScript,
//   never tests). Exempt: lib/place/ and the two modules that define the
//   lookups.
//
// Run:  pnpm tsx scripts/check-place-resolver-single-entry.ts   (or: pnpm lint:place-resolver)
// Exits 1 on a caller outside the frozen list, on a frozen count that moved
// (lower the entry when a caller is fixed), or below the floor.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Name→row lookups: a (province, name) pair in, catalogue row(s) out. */
export const LOOKUPS = [
  "localityByName",
  "localitiesByName",
  "resolveCanonicalJurisdiction",
  "resolveUniqueJurisdiction",
  "tryResolveCanonicalJurisdiction",
  "isCanonicalLocality",
] as const;

/** Where the lookups are defined, and where they are composed on purpose. */
export const EXEMPT = [
  "lib/place/",
  "lib/infra/ar-localidades.ts",
  "lib/infra/jurisdiction-validation.ts",
] as const;

/**
 * Every other caller, with its exact number of call lines, measured
 * 2026-09-25. Never add an entry to make a new file pass.
 */
export const FROZEN_CALLERS: Readonly<Record<string, number>> = {
  "app/api/panorama/rule-changes/route.ts": 1,
  "app/gob/panorama/page.tsx": 1,
  "lib/analytics/jurisdiction-scope.ts": 1,
  // The write gate: `normalizeLocationForWrite` (strict and soft).
  "lib/domain/location-normalize.ts": 2,
  // D.11 recovery from free text: province first, a name only when unique.
  "lib/infra/jurisdiction-from-text.ts": 2,
  "lib/infra/public-listing-metadata.ts": 1,
  "lib/outreach/pilot-request.ts": 1,
  // The R7 repair reproduces the deleted backfill's guess to RECOGNISE it
  // (its fingerprint), never to write it.
  "scripts/place-repair-homonym-ids.ts": 1,
  "scripts/seed-demo-scenario.ts": 1,
  "scripts/seed-demo-spine.ts": 1,
  "scripts/seed-demo.ts": 1,
  "scripts/seed-panorama.ts": 1,
  "scripts/seed-test-users.ts": 1,
  "scripts/seed-turnos-testers.ts": 1,
  "src/modules/panorama/application/resolve-request-scope.ts": 1,
};

/** Non-vacuity floor: the sum of the frozen list. A broken regex reads 0. */
export const MIN_CALLS = Object.values(FROZEN_CALLERS).reduce((a, b) => a + b, 0);

const CALL = new RegExp(`\\b(?:${LOOKUPS.join("|")})\\s*\\(`);
const DEFINITION = new RegExp(`\\bfunction\\s+(?:${LOOKUPS.join("|")})\\b`);

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'])\/\/[^\n]*/g, "$1");
}

/** How many lines of `source` call a name→row lookup (definitions excluded). */
export function countCalls(source: string): number {
  return stripComments(source)
    .split("\n")
    .filter((line) => CALL.test(line) && !DEFINITION.test(line)).length;
}

export type SourceFile = { file: string; source: string };

export function isExempt(file: string): boolean {
  return EXEMPT.some((e) => (e.endsWith("/") ? file.startsWith(e) : file === e));
}

export function evaluate(files: readonly SourceFile[]): {
  violations: Array<{ file: string; calls: number; frozen: number }>;
  total: number;
} {
  const violations: Array<{ file: string; calls: number; frozen: number }> = [];
  const seen = new Set<string>();
  let total = 0;
  for (const { file, source } of files) {
    if (isExempt(file)) continue;
    const calls = countCalls(source);
    seen.add(file);
    total += calls;
    const frozen = FROZEN_CALLERS[file] ?? 0;
    if (calls !== frozen) violations.push({ file, calls, frozen });
  }
  for (const [file, frozen] of Object.entries(FROZEN_CALLERS)) {
    if (!seen.has(file)) violations.push({ file, calls: 0, frozen });
  }
  return { violations, total };
}

const ROOTS = ["app", "components", "lib", "src", "scripts"];
const SKIP_DIRS = new Set(["node_modules", "__tests__", ".next"]);
const EXTENSIONS = /\.(ts|tsx)$/;
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

  if (total < MIN_CALLS) {
    console.error(
      `\n✗ only ${total} name→row lookup call(s) seen across ${files.length} files (floor ${MIN_CALLS}). The scanner is broken, not the code.`,
    );
    process.exit(1);
  }
  if (violations.length > 0) {
    console.error("\n✗ a name→catalogue-row lookup called outside lib/place/:");
    for (const v of violations) {
      console.error(`  ${v.file}: ${v.calls} call line(s), frozen at ${v.frozen}`);
    }
    console.error(
      "\n  Resolve places through lib/place/resolve-place.ts (resolvePlace / resolveName): an id first, a name only when it names one row, never the first homonym. A frozen count that dropped means a caller was fixed: lower the entry.",
    );
    process.exit(1);
  }
  console.log(
    `✓ place resolver single-entry fence clean — ${files.length} files, ${total} frozen call line(s) in ${Object.keys(FROZEN_CALLERS).length} file(s), none new.`,
  );
}

if (process.argv[1]?.includes("check-place-resolver-single-entry")) {
  main();
}

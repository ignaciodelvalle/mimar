// Hardcoded-UUID ratchet — CI guard (environment-coupling burn-down).
//
// WHY THIS EXISTS
// ----------------
// A UUID literal in product source is almost always a row ID copied out of ONE
// database — a seed account, a locality row, a rule ID from the developer's
// local stack. Code carrying such an ID silently couples itself to that
// environment: it works locally, then misbehaves on staging/production where
// the row has a different ID (or none). IDs must arrive via queries, env
// config, or function parameters — never as source literals.
//
// Rule: any occurrence of the UUID-prefix shape /[0-9a-f]{8}-[0-9a-f]{4}-/i in
// a source file under app/, components/, lib/, src/ fails unless the file is
// grandfathered in the baseline at >= that count. Tests, fixtures, and DB
// migrations are exempt (a migration pinning a known row, or a test pinning a
// deterministic fixture ID, is the legitimate use of a literal ID).
//
// Enforcement: ratchet with a per-file baseline (check-file-size.ts style).
// Baseline: scripts/uuid-literals-baseline.json — regenerate with
//   pnpm tsx scripts/check-uuid-literals.ts --write-baseline
//
// FAIL-CLOSED: an empty scan (glob found no files) is an error, not a pass.
//
// Run: pnpm tsx scripts/check-uuid-literals.ts   (or: pnpm lint:uuid)
// Exits 0 when clean; exits 1 listing each offending file:line.

import { globSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Anchor to the repo root (this file lives at <root>/scripts/).
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const BASELINE_PATH = resolve(ROOT, "scripts/uuid-literals-baseline.json");

const SOURCE_GLOB = "{app,components,lib,packages,src}/**/*.{ts,tsx}";

/** UUID prefix — two hyphen-delimited hex groups is enough to identify the
 *  shape without false-negativing on truncated/partial literals. */
export const UUID_LITERAL_RE = /[0-9a-f]{8}-[0-9a-f]{4}-/gi;

const EXEMPT_SUFFIXES = [".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx", ".d.ts"];
const EXEMPT_PATH_PARTS = ["__tests__/", "__fixtures__/", "__mocks__/", "/migrations/"];

type BaselineFile = {
  _meta: { generatedAt: string; description: string };
  files: Record<string, number>;
};

export type UuidHit = { line: number; snippet: string };

/** Count UUID-literal occurrences in a file's source, with line numbers.
 * CRLF-safe; comment lines are NOT exempt — a commented-out hardcoded ID is
 * one uncomment away from coming back. */
export function findUuidLiterals(src: string): UuidHit[] {
  const hits: UuidHit[] = [];
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    for (const match of lines[i].matchAll(UUID_LITERAL_RE)) {
      const start = Math.max(0, (match.index ?? 0) - 10);
      hits.push({ line: i + 1, snippet: lines[i].slice(start, (match.index ?? 0) + 25).trim() });
    }
  }
  return hits;
}

export function isExempt(relPath: string): boolean {
  return (
    EXEMPT_SUFFIXES.some((s) => relPath.endsWith(s)) ||
    EXEMPT_PATH_PARTS.some((p) => relPath.includes(p))
  );
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

function collectFiles(): string[] {
  const files = globSync(SOURCE_GLOB, { cwd: ROOT })
    .map((f) => f.replaceAll("\\", "/"))
    .filter((f) => !f.includes("node_modules/"))
    .filter((f) => !isExempt(f))
    .sort();
  if (files.length === 0) {
    // FAIL CLOSED: an empty glob must never read as "no violations".
    console.error(`✗ check-uuid-literals: no files matched ${SOURCE_GLOB} under ${ROOT}.`);
    process.exit(1);
  }
  return files;
}

function measure(files: string[]): Map<string, UuidHit[]> {
  const byFile = new Map<string, UuidHit[]>();
  for (const rel of files) {
    const hits = findUuidLiterals(readFileSync(resolve(ROOT, rel), "utf8"));
    if (hits.length > 0) byFile.set(rel, hits);
  }
  return byFile;
}

function loadBaseline(): Record<string, number> {
  try {
    return (JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as BaselineFile).files;
  } catch {
    console.warn(
      `[warn] ${BASELINE_PATH} not found — every UUID literal will fail. Regenerate with: pnpm tsx scripts/check-uuid-literals.ts --write-baseline`,
    );
    return {};
  }
}

function writeBaseline(byFile: Map<string, UuidHit[]>): void {
  const baseline: BaselineFile = {
    _meta: {
      generatedAt: new Date().toISOString().slice(0, 10),
      description:
        "Files with hardcoded UUID literals, grandfathered at the recorded count. New files, or counts above baseline, fail lint:uuid — hardcoded IDs couple code to one environment's rows. Curing a file lets its entry be removed; the ratchet only tightens.",
    },
    files: Object.fromEntries([...byFile].map(([file, hits]) => [file, hits.length])),
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`✓ Wrote ${byFile.size} file(s) to ${BASELINE_PATH}.`);
}

function runChecks(): void {
  const byFile = measure(collectFiles());
  const baseline = loadBaseline();
  let failures = 0;
  let grandfathered = 0;

  for (const [file, hits] of byFile) {
    const allowed = baseline[file] ?? 0;
    if (hits.length > allowed) {
      failures += 1;
      for (const h of hits) {
        console.error(
          `${file}:${h.line} hardcoded UUID literal ("…${h.snippet}…", baseline allows ${allowed}) — IDs are environment-coupled; look the row up by a stable key, take the ID as a parameter, or read it from config.`,
        );
      }
    } else {
      grandfathered += hits.length;
    }
  }

  const stale = Object.keys(baseline).filter((f) => !byFile.has(f));
  if (stale.length > 0) {
    console.warn(
      `[info] ${stale.length} baselined file(s) no longer carry UUID literals — remove from ${BASELINE_PATH} to tighten the ratchet: ${stale.join(", ")}`,
    );
  }

  if (failures > 0) {
    console.error(`\n✗ ${failures} file(s) with hardcoded UUID literals above baseline.`);
    process.exit(1);
  }
  console.log(
    `✓ UUID literals clean — ${grandfathered} grandfathered across ${Object.keys(baseline).length} baselined file(s); no new offenders.`,
  );
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-uuid-literals.ts") ||
    process.argv[1].endsWith("check-uuid-literals.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  if (process.argv.includes("--write-baseline")) {
    writeBaseline(measure(collectFiles()));
  } else {
    runChecks();
  }
}

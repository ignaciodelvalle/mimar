// Ad-hoc Spanish-pluralization fence — CI guard (copy-consistency burn-down).
//
// WHY THIS EXISTS
// ----------------
// `${n} evento${n === 1 ? "" : "s"}`-shaped ternaries were inlined across
// dozens of surfaces. Each inline copy is a chance to pick the wrong suffix
// ("señals", "animals"), disagree with a sibling surface, or silently skip
// the n === 0 plural. lib/utils/format.ts now owns count agreement via
// `pluralizeEs(n, singular, plural?)` — new code must use it.
//
// DETECTION: a count-vs-1 comparison ternary whose two arms are an empty
// string and a bare "s"/"es" suffix (either order, any quote style):
//     n === 1 ? "" : "s"      n !== 1 ? "es" : ""     n == 1 ? `` : `s`
// This is intentionally narrow — gender ternaries (sex === "female" ? …) and
// non-suffix conditionals never match. CRLF-safe line scan.
//
// Enforcement: ratchet with a per-file baseline (check-file-size.ts style).
// Baseline: scripts/pluralize-es-baseline.json — regenerate with
//   pnpm tsx scripts/check-pluralize-es.ts --write-baseline
// Grandfathered files are foreign territory tonight (other trains own them);
// burn them down by migrating to pluralizeEs, never add new ad-hoc ternaries.
//
// FAIL-CLOSED: an empty scan (glob found no files) is an error, not a pass.
//
// Run: pnpm tsx scripts/check-pluralize-es.ts   (or: pnpm lint:plural)
// Exits 0 when clean; exits 1 listing each offending file:line.

import { globSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Anchor to the repo root (this file lives at <root>/scripts/).
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const BASELINE_PATH = resolve(ROOT, "scripts/pluralize-es-baseline.json");

const SOURCE_GLOB = "{app,components,lib,packages,src}/**/*.{ts,tsx}";

/** Count-vs-1 ternary with an empty-string arm and a bare s/es-suffix arm,
 *  in either order, with ", ', or ` quotes. */
export const ADHOC_PLURAL_RE =
  /[!=]==?\s*1\s*\?\s*(?:(["'`])\1\s*:\s*(["'`])e?s\2|(["'`])e?s\3\s*:\s*(["'`])\4)/g;

/**
 * Arm 2 (copy audit 2026-08-04) — an interpolated COUNT immediately followed by
 * a hardcoded plural noun, with no agreement at all.
 *
 * The original rule only caught the ternary shape, so it was blind to the worse
 * bug: a template that never even tries. The live example was
 * `${suppressed.total.toLocaleString("es-AR")} celdas … ocultas`, which renders
 * "1 celdas … ocultas" — disagreeing twice, on a government privacy notice.
 *
 * Deliberately narrow to stay useful:
 *   - only fires inside `${…}` interpolation followed by whitespace,
 *   - the following word must end in s/es and be ≥4 chars (skips "s", "es",
 *     and short function-word noise),
 *   - a LITERAL number never matches, because the count has to be an
 *     interpolation to be variable in the first place,
 *   - lines already calling `pluralizeEs` are exempt (that IS the fix),
 *   - Spanish words that are invariant or not nouns are listed in
 *     PLURAL_ARM2_STOPWORDS below rather than being guessed at.
 *
 * False positives are expected where a count is provably > 1 or fixed. That is
 * what the baseline ratchet is for — grandfather them, never widen the regex to
 * accommodate one.
 *
 * A SCREAMING_CASE interpolation is skipped on purpose: `${MIN_NOTES_LEN}
 * caracteres` is a validation FLOOR, not a count of things being described —
 * the sentence is "at least N characters", where N is a fixed constant and the
 * singular case cannot occur in practice. Including them produced 236 files on
 * first run, most of them that shape. A fence nobody can burn down is a fence
 * nobody reads.
 */
export const COUNT_PLURAL_NOUN_RE = /\$\{([^}]*)\}\s+([a-záéíóúñ]{4,}(?:es|s))\b/gi;

/** TRUE for `${MIN_NOTES_LEN}`-shaped interpolations — a fixed limit, not a count. */
export function isConstantInterpolation(expr: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(expr.trim());
}

/** Words that end in s/es but are not count-agreeing nouns in our copy. */
export const PLURAL_ARM2_STOPWORDS = new Set([
  "menos",
  "mas",
  "más",
  "menos",
  "menores",
  "mayores",
  "menos",
  "antes",
  "despues",
  "después",
  "entonces",
  "atras",
  "atrás",
  "quizas",
  "quizás",
  "jamas",
  "jamás",
  "ademas",
  "además",
  "solamente",
  "gratis",
  "lunes",
  "martes",
  "miercoles",
  "miércoles",
  "jueves",
  "viernes",
  "crisis",
  "analisis",
  "análisis",
  "dosis",
  "pais",
  "país",
  "mes",
  "res",
  // English words that happen to end in s — this repo writes logs, dev-facing
  // errors and code comments in English, and none of them are es-AR UI copy.
  "appears",
  "weeks",
  "days",
  "hours",
  "minutes",
  "seconds",
  "items",
  "rows",
  "files",
  "results",
  "changes",
  "errors",
  "columns",
  "records",
  "events",
  "values",
  "times",
  "bytes",
  "pets",
  "notifications",
  "attempts",
]);

const TEST_SUFFIXES = [".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx", ".d.ts"];

type BaselineFile = {
  _meta: { generatedAt: string; description: string };
  files: Record<string, number>;
};

export type PluralHit = { line: number; snippet: string };

/** Find ad-hoc pluralization ternaries in a file's source. CRLF-safe.
 * Comment lines are ignored (a `// …=== 1 ? "" : "s"…` mention is
 * documentation, not a control) — same posture as check-tablist-ratchet.ts. */
export function findAdhocPlurals(src: string): PluralHit[] {
  const hits: PluralHit[] = [];
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    for (const match of lines[i].matchAll(ADHOC_PLURAL_RE)) {
      const start = Math.max(0, (match.index ?? 0) - 20);
      hits.push({
        line: i + 1,
        snippet: lines[i].slice(start, (match.index ?? 0) + match[0].length).trim(),
      });
    }
    // Arm 2 — interpolated count followed by a bare plural noun. A line that
    // already calls pluralizeEs is doing the right thing by definition.
    if (lines[i].includes("pluralizeEs")) continue;
    for (const match of lines[i].matchAll(COUNT_PLURAL_NOUN_RE)) {
      if (isConstantInterpolation(match[1] ?? "")) continue;
      const word = (match[2] ?? "").toLowerCase();
      if (PLURAL_ARM2_STOPWORDS.has(word)) continue;
      const start = Math.max(0, (match.index ?? 0) - 24);
      hits.push({
        line: i + 1,
        snippet: lines[i].slice(start, (match.index ?? 0) + match[0].length).trim(),
      });
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

function collectFiles(): string[] {
  const files = globSync(SOURCE_GLOB, { cwd: ROOT })
    .map((f) => f.replaceAll("\\", "/"))
    .filter((f) => !f.includes("node_modules/"))
    .filter((f) => !TEST_SUFFIXES.some((s) => f.endsWith(s)) && !f.includes("__tests__/"))
    .sort();
  if (files.length === 0) {
    // FAIL CLOSED: an empty glob must never read as "no violations".
    console.error(`✗ check-pluralize-es: no files matched ${SOURCE_GLOB} under ${ROOT}.`);
    process.exit(1);
  }
  return files;
}

function measure(files: string[]): Map<string, PluralHit[]> {
  const byFile = new Map<string, PluralHit[]>();
  for (const rel of files) {
    const hits = findAdhocPlurals(readFileSync(resolve(ROOT, rel), "utf8"));
    if (hits.length > 0) byFile.set(rel, hits);
  }
  return byFile;
}

function loadBaseline(): Record<string, number> {
  try {
    return (JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as BaselineFile).files;
  } catch {
    console.warn(
      `[warn] ${BASELINE_PATH} not found — every ad-hoc pluralization will fail. Regenerate with: pnpm tsx scripts/check-pluralize-es.ts --write-baseline`,
    );
    return {};
  }
}

function writeBaseline(byFile: Map<string, PluralHit[]>): void {
  const baseline: BaselineFile = {
    _meta: {
      generatedAt: new Date().toISOString().slice(0, 10),
      description:
        'Files with ad-hoc `n === 1 ? "" : "s"` pluralization ternaries, grandfathered at the recorded count. New files, or counts above baseline, fail lint:plural — use pluralizeEs (lib/utils/format.ts) instead. Migrating a file lets its entry be removed; the ratchet only tightens.',
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
          `${file}:${h.line} ad-hoc pluralization ("${h.snippet}", baseline allows ${allowed}) — use pluralizeEs(n, "sustantivo") from lib/utils/format.ts so count agreement lives in one place.`,
        );
      }
    } else {
      grandfathered += hits.length;
    }
  }

  const stale = Object.keys(baseline).filter((f) => !byFile.has(f));
  if (stale.length > 0) {
    console.warn(
      `[info] ${stale.length} baselined file(s) no longer use ad-hoc pluralization — remove from ${BASELINE_PATH} to tighten the ratchet: ${stale.join(", ")}`,
    );
  }

  if (failures > 0) {
    console.error(`\n✗ ${failures} file(s) with ad-hoc pluralization above baseline.`);
    process.exit(1);
  }
  console.log(
    `✓ pluralization clean — ${grandfathered} grandfathered ad-hoc ternary(ies) across ${Object.keys(baseline).length} baselined file(s); new ones must use pluralizeEs.`,
  );
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-pluralize-es.ts") ||
    process.argv[1].endsWith("check-pluralize-es.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  if (process.argv.includes("--write-baseline")) {
    writeBaseline(measure(collectFiles()));
  } else {
    runChecks();
  }
}

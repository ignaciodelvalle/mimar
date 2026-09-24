// Eyebrow ≠ title fence — CI guard (section-header duplication).
//
// WHY THIS EXISTS
// ----------------
// QA flagged the "Cumplimiento / Cumplimiento" class of bug: a section header
// whose eyebrow/kicker label renders the SAME text as the heading right next
// to it. The eyebrow exists to CLASSIFY the section ("Cumplimiento", "Vista ·
// Estado"); the heading exists to NAME it ("Estado de cumplimiento"). When
// both say the same thing the reader gets the word twice and the information
// once — a copy smell that keeps re-appearing as sections get scaffolded from
// each other.
//
// DETECTION HEURISTIC (pragmatic line-window scan — no JSX parser, same
// posture as check-tablist-ratchet.ts / check-ui-invariants.ts):
//   1. EYEBROW candidate: an element open tag whose className contains
//      "eyebrow" or "kicker", OR both "uppercase" and "tracking" (the
//      mono-uppercase kicker style used across ln/op surfaces).
//   2. HEADING candidate: an <h1>–<h4> tag, or an element whose className
//      carries a `--text-title` design token (the "text-*-title" classes).
//   3. TEXT of either candidate: the inline `>TEXT<` content on the same
//      line, else the first bare-JSX-text line (no tags/braces) within the
//      next 3 lines (skipping tag lines — headings often nest an inner span).
//   4. A violation is an eyebrow and a heading whose OPEN TAGS sit within
//      WINDOW_LINES of each other (the "same parent block" approximation)
//      and whose texts are identical after normalization (case-insensitive,
//      accent-insensitive, whitespace-collapsed).
//   This trades recall for precision: a duplication split across dynamic
//   expressions or further than WINDOW_LINES apart is missed, never
//   false-flagged.
//
// Enforcement: ratchet with a per-file baseline (check-file-size.ts style).
// Baseline: scripts/eyebrow-title-baseline.json — regenerate with
//   pnpm tsx scripts/check-eyebrow-title.ts --write-baseline
// Existing offenders are grandfathered at their current count; curing them is
// follow-up work owned by the page-file trains, not this fence.
//
// FAIL-CLOSED: an empty scan (glob found no files) is an error, not a pass.
//
// Run: pnpm tsx scripts/check-eyebrow-title.ts   (or: pnpm lint:eyebrow)
// Exits 0 when clean; exits 1 listing each offending file:line.

import { globSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Anchor to the repo root (this file lives at <root>/scripts/), so the scan
// works no matter which directory the script is invoked from.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const BASELINE_PATH = resolve(ROOT, "scripts/eyebrow-title-baseline.json");

const SOURCE_GLOB = "{app,components}/**/*.tsx";

/** Max line distance between the eyebrow's and the heading's open tags for
 *  them to count as the same section-header block. */
const WINDOW_LINES = 6;

/** How many lines below an open tag we look for its bare-text content. */
const TEXT_LOOKAHEAD_LINES = 3;

const EYEBROW_CLASS_RE = /className="[^"]*(?:eyebrow|kicker)[^"]*"/;
const EYEBROW_UPPER_TRACKING_RE = /className="(?=[^"]*uppercase)(?=[^"]*tracking)[^"]*"/;
const HEADING_TAG_RE = /<h[1-4][\s>]/;
const HEADING_TITLE_CLASS_RE = /className="[^"]*--text-title[^"]*"/;

/** Bare JSX text: no tags, no expression braces, at least one word character. */
const BARE_TEXT_RE = /^[^<>{}]*[\p{L}\p{N}][^<>{}]*$/u;

/** Inline single-line element content: `>TEXT</`. */
const INLINE_TEXT_RE = />([^<>{}]*[\p{L}\p{N}][^<>{}]*)</u;

type BaselineFile = {
  _meta: { generatedAt: string; description: string };
  files: Record<string, number>;
};

export type Candidate = { line: number; text: string };

export type EyebrowViolation = {
  eyebrowLine: number;
  headingLine: number;
  text: string;
};

/** Case-insensitive, accent-insensitive, whitespace-collapsed comparison key. */
export function normalizeText(raw: string): string {
  return raw.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Extract the text of the element opened on `lines[i]`: inline `>TEXT<` on
 * the same line, else the first bare-text line within TEXT_LOOKAHEAD_LINES.
 * The lookahead STOPS at the first line containing another tag (`<`) — walking
 * past a sibling's open tag would steal that sibling's text (measured false
 * positive: an eyebrow with a dynamic `{expr}` tail borrowed the adjacent
 * heading's text). This misses a heading whose first child is a nested inline
 * element — precision over recall, per the header contract. */
function elementText(lines: string[], i: number): string | null {
  const inline = lines[i].match(INLINE_TEXT_RE);
  if (inline) return inline[1];
  for (let j = i + 1; j <= i + TEXT_LOOKAHEAD_LINES && j < lines.length; j += 1) {
    const t = lines[j].trim();
    if (t === "") continue;
    if (t.includes("<")) return null;
    if (BARE_TEXT_RE.test(t)) return t;
  }
  return null;
}

/** Scan one file's source for eyebrow-text === heading-text duplications. */
export function findEyebrowTitleDuplications(src: string): EyebrowViolation[] {
  const lines = src.split(/\r?\n/);
  const eyebrows: Candidate[] = [];
  const headings: Candidate[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const isEyebrow = EYEBROW_CLASS_RE.test(line) || EYEBROW_UPPER_TRACKING_RE.test(line);
    const isHeading = HEADING_TAG_RE.test(line) || HEADING_TITLE_CLASS_RE.test(line);
    if (!isEyebrow && !isHeading) continue;
    const text = elementText(lines, i);
    if (text === null) continue;
    const normalized = normalizeText(text);
    if (normalized === "") continue;
    if (isEyebrow) eyebrows.push({ line: i + 1, text: normalized });
    // An eyebrow line is never simultaneously its own heading; eyebrow wins.
    if (isHeading && !isEyebrow) headings.push({ line: i + 1, text: normalized });
  }

  const violations: EyebrowViolation[] = [];
  for (const eyebrow of eyebrows) {
    for (const heading of headings) {
      if (Math.abs(heading.line - eyebrow.line) > WINDOW_LINES) continue;
      if (heading.text !== eyebrow.text) continue;
      violations.push({ eyebrowLine: eyebrow.line, headingLine: heading.line, text: eyebrow.text });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

function collectFiles(): string[] {
  const files = globSync(SOURCE_GLOB, { cwd: ROOT })
    .map((f) => f.replaceAll("\\", "/"))
    .filter((f) => !f.includes("node_modules/"))
    .filter((f) => !f.endsWith(".test.tsx") && !f.includes("__tests__/"))
    .sort();
  if (files.length === 0) {
    // FAIL CLOSED: an empty glob means the scan ran from the wrong place or
    // the tree moved — that must never read as "no violations".
    console.error(`✗ check-eyebrow-title: no files matched ${SOURCE_GLOB} under ${ROOT}.`);
    process.exit(1);
  }
  return files;
}

function measure(files: string[]): Map<string, EyebrowViolation[]> {
  const byFile = new Map<string, EyebrowViolation[]>();
  for (const rel of files) {
    const src = readFileSync(resolve(ROOT, rel), "utf8");
    const violations = findEyebrowTitleDuplications(src);
    if (violations.length > 0) byFile.set(rel, violations);
  }
  return byFile;
}

function loadBaseline(): Record<string, number> {
  try {
    return (JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as BaselineFile).files;
  } catch {
    console.warn(
      `[warn] ${BASELINE_PATH} not found — every duplication will fail. Regenerate with: pnpm tsx scripts/check-eyebrow-title.ts --write-baseline`,
    );
    return {};
  }
}

function writeBaseline(byFile: Map<string, EyebrowViolation[]>): void {
  const baseline: BaselineFile = {
    _meta: {
      generatedAt: new Date().toISOString().slice(0, 10),
      description:
        "Files with an eyebrow/kicker label identical to its adjacent heading, grandfathered at the recorded count. New files, or counts above baseline, fail lint:eyebrow. Curing a file lets its entry be removed — the ratchet only tightens.",
    },
    files: Object.fromEntries([...byFile].map(([file, v]) => [file, v.length])),
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`✓ Wrote ${byFile.size} file(s) to ${BASELINE_PATH}.`);
}

function runChecks(): void {
  const byFile = measure(collectFiles());
  const baseline = loadBaseline();
  let hits = 0;
  let grandfathered = 0;

  for (const [file, violations] of byFile) {
    const allowed = baseline[file] ?? 0;
    if (violations.length > allowed) {
      hits += 1;
      for (const v of violations) {
        console.error(
          `${file}:${v.eyebrowLine} eyebrow text ("${v.text}") duplicates the heading at line ${v.headingLine} (baseline allows ${allowed}). The eyebrow classifies the section; the heading names it — make them say different things.`,
        );
      }
    } else {
      grandfathered += violations.length;
    }
  }

  const stale = Object.keys(baseline).filter((f) => !byFile.has(f));
  if (stale.length > 0) {
    console.warn(
      `[info] ${stale.length} baselined file(s) are now clean — remove them from ${BASELINE_PATH} to tighten the ratchet: ${stale.join(", ")}`,
    );
  }

  if (hits > 0) {
    console.error(`\n✗ ${hits} file(s) with an eyebrow/heading duplication above baseline.`);
    process.exit(1);
  }
  console.log(
    `✓ eyebrow≠title clean — ${grandfathered} grandfathered duplication(s) across ${Object.keys(baseline).length} baselined file(s); no new offenders.`,
  );
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-eyebrow-title.ts") ||
    process.argv[1].endsWith("check-eyebrow-title.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  if (process.argv.includes("--write-baseline")) {
    writeBaseline(measure(collectFiles()));
  } else {
    runChecks();
  }
}

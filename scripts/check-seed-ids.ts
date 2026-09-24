// lint:seed-ids — static seed-marker fence (plan-maestro-integridad C5).
//
// Companion to scripts/check-seed-hygiene.ts (the DYNAMIC gate, which queries
// the live DB): this is the STATIC gate, scanning seed script SOURCE for a
// write of a seed-marker literal (scripts/seed-hygiene-rules.ts) into a
// renderable column's property key (displayName / description / name /
// legalName — the same tsKey list the DB validator's columns map to). Same
// primitive → fence → sweep idiom as every other scripts/check-*.ts gate.
//
// What counts as a violation: a line assigning one of the renderable tsKeys
// (`displayName:`, `description:`, `name:`, `legalName:`) where the
// STRING/TEMPLATE literal on that same line contains a seed-marker pattern.
// Line-based (not full AST) — mirrors check-brand-casing.ts's approach — but
// covers every violation the C5 audit actually found (all single-line
// `key: \`...marker...\`` assignments).
//
// Deliberately NOT flagged: `publicToken`/`referenceCode`-shaped id columns
// (PANO- in pets.public_token is an accepted, documented exception — see
// seed-panorama.ts's PANO- TAG header comment) and comments (skipped via the
// shared classifyLine from check-professionalism.ts).
//
// Scope: scripts/seed-*.ts (the seed generators), excluding *.test.ts.
//
// Run: pnpm tsx scripts/check-seed-ids.ts
// Or:  pnpm lint:seed-ids
// Rewrite baseline (only after a deliberate, reviewed grandfather decision):
//   pnpm tsx scripts/check-seed-ids.ts --write-baseline
//
// Exits 1 with file:line + the offending literal on each hit. Exits 0 clean.

import { globSync, readFileSync, writeFileSync } from "node:fs";

import { type CommentState, classifyLine } from "./check-professionalism";
import { RENDERABLE_TEXT_COLUMNS, SEED_MARKER_PATTERNS } from "./hygiene-rules";

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

function isExcluded(relPath: string): boolean {
  if (relPath.includes(".test.")) return true;
  return false;
}

const FILES = globSync("scripts/seed-*.ts")
  .map((f) => f.replaceAll("\\", "/"))
  .filter((f) => !isExcluded(f));

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

const RENDERABLE_KEYS = [...new Set(RENDERABLE_TEXT_COLUMNS.map((c) => c.tsKey))];

// key: <value up to end of line> — value may be a template literal, a plain
// string, or the start of a multi-line expression; we only need what's on
// THIS line, which is where every real violation found by the C5 audit lives.
const KEY_ASSIGNMENT_RE = new RegExp(`\\b(${RENDERABLE_KEYS.join("|")})\\s*:\\s*(.+)$`);

export type SeedIdHit = { line: number; key: string; matchedPattern: string; text: string };

/** All static seed-marker hits in a seed script's source, skipping comments. */
export function findSeedIdHits(src: string): SeedIdHit[] {
  const hits: SeedIdHit[] = [];
  let state: CommentState = { inBlock: false };
  src.split(/\r?\n/).forEach((rawLine, i) => {
    const { isComment, nextState } = classifyLine(rawLine, state);
    state = nextState;
    if (isComment) return;

    const keyMatch = rawLine.match(KEY_ASSIGNMENT_RE);
    if (!keyMatch) return;
    const [, key, value] = keyMatch;

    for (const p of SEED_MARKER_PATTERNS) {
      if (p.regex.test(value)) {
        hits.push({ line: i + 1, key, matchedPattern: p.name, text: rawLine.trim().slice(0, 120) });
        break; // one hit per line is enough to flag it
      }
    }
  });
  return hits;
}

// ---------------------------------------------------------------------------
// Baseline — scripts/seed-ids-baseline.json
// ---------------------------------------------------------------------------

type BaselineFile = {
  _meta: { totalViolations: number; description: string };
  files: Record<string, number>;
};

const BASELINE_PATH = "scripts/seed-ids-baseline.json";

function loadBaseline(): Record<string, number> {
  try {
    const data = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as BaselineFile;
    return data.files;
  } catch {
    console.warn(
      `[warn] ${BASELINE_PATH} not found — lint:seed-ids will be strict (no grandfather).`,
    );
    return {};
  }
}

function writeBaseline(): void {
  const files: Record<string, number> = {};
  let total = 0;
  for (const file of FILES) {
    const count = findSeedIdHits(readFileSync(file, "utf8")).length;
    if (count > 0) {
      files[file] = count;
      total += count;
    }
  }
  const output: BaselineFile = {
    _meta: {
      totalViolations: total,
      description:
        "Baseline of seed-marker literals (PANO-/-Seed-/HIST-WEL/n-<digits>) written into a renderable column (displayName/description/name/legalName) inside scripts/seed-*.ts. Grandfathered up to these counts; new violations fail lint:seed-ids. The C5 sweep target is 0 — regenerate only after a deliberate, reviewed exception.",
    },
    files,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(output, null, 2)}\n`);
  console.log(
    `Baseline written: ${total} grandfathered seed-id hit(s) across ${Object.keys(files).length} file(s).`,
  );
}

function runScan(): void {
  const baseline = loadBaseline();
  let violatingFiles = 0;
  let grandfathered = 0;

  for (const file of FILES) {
    const src = readFileSync(file, "utf8");
    const hits = findSeedIdHits(src);
    if (hits.length === 0) continue;

    const allowed = baseline[file] ?? 0;
    grandfathered += Math.min(hits.length, allowed);
    if (hits.length > allowed) {
      for (const hit of hits) {
        console.error(
          `${file}:${hit.line}: seed marker "${hit.matchedPattern}" in renderable key "${hit.key}" — ${hit.text}`,
        );
      }
      console.error(
        `${file}: ratchet — ${hits.length} seed-id violation(s) (baseline allows ${allowed}). To grandfather a reviewed exception, run: pnpm tsx scripts/check-seed-ids.ts --write-baseline`,
      );
      violatingFiles += 1;
    }
  }

  if (violatingFiles > 0) {
    console.error(`\n✗ ${violatingFiles} file(s) with new seed-id violation(s).`);
    process.exit(1);
  }

  console.log(
    `✓ Seed-id fence clean — 0 new seed-marker writes into renderable columns across ${FILES.length} seed script(s).`,
  );
  console.log(
    `  Ratchet: ${grandfathered} grandfathered hit(s) across ${Object.keys(baseline).length} file(s). New ones will fail.`,
  );
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-seed-ids.ts") || process.argv[1].endsWith("check-seed-ids.js"));

if (isMain) {
  if (process.argv.includes("--write-baseline")) {
    writeBaseline();
  } else {
    runScan();
  }
}

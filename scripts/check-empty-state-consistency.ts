// Empty-state consistency fence (consistency sweep 2026-07-23).
//
// WHY THIS EXISTS
// ----------------
// C4's primitive is LnEmptyState (components/ui/EmptyState.tsx) — the shared,
// epistemic empty-state component ("what is this emptiness, why, what fills
// it"). The Directorio hub shipped with three sibling tabs rendering a bare
// `<p>Sin resultados.</p>` while the fourth used LnEmptyState — the exact
// drift this fence stops: a page-level "no results" rendered as a naked
// caption instead of the shared component.
//
// Detection (precision over recall, house posture): any "Sin resultados"
// string literal in app/gob/**/*.tsx or app/admin/**/*.tsx OUTSIDE an
// <LnEmptyState …> JSX block. Control-level empty rows (a combobox/picker
// dropdown's "Sin resultados para …" <li>) are legitimate — a full
// LnEmptyState inside a dropdown would be wrong — so this is a RATCHET:
// today's two picker cases are grandfathered in the baseline; a NEW
// occurrence (or a file's count going up) fails CI and the author either
// uses LnEmptyState or consciously regenerates the baseline for a genuine
// control-level case.
//
// Run: pnpm tsx scripts/check-empty-state-consistency.ts   (or: pnpm lint:empty-states)
// Regenerate baseline: pnpm tsx scripts/check-empty-state-consistency.ts --write-baseline

import { existsSync, globSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = resolve(ROOT, "scripts/empty-state-baseline.json");

const LITERAL = "Sin resultados";

/** Extract every `<LnEmptyState` JSX block (brace-depth scan, mirrors
 *  check-metric-contract.ts's extractOpKpiBlocks). */
function extractEmptyStateBlocks(content: string): Array<{ start: number; end: number }> {
  const blocks: Array<{ start: number; end: number }> = [];
  const tagRe = /<LnEmptyState\b/g;
  let match: RegExpExecArray | null = tagRe.exec(content);
  while (match !== null) {
    const start = match.index;
    let i = start + match[0].length;
    let depth = 0;
    let end = -1;
    while (i < content.length) {
      const ch = content[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      else if (depth === 0 && ch === "/" && content[i + 1] === ">") {
        end = i + 2;
        break;
      } else if (depth === 0 && ch === ">") {
        end = i + 1;
        break;
      }
      i += 1;
    }
    if (end !== -1) blocks.push({ start, end });
    match = tagRe.exec(content);
  }
  return blocks;
}

function normalizeRelPath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

/** Count "Sin resultados" occurrences outside LnEmptyState blocks, per file. */
export function scanBareEmptyStates(files: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const blocks = extractEmptyStateBlocks(content);
    let bare = 0;
    let idx = content.indexOf(LITERAL);
    while (idx !== -1) {
      const inside = blocks.some((b) => idx >= b.start && idx < b.end);
      if (!inside) bare += 1;
      idx = content.indexOf(LITERAL, idx + LITERAL.length);
    }
    if (bare > 0) counts.set(normalizeRelPath(file), bare);
  }
  return counts;
}

const SCAN_FILES = globSync("{app/gob,app/admin}/**/*.tsx").filter((f) => {
  const p = normalizeRelPath(f);
  return !p.includes("__tests__/") && !p.endsWith(".test.tsx");
});

type Baseline = Record<string, number>;

function loadBaseline(): Baseline {
  if (!existsSync(BASELINE_PATH)) return {};
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
}

function runScan(): void {
  if (SCAN_FILES.length === 0) {
    console.error(
      "✗ check-empty-state-consistency: no .tsx files matched under app/gob or app/admin.",
    );
    process.exit(1);
  }

  const counts = scanBareEmptyStates(SCAN_FILES);

  if (process.argv.includes("--write-baseline")) {
    const sorted: Baseline = {};
    for (const key of [...counts.keys()].sort()) sorted[key] = counts.get(key) as number;
    writeFileSync(BASELINE_PATH, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    console.log(
      `✓ wrote baseline: ${counts.size} file(s), ${total} bare "Sin resultados" grandfathered.`,
    );
    return;
  }

  const baseline = loadBaseline();
  let failures = 0;
  for (const [file, count] of counts) {
    const allowed = baseline[file] ?? 0;
    if (count > allowed) {
      failures += 1;
      console.error(
        `✗ ${file}: ${count} bare "Sin resultados" outside <LnEmptyState> (baseline allows ${allowed}) — a page-level empty result must render the shared LnEmptyState (components/ui/EmptyState.tsx). Only a control-level empty row (picker/combobox dropdown) may stay bare; if this is genuinely that, regenerate the baseline (--write-baseline) consciously.`,
      );
    }
  }

  const stale = Object.keys(baseline).filter((f) => !counts.has(f));
  if (stale.length > 0) {
    console.warn(
      `[info] ${stale.length} baselined file(s) no longer have bare occurrences — regenerate the baseline (--write-baseline) to tighten the ratchet: ${stale.join(", ")}`,
    );
  }

  if (failures > 0) {
    console.error(`\n✗ ${failures} file(s) exceed their empty-state baseline.`);
    process.exit(1);
  }
  const grandfathered = [...counts.values()].reduce((a, b) => a + b, 0);
  console.log(`✓ empty-state fence clean — ${grandfathered} grandfathered bare occurrence(s).`);
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-empty-state-consistency.ts") ||
    process.argv[1].endsWith("check-empty-state-consistency.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  runScan();
}

// Metric-contract fence — CI guard (C1, dim-interno:docs/reviews/results/
// 2026-07-22-plan-maestro-integridad.md, §2 "C1 · Contrato de Métrica").
//
// WHY THIS EXISTS
// ----------------
// C1's primitive: every KPI rendered on an operator surface SHOULD come from
// a lib/metrics/kpi-catalog.ts descriptor (question/target/semaphore/guards
// declared as data), consumed via <OpKpi descriptorId="…">. Rendering a tile
// descriptor-less (a label string + a raw value + an ad-hoc tone) is what
// produced the dual-rabies label collision, the PPP "Peligro" verdict on a 0%
// uptake number, and the rest of the S1 findings this plan fences.
//
// STATUS (verified 2026-08-17 by running this script): the sweep is DONE.
// `metric-contract-baseline.json` is empty and the fence reports 0
// grandfathered tiles across 0 baselined files — every `<OpKpi` on /gob and
// /admin goes through the guard engine. This note used to say "today most of
// the ~80 tiles still render descriptor-less", which stopped being true at some
// point and would send the next reader off to redo finished work.
//
// This is a RATCHET, same shape as check-eyebrow-title.ts / check-tablist-
// ratchet.ts / check-state-coverage.ts's rule 4: the baseline is the count of
// descriptor-less `<OpKpi` usages grandfathered when the fence landed, and a
// file's count can only go DOWN (regenerate with --write-baseline after
// migrating a tile to `descriptorId`). With the baseline now EMPTY the ratchet
// has reached its floor, so it enforces something stronger than it was built
// for: not "the count must not grow" but "there is no descriptor-less tile at
// all". Keep it there — `--write-baseline` would re-grandfather whatever exists
// at that moment, which is how a floor quietly becomes a ceiling again.
//
// Detection: `<OpKpi` (word-boundary — deliberately does NOT match
// `<OpKpiSm`, which has no descriptorId/guard-engine integration and isn't
// in scope for this contract) with no `descriptorId` prop anywhere in its
// JSX block, scanned across app/gob/**/*.tsx and app/admin/**/*.tsx.
//
// Run: pnpm tsx scripts/check-metric-contract.ts   (or: pnpm lint:metric-contract)
// Regenerate baseline: pnpm tsx scripts/check-metric-contract.ts --write-baseline
// Exits 0 when clean; exits 1 listing each new/increased violation.

import { existsSync, globSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = resolve(ROOT, "scripts/metric-contract-baseline.json");

// ---------------------------------------------------------------------------
// Extraction — mirrors check-metric-labels.ts's brace-depth JSX-block scan
// (no full JSX parser; same "precision over recall" posture as
// check-ui-invariants.ts).
// ---------------------------------------------------------------------------

/** Extract every `<OpKpi` JSX block (NOT `<OpKpiSm`) from file content. */
function extractOpKpiBlocks(content: string): string[] {
  const blocks: string[] = [];
  // Word-boundary after "OpKpi": matches `<OpKpi ` / `<OpKpi\n` / `<OpKpi>`
  // but NOT `<OpKpiSm` (no boundary between two word chars 'i' and 'S').
  const tagRe = /<OpKpi\b/g;
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
    if (end !== -1) blocks.push(content.slice(start, end));
    match = tagRe.exec(content);
  }
  return blocks;
}

function hasDescriptorId(block: string): boolean {
  return /\bdescriptorId\s*=/.test(block);
}

// ---------------------------------------------------------------------------
// Rule 2 — guard feeding (consistency sweep 2026-07-23, dead-guard class).
//
// A descriptor may declare guards (zeroDenominator/smallN need `guardInput.n`;
// unstableDeltaBase and deltaImplausible need `guardInput.priorBase`) that NO
// call site feeds —
// the guard then silently never fires (the adoption-tile 0/0-confident-red bug
// and the eno_sla_compliance case were both this class). Every <OpKpi> block
// carrying a guard-declaring descriptorId must pass the matching guardInput
// keys, unless the catalog entry sets `manualEnforcement: true` (a documented
// dedicated helper path enforces the guards instead). This rule is NOT a
// ratchet: the repo is clean today, so any violation is a hard failure.
// ---------------------------------------------------------------------------

// EVERY module that declares KPI_CATALOG entries. kpi-catalog.ts sits at its
// file-size ratchet ceiling, so descriptor families are split into sibling
// modules (kpi-catalog-queues.ts) and spread back in. This rule reads a
// catalog TEXTUALLY, so a family that moved out of the main file would silently
// stop being guard-checked unless it is listed here — the list, not the single
// path, is what keeps the dead-guard rule total.
const CATALOG_PATHS = [
  resolve(ROOT, "lib/metrics/kpi-catalog.ts"),
  resolve(ROOT, "lib/metrics/kpi-catalog-queues.ts"),
  resolve(ROOT, "lib/metrics/kpi-catalog-compliance.ts"),
];

type GuardNeeds = { needsN: boolean; needsPriorBase: boolean; manual: boolean };

function stripLineComments(src: string): string {
  return src
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

/** Brace-depth scan of the object literal starting at `openIdx` (a `{`). */
function sliceBraceBlock(content: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < content.length; i++) {
    if (content[i] === "{") depth += 1;
    else if (content[i] === "}") {
      depth -= 1;
      if (depth === 0) return content.slice(openIdx, i + 1);
    }
  }
  return content.slice(openIdx);
}

/** Parse a KPI catalog module textually: descriptor id → what its guards need.
 *  Anchors on any `export const …KPI_CATALOG` declaration so a split-out family
 *  (QUEUE_KPI_CATALOG) is parsed exactly like the main one. */
export function parseCatalogGuardNeeds(catalogSrc: string): Map<string, GuardNeeds> {
  const needs = new Map<string, GuardNeeds>();
  const catalogStart = catalogSrc.search(/export const \w*KPI_CATALOG\b/);
  if (catalogStart === -1) return needs;
  const body = catalogSrc.slice(catalogStart);
  const entryRe = /^ {2}([a-z0-9_]+): \{/gm;
  let m: RegExpExecArray | null = entryRe.exec(body);
  while (m !== null) {
    const id = m[1];
    const entry = sliceBraceBlock(body, m.index + m[0].length - 1);
    const guardsIdx = entry.search(/\bguards:\s*\{/);
    if (guardsIdx !== -1) {
      const braceIdx = entry.indexOf("{", guardsIdx);
      const guards = stripLineComments(sliceBraceBlock(entry, braceIdx));
      needs.set(id, {
        needsN: /\b(?:zeroDenominator|smallN)\s*:/.test(guards),
        // H16 (2026-07-30): deltaImplausible reads the SAME guardInput key as
        // unstableDeltaBase. Listed explicitly rather than left implicit —
        // a descriptor that carries only the new guard is just as dead
        // without a fed priorBase as one carrying only the old guard.
        needsPriorBase: /\b(?:unstableDeltaBase|deltaImplausible)\s*:/.test(guards),
        manual: /\bmanualEnforcement\s*:\s*true\b/.test(guards),
      });
    }
    m = entryRe.exec(body);
  }
  return needs;
}

export type GuardFeedViolation = { file: string; descriptorId: string; missing: string };

/** Rule-2 scan: every guard-declaring descriptor's OpKpi block feeds its keys. */
export function scanGuardFeeding(
  files: string[],
  guardNeeds: Map<string, GuardNeeds>,
): GuardFeedViolation[] {
  const violations: GuardFeedViolation[] = [];
  for (const file of files) {
    const relPath = normalizeRelPath(file);
    const content = readFileSync(file, "utf8");
    for (const block of extractOpKpiBlocks(content)) {
      const idMatch = block.match(/\bdescriptorId\s*=\s*\{?\s*["']([\w]+)["']/);
      if (!idMatch) continue; // descriptor-less (rule 1) or dynamic id — out of scope here.
      const need = guardNeeds.get(idMatch[1]);
      if (!need || need.manual) continue;
      const guardInputMatch = block.match(/\bguardInput\s*=\s*\{\{([\s\S]*?)\}\}/);
      const guardInput = guardInputMatch ? guardInputMatch[1] : "";
      const missing: string[] = [];
      if (need.needsN && !/(?:^|[,{\s])n\s*:/.test(guardInput)) missing.push("n");
      if (need.needsPriorBase && !/\bpriorBase\s*:/.test(guardInput)) missing.push("priorBase");
      if (missing.length > 0) {
        violations.push({ file: relPath, descriptorId: idMatch[1], missing: missing.join(", ") });
      }
    }
  }
  return violations;
}

function normalizeRelPath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

/** Count of descriptor-less `<OpKpi` blocks per scanned file. Pure — file
 *  list injected so tests stay hermetic. */
export function scanMissingDescriptors(files: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    const relPath = normalizeRelPath(file);
    const content = readFileSync(file, "utf8");
    const missing = extractOpKpiBlocks(content).filter((b) => !hasDescriptorId(b)).length;
    if (missing > 0) counts.set(relPath, missing);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Main scan
// ---------------------------------------------------------------------------

const SCAN_FILES = globSync("{app/gob,app/admin}/**/*.tsx").filter((f) => {
  const p = normalizeRelPath(f);
  if (p.includes("__tests__/") || p.endsWith(".test.tsx")) return false;
  return true;
});

type Baseline = Record<string, number>;

function loadBaseline(): Baseline {
  if (!existsSync(BASELINE_PATH)) return {};
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
}

function writeBaseline(counts: Map<string, number>): void {
  const sorted: Baseline = {};
  for (const key of [...counts.keys()].sort()) sorted[key] = counts.get(key) as number;
  writeFileSync(BASELINE_PATH, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
}

function runScan(): void {
  // FAIL CLOSED: an empty glob means the scan ran from the wrong directory —
  // that must never read as "no violations" (same posture as
  // check-metric-labels.ts's SCAN_FILES.length guard).
  if (SCAN_FILES.length === 0) {
    console.error("✗ check-metric-contract: no .tsx files matched under app/gob or app/admin.");
    process.exit(1);
  }

  const counts = scanMissingDescriptors(SCAN_FILES);

  // Rule 2 — guard feeding: hard failure, no baseline (repo verified clean on
  // the day this landed; see the rule's comment block above).
  const guardNeeds = new Map<string, GuardNeeds>();
  for (const catalogPath of CATALOG_PATHS) {
    for (const [id, need] of parseCatalogGuardNeeds(readFileSync(catalogPath, "utf8"))) {
      guardNeeds.set(id, need);
    }
  }
  const guardViolations = scanGuardFeeding(SCAN_FILES, guardNeeds);
  if (guardViolations.length > 0) {
    for (const v of guardViolations) {
      console.error(
        `✗ ${v.file}: <OpKpi descriptorId="${v.descriptorId}"> declares guards needing guardInput key(s) [${v.missing}] but does not pass them — the guard can never fire (dead-guard class). Feed the key(s) via guardInput, or set \`manualEnforcement: true\` on the descriptor's guards WITH a comment naming the dedicated helper path that enforces them.`,
      );
    }
    console.error(`\n✗ ${guardViolations.length} dead-guard violation(s).`);
    process.exit(1);
  }

  if (process.argv.includes("--write-baseline")) {
    writeBaseline(counts);
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    console.log(
      `✓ wrote baseline: ${counts.size} file(s), ${total} descriptor-less <OpKpi> tile(s) grandfathered.`,
    );
    return;
  }

  const baseline = loadBaseline();
  let failures = 0;
  let grandfathered = 0;

  for (const [file, count] of counts) {
    const allowed = baseline[file] ?? 0;
    if (count > allowed) {
      failures += 1;
      console.error(
        `✗ ${file}: ${count} descriptor-less <OpKpi> tile(s) (baseline allows ${allowed}) — add a \`descriptorId\` prop resolving a lib/metrics/kpi-catalog.ts entry, or run \`pnpm tsx scripts/check-metric-contract.ts --write-baseline\` only if this is an intentional NEW pre-existing tile being grandfathered (prefer fixing it instead).`,
      );
    } else {
      grandfathered += count;
    }
  }

  // A file present in the baseline but absent from `counts` (0 violations
  // now) is progress — the ratchet should tighten, not silently drift stale.
  const stale = Object.keys(baseline).filter((f) => !counts.has(f));
  if (stale.length > 0) {
    console.warn(
      `[info] ${stale.length} baselined file(s) no longer have any descriptor-less <OpKpi> — regenerate the baseline (--write-baseline) to tighten the ratchet: ${stale.join(", ")}`,
    );
  }

  if (failures > 0) {
    console.error(`\n✗ ${failures} file(s) exceed their metric-contract baseline.`);
    process.exit(1);
  }

  console.log(
    `✓ metric-contract fence clean — ${grandfathered} grandfathered descriptor-less <OpKpi> tile(s) across ${Object.keys(baseline).length} baselined file(s); no NEW descriptor-less tiles.`,
  );
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-metric-contract.ts") ||
    process.argv[1].endsWith("check-metric-contract.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  runScan();
}

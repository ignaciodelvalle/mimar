// KPI label/definition consistency guard — night-1 dataviz/honesty audit,
// item 2 ("metric-definition registry surfaced per-surface").
//
// WHY THIS EXISTS
// ----------------
// The four-actor critique (critique-govt-2026-07-03.md) found "Cobertura
// antirrábica" rendered 42% on the Panel/Panorama and 54% on Analítica/
// Vigilancia — SAME label, TWO different computations. lib/metrics/
// kpi-catalog.ts fixed the underlying definitions by giving each computation
// its own distinct label. This script is the REGRESSION GUARD: it scans every
// <OpKpi>/<OpKpiSm> tile render site for a `label` + `info.definition` pair
// and fails if the SAME label text is rendered with a DIFFERENT `definition`
// string somewhere else in the app — the exact shape of the original bug.
//
// STATIC-ANALYSIS SCOPE (precision over recall — same posture as
// scripts/check-ui-invariants.ts):
//   - Only STATIC `label="..."` / `label={\`...\`}` (no ${}) string labels are
//     compared. A dynamic label (`label={someVar}`, a ternary, or a template
//     with interpolation) cannot be resolved without a full type-checker, so
//     it is SKIPPED from the cross-file comparison — it neither passes nor
//     fails the guard on its own.
//   - Same rule for `info.definition`: only a static string/template (no ${})
//     is compared. A dynamic definition is skipped (unverifiable), not flagged.
//   - This means the guard can MISS a real conflict hidden behind a dynamic
//     label or definition. It will never falsely fail on one.
//
// SURFACE SCOPE: this only covers the OpKpi/OpKpiSm "tile info tooltip"
// pattern (components/ui/dashboard/OpKpi.tsx's `info` prop). Panorama legends
// (components/panorama/MapLegends.tsx) and analytics tables do not yet carry
// their own per-cell definition tooltips — extending this guard to those is
// follow-up work once they grow a definition surface of their own.
//
// BASELINE (2026-07-10): a first run found 16 same-label/different-definition
// pairs. 15 of them are the SAME metric described with parameterized SCOPE
// wording (nacional/admin vs "en tu jurisdicción"/"en el scope"/"scoped") —
// legitimate, not a "two truths" bug — and are allowlisted below with the
// admin/gob file pair as evidence. The 16th ("Activas" reused on
// /gob/perdidas for a completely different metric — active LOST cases, not
// active-status pets) was a genuine collision; it was renamed to "Perdidas
// activas" in the same commit that added this guard, so it is NOT allowlisted.
//
// Run: pnpm tsx scripts/check-metric-labels.ts
// Or:  pnpm lint:metric-labels
//
// Exits 1 with file:line pairs on each hit. Exits 0 if clean.

import { globSync, readFileSync } from "node:fs";

import { KPI_CATALOG } from "../lib/metrics/kpi-catalog";

// ---------------------------------------------------------------------------
// Allowlist — "label" strings whose static definition legitimately differs
// ONLY by admin (national) vs gob (jurisdiction-scoped) wording. Each entry
// must be re-justified if a THIRD, genuinely different definition shows up
// under the same label — add a comment, don't just extend the list blindly.
// ---------------------------------------------------------------------------
export const METRIC_LABEL_ALLOWLIST = new Set<string>([
  // app/admin/adopciones/page.tsx vs app/gob/adopciones/page.tsx — same
  // fetchCustodyFunnel-derived counts, "a nivel nacional" vs jurisdiction scope.
  "En custodia (refugio)",
  "En tránsito (foster)",
  "Adopciones",
  "Tasa de retorno",
  // app/admin/censo/page.tsx vs app/gob/censo/page.tsx (+ app/admin/programa,
  // app/gob/programa for "Total registradas") — same registryCounts()/
  // identificationFunnel() fetchers, national vs jurisdiction-scope wording.
  "Total registradas",
  "Perfiles incompletos",
  // "Activas" — app/gob/censo's "Activas" (status='active' pets) and
  // app/admin/censo's twin are the legitimate scope-wording pair (allowlisted
  // below). A THIRD, unrelated "Activas" used to live on /gob/perdidas (active
  // LOST cases, a completely different metric) — THAT was the real collision
  // this guard caught; it was renamed to "Perdidas activas" in the same commit
  // that added this guard, so only the legitimate two-way pair remains.
  "Activas",
  // app/admin/poblacion/page.tsx vs app/gob/poblacion/page.tsx — same
  // population-control fetchers, national vs jurisdiction-scope wording.
  "Cobertura de esterilización",
  // "Preñeces activas" removed 2026-09-16: both render sites now take the
  // catalogued label ("Preñeces en seguimiento") and a getKpiInfo() definition,
  // so there is no static definition pair left for the scan to compare.
  "Nacimientos registrados",
  "Altas netas registradas",
  // app/admin/programa/page.tsx vs app/gob/programa/page.tsx (+ app/gob/sistema,
  // components/admin/AdminKpiStrip.tsx) — same ENO SLA / approval-queue
  // fetchers, "(A7)" note present or absent, national vs jurisdiction wording.
  // FOLLOW-UP (out of tonight's scope): harmonise these four render sites onto
  // ONE prose string per label, ideally sourced from lib/metrics/kpi-catalog.ts
  // once ENO SLA / approval-queue KPIs are catalogued there.
  // Renamed 2026-07-23 (PO interview, item 5 nav rename "Cola" → "Aprobaciones"):
  // "Cola más vieja" → "Aprobaciones — más vieja", "Cola pendiente" →
  // "Aprobaciones pendientes" — same legitimate national/jurisdiction pair,
  // new label text.
  "SLA ENO (resueltos)",
  "SLA ENO",
  "Aprobaciones — más vieja",
  "Aprobaciones pendientes",
  "Provincias en alerta",
]);

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

type LabelHit = {
  file: string;
  line: number;
  /** The captured static label text, or null if the label is dynamic. */
  label: string | null;
  /** The captured static definition text, or null if absent/dynamic. */
  definition: string | null;
};

/** Extract every `<OpKpi` / `<OpKpiSm` JSX block from file content, using a
 * brace-depth scan to find each tag's end (handles multi-line `info={{...}}`
 * blocks). Mirrors the "no full JSX parser" posture of check-ui-invariants.ts. */
function extractOpKpiBlocks(content: string): Array<{ block: string; line: number }> {
  const blocks: Array<{ block: string; line: number }> = [];
  const tagRe = /<OpKpi(?:Sm)?\b/g;
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
    if (end !== -1) {
      const line = content.slice(0, start).split(/\r?\n/).length;
      blocks.push({ block: content.slice(start, end), line });
    }
    match = tagRe.exec(content);
  }
  return blocks;
}

/** Static `label="..."` or `label={\`static template\`}` — null if dynamic. */
function extractLabel(block: string): string | null {
  let m = block.match(/label\s*=\s*"([^"]*)"/);
  if (m) return m[1];
  m = block.match(/label\s*=\s*\{\s*`([^`]*)`\s*\}/);
  if (m && !m[1].includes("${")) return m[1];
  return null;
}

/** Static `definition: "..."` or `` definition: `static template` `` — null if
 * absent or dynamic (interpolated template / any other expression). */
function extractDefinition(block: string): string | null {
  const idx = block.indexOf("definition:");
  if (idx === -1) return null;
  const rest = block.slice(idx + "definition:".length).trimStart();
  if (rest[0] === '"') {
    const m = rest.match(/^"((?:[^"\\]|\\.)*)"/);
    return m ? m[1] : null;
  }
  if (rest[0] === "`") {
    const end = rest.indexOf("`", 1);
    if (end === -1) return null;
    const text = rest.slice(1, end);
    return text.includes("${") ? null : text;
  }
  return null;
}

function normalizeRelPath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

// ---------------------------------------------------------------------------
// Main scan
// ---------------------------------------------------------------------------

const EXCLUDE_PATH_PREFIXES = ["node_modules/", ".design-sync/"];

const SCAN_FILES = globSync("{app,components}/**/*.tsx").filter((f) => {
  const p = normalizeRelPath(f);
  if (EXCLUDE_PATH_PREFIXES.some((prefix) => p.startsWith(prefix) || p.includes(`/${prefix}`))) {
    return false;
  }
  // Test files render fixtures/mocks, not the real definition copy.
  if (p.includes("__tests__/") || p.endsWith(".test.tsx")) return false;
  return true;
});

export function scanForLabelConflicts(files: string[]): Map<string, LabelHit[]> {
  const byLabel = new Map<string, LabelHit[]>();
  for (const file of files) {
    const relPath = normalizeRelPath(file);
    const content = readFileSync(file, "utf8");
    for (const { block, line } of extractOpKpiBlocks(content)) {
      const label = extractLabel(block);
      if (label === null) continue; // dynamic label — unverifiable, skip
      const definition = extractDefinition(block);
      const hit: LabelHit = { file: relPath, line, label, definition };
      const list = byLabel.get(label) ?? [];
      list.push(hit);
      byLabel.set(label, list);
    }
  }
  return byLabel;
}

// ---------------------------------------------------------------------------
// Registry-import fence (Wave M) — catalogued labels must come FROM the
// catalog, not be retyped inline.
// ---------------------------------------------------------------------------
//
// The label-conflict scan above catches the moment two render sites DIVERGE.
// This second fence removes the precondition: a .tsx that renders a label
// already catalogued in lib/metrics/kpi-catalog.ts must import it (the
// catalog entry's `label`, or a lib-level label constant like
// RABIES_COVERAGE_LABEL_ES that the catalog cross-references) instead of
// retyping the string. An inline retype is exactly how the 42%/54% drift
// started: copy the string today, edit one copy tomorrow.
//
// Detection: an exact quoted occurrence ("...", '...', or `...`) of a
// catalogued label string in a scanned .tsx file. Current inliners are
// grandfathered below at their measured count (2026-07-18) — burn them down
// by importing the label; never add new ones.

/** Per-file inline-catalog-label counts measured 2026-07-18. A count ABOVE
 *  the baseline (or any brand-new file) fails. Migrating a file to import its
 *  label from the registry lets its entry be removed — the ratchet only
 *  tightens. */
export const INLINE_CATALOG_LABEL_BASELINE: Record<string, number> = {};

export type InlineLabelHit = { file: string; label: string; count: number };

/** Count exact quoted occurrences of each catalogued label per file. Pure —
 * label set is injected so unit tests stay hermetic. */
export function scanForInlineCatalogLabels(
  files: string[],
  labels: readonly string[],
): InlineLabelHit[] {
  const hits: InlineLabelHit[] = [];
  for (const file of files) {
    const relPath = normalizeRelPath(file);
    const content = readFileSync(file, "utf8");
    for (const label of labels) {
      let count = 0;
      for (const quoted of [`"${label}"`, `'${label}'`, `\`${label}\``]) {
        count += content.split(quoted).length - 1;
      }
      if (count > 0) hits.push({ file: relPath, label, count });
    }
  }
  return hits;
}

function runInlineLabelScan(): number {
  const catalogLabels = Object.values(KPI_CATALOG).map((d) => d.label);
  const hits = scanForInlineCatalogLabels(SCAN_FILES, catalogLabels);

  const perFile = new Map<string, InlineLabelHit[]>();
  for (const hit of hits) {
    const list = perFile.get(hit.file) ?? [];
    list.push(hit);
    perFile.set(hit.file, list);
  }

  let failures = 0;
  let grandfathered = 0;
  for (const [file, fileHits] of perFile) {
    const total = fileHits.reduce((sum, h) => sum + h.count, 0);
    const allowed = INLINE_CATALOG_LABEL_BASELINE[file] ?? 0;
    if (total > allowed) {
      failures += 1;
      for (const h of fileHits) {
        console.error(
          `${file}: inlines catalogued KPI label ${JSON.stringify(h.label)} ×${h.count} (baseline allows ${allowed} total) — import the label from lib/metrics/kpi-catalog.ts (KPI_CATALOG entry or its lib-level label constant) instead of retyping the string.`,
        );
      }
    } else {
      grandfathered += total;
    }
  }

  const stale = Object.keys(INLINE_CATALOG_LABEL_BASELINE).filter((f) => !perFile.has(f));
  if (stale.length > 0) {
    console.warn(
      `[info] ${stale.length} baselined file(s) no longer inline any catalog label — remove from INLINE_CATALOG_LABEL_BASELINE to tighten the ratchet: ${stale.join(", ")}`,
    );
  }

  if (failures === 0) {
    console.log(
      `✓ catalog-label imports clean — ${grandfathered} grandfathered inline literal(s) across ${Object.keys(INLINE_CATALOG_LABEL_BASELINE).length} baselined file(s); new inline retypes of catalogued labels fail.`,
    );
  }
  return failures;
}

function runScan(): void {
  // FAIL CLOSED: an empty glob means the scan ran from the wrong directory —
  // that must never read as "no conflicts".
  if (SCAN_FILES.length === 0) {
    console.error("✗ check-metric-labels: no .tsx files matched under app/ + components/.");
    process.exit(1);
  }

  const inlineFailures = runInlineLabelScan();

  const byLabel = scanForLabelConflicts(SCAN_FILES);
  let hits = 0;
  let allowlistedCount = 0;

  for (const [label, entries] of byLabel) {
    if (entries.length < 2) continue;
    const withStaticDef = entries.filter((e) => e.definition !== null);
    const uniqueDefs = new Set(withStaticDef.map((e) => e.definition));
    if (uniqueDefs.size <= 1) continue; // no conflict (or nothing to compare)

    if (METRIC_LABEL_ALLOWLIST.has(label)) {
      allowlistedCount += 1;
      continue;
    }

    hits += 1;
    console.error(`\n✗ KPI label "${label}" renders ${uniqueDefs.size} different definitions:`);
    for (const e of withStaticDef) {
      console.error(`  ${e.file}:${e.line}  ${JSON.stringify(e.definition)}`);
    }
  }

  if (hits > 0) {
    console.error(
      `\n✗ ${hits} KPI label/definition conflict(s). Same label, different truths — the exact "Cobertura antirrábica 42% vs 54%" shape (critique-govt-2026-07-03.md). Either unify the definition text, give the KPI a distinct label, or — if the difference is a legitimate admin(national) vs gob(jurisdiction-scope) wording variant — add the label to METRIC_LABEL_ALLOWLIST in scripts/check-metric-labels.ts with a justification comment.`,
    );
  }

  if (hits > 0 || inlineFailures > 0) {
    if (inlineFailures > 0) {
      console.error(
        `\n✗ ${inlineFailures} file(s) inline a catalogued KPI label above baseline (registry-import fence).`,
      );
    }
    process.exit(1);
  }

  console.log(
    `✓ KPI labels consistent — ${byLabel.size} distinct labels across ${SCAN_FILES.length} files ` +
      `(${allowlistedCount} allowlisted national/jurisdiction-scope wording pairs).`,
  );
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-metric-labels.ts") ||
    process.argv[1].endsWith("check-metric-labels.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  runScan();
}

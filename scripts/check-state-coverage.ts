// State-coverage fence — CI guard (Wave 2 / Level 2 state completeness,
// dim-interno:docs/reviews/results/2026-07-21-audit-2-estados.md).
//
// The audit found three foundational gaps worth locking down cheaply, without
// trying to be a perfect state-coverage oracle:
//
//   1. PORTAL ERROR BOUNDARY (hard, no baseline) — every top-level portal
//      segment (gob/admin/org/(app)/(public)) must ship its own error.tsx.
//      This is currently 100% true; the fence exists so it STAYS true — a
//      portal losing its error.tsx silently is a regression, not a gap to
//      grandfather.
//   2. SHELL STATE-PRIMITIVE MOUNTS (hard, no baseline) — the offline banner
//      and maintenance screen primitives landed in Wave 2 foundation
//      (commit 4c9167a3) inside each operator/citizen shell layout. A future
//      layout refactor could drop the import/JSX silently (no type error, no
//      runtime error — just a missing banner). This fence greps for both
//      symbols in each shell file.
//   3. LOADING-SKELETON FLOOR (ratchet) — a floor on the total count of
//      segment-specific loading.tsx files app-wide. Wave 2 raised this from
//      13 to the count recorded in the baseline; the floor can only go UP
//      (regenerate via --write-baseline after adding new segment skeletons),
//      never down — a segment loading.tsx quietly deleted fails CI.
//   4. EMPTY-STATE COVERAGE (ratchet, best-effort) — a page.tsx that renders
//      an `OpFilterBar` (the operator list/dashboard signal) is expected to
//      have an empty-state signal somewhere in its own directory: the
//      `LnEmptyState` component, the shared `OpCallout` component, or the
//      dominant inline idiom `X.length === 0 ? <fallback/> : <list/>`.
//      This is a heuristic, not a parser: baseline absorbs remaining gaps
//      that are false positives — the empty state lives in a shared child
//      component in a DIFFERENT directory the same-dir sibling scan can't
//      see (e.g. CaseQueue's `emptyMessage` prop), or the page isn't
//      actually list-shaped despite mounting OpFilterBar (e.g. a KPI
//      dashboard) — and only a NEW gap (a new list screen shipped with no
//      empty-state signal at all in its own folder) fails CI.
//   5. EPISTEMIC NATURE ON SURVEILLANCE EMPTY-STATES (ratchet, best-effort,
//      C4 — 2026-07-22, dim-interno:docs/reviews/results/2026-07-22-plan-maestro-integridad.md
//      §C4 / S4). Wave 2's state system guarantees a state EXISTS, not that
//      it tells the epistemic truth: an empty vigilancia/observaciones list
//      reads as "todo tranquilo" when the honest reading can be "MiMAR no
//      recibió señales" (red-team #10 zeros=green, #6 690 bites + 0
//      observations read as "under control"). On the two epidemiological
//      surveillance surfaces below, every `LnEmptyState`/`OpCallout` render
//      must declare an explicit `nature="measured-zero" | "no-signal"` prop
//      (see components/ui/EmptyState.tsx / components/ui/dashboard/OpCallout.tsx).
//      File-scoped heuristic, not a JSX parser — same shape as rule 4:
//      baseline absorbs files where LnEmptyState/OpCallout renders something
//      OTHER than a data empty-state (an info callout about an EXISTING
//      record, a field-presence check unrelated to signal absence — e.g.
//      "microchip no registrado") that a nature classification doesn't fit;
//      only a NEW un-classified empty-state render on these surfaces fails CI.
//
// Baseline: scripts/state-coverage-baseline.json — regenerate with
//   pnpm tsx scripts/check-state-coverage.ts --write-baseline
// Rules 1–2 have no baseline entries (hard invariants); rule 3 is a single
// floor number; rules 4–5 are per-file allow-lists, same ratchet shape as
// check-eyebrow-title.ts / check-tablist-ratchet.ts.
//
// Run: pnpm tsx scripts/check-state-coverage.ts   (or: pnpm lint:states)
// Exits 0 when clean; exits 1 listing each violation.

import { existsSync, globSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = resolve(ROOT, "scripts/state-coverage-baseline.json");

// ---------------------------------------------------------------------------
// Rule 1 — portal error.tsx presence (hard invariant, no baseline)
// ---------------------------------------------------------------------------

const REQUIRED_PORTAL_ERROR_BOUNDARIES: string[] = [
  "app/gob/error.tsx",
  "app/admin/error.tsx",
  "app/org/[orgToken]/error.tsx",
  "app/(app)/error.tsx",
  "app/(public)/error.tsx",
];

function checkPortalErrorBoundaries(): string[] {
  const missing: string[] = [];
  for (const segment of REQUIRED_PORTAL_ERROR_BOUNDARIES) {
    if (!existsSync(resolve(ROOT, segment))) missing.push(segment);
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Rule 2 — shell state-primitive mounts (hard invariant, no baseline)
// ---------------------------------------------------------------------------

type ShellSpec = { file: string; offline: RegExp; maintenance: RegExp };

const REQUIRED_SHELL_MOUNTS: ShellSpec[] = [
  { file: "app/(app)/layout.tsx", offline: /LnOfflineBanner/, maintenance: /LnMaintenanceScreen/ },
  { file: "app/gob/layout.tsx", offline: /OpOfflineBanner/, maintenance: /OpMaintenanceScreen/ },
  { file: "app/admin/layout.tsx", offline: /OpOfflineBanner/, maintenance: /OpMaintenanceScreen/ },
  {
    file: "app/org/[orgToken]/layout.tsx",
    offline: /OpOfflineBanner/,
    maintenance: /OpMaintenanceScreen/,
  },
];

function checkShellMounts(): string[] {
  const violations: string[] = [];
  for (const shell of REQUIRED_SHELL_MOUNTS) {
    const path = resolve(ROOT, shell.file);
    if (!existsSync(path)) {
      violations.push(`${shell.file}: file missing`);
      continue;
    }
    const src = readFileSync(path, "utf8");
    if (!shell.offline.test(src)) {
      violations.push(`${shell.file}: missing ${shell.offline.source} (offline banner)`);
    }
    if (!shell.maintenance.test(src)) {
      violations.push(`${shell.file}: missing ${shell.maintenance.source} (maintenance screen)`);
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Rule 3 — loading-skeleton floor (ratchet, single number)
// ---------------------------------------------------------------------------

function countLoadingSegments(): number {
  return globSync("app/**/loading.tsx", { cwd: ROOT })
    .map((f) => f.replaceAll("\\", "/"))
    .filter((f) => !f.includes("node_modules/")).length;
}

// ---------------------------------------------------------------------------
// Rule 4 — empty-state coverage for list-shaped pages (ratchet, best-effort)
// ---------------------------------------------------------------------------

const PORTAL_ROOTS = ["app/gob", "app/admin", "app/org", "app/(app)", "app/(public)"];

/** Heuristic: a page.tsx that renders `OpFilterBar` is a list/dashboard screen. */
const LIST_SIGNAL_RE = /OpFilterBar/;

// HARDENING (2026-07-22 manual audit of the 17 baselined gaps): the original
// signal only matched the literal `LnEmptyState` component name. Every one of
// the 17 turned out to already render an honest "no rows" message — but the
// dominant idiom in this codebase is a bare `X.length === 0 ? <fallback /> :
// <list />` conditional (plain text, a dashed box, or the shared `OpCallout`
// component), NOT the `LnEmptyState` component. The signal-name-only regex
// never saw those, so it kept flagging pages that were already covered.
// Broadened to also recognize `OpCallout` and the `.length === 0` idiom
// itself. Still best-effort: a page whose zero-rows fallback lives in a
// CHILD COMPONENT IN A DIFFERENT DIRECTORY (not a same-dir sibling — e.g.
// CaseQueue's `emptyMessage` prop, AlertInboxTable's own branch) is still
// invisible to this file-scoped scan; those stay in the baseline.
const EMPTY_STATE_SIGNAL_RE = /EmptyState|OpCallout|\.length\s*===\s*0/;

function collectPortalPages(): string[] {
  const files: string[] = [];
  for (const root of PORTAL_ROOTS) {
    const matches = globSync("**/page.tsx", { cwd: resolve(ROOT, root) })
      .map((f) => `${root}/${f}`.replaceAll("\\", "/"))
      .filter((f) => !f.includes("node_modules/"));
    files.push(...matches);
  }
  return files.sort();
}

/** Direct (non-recursive) sibling .tsx files in the same directory, excluding tests. */
function siblingSources(pagePath: string): string[] {
  const dir = dirname(resolve(ROOT, pagePath));
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(".tsx") && !name.includes(".test."))
    .map((name) => join(dir, name));
}

/** A list-shaped page "has" an empty-state signal if it (or a direct sibling
 * file in its own directory — the list component is often split out) mentions
 * EmptyState. Best-effort: misses empty states implemented in a component
 * living deeper in a subdirectory — those gaps are absorbed by the baseline. */
function findEmptyStateGaps(pages: string[]): string[] {
  const gaps: string[] = [];
  for (const page of pages) {
    const src = readFileSync(resolve(ROOT, page), "utf8");
    if (!LIST_SIGNAL_RE.test(src)) continue;
    const ownSignal = EMPTY_STATE_SIGNAL_RE.test(src);
    const siblingSignal = ownSignal
      ? true
      : siblingSources(page).some((f) => EMPTY_STATE_SIGNAL_RE.test(readFileSync(f, "utf8")));
    if (!siblingSignal) gaps.push(page);
  }
  return gaps;
}

// ---------------------------------------------------------------------------
// Rule 5 — epistemic nature required on surveillance empty-states
// (ratchet, best-effort, per-file allow-list — see block comment above)
// ---------------------------------------------------------------------------

// C4 first consumers: every EPIDEMIOLOGICAL surface, not just the two
// surveillance queues. Panorama is the flagship one — it was outside this fence
// while printing "Sin jurisdicciones bajo meta" (an all-clear) on a ranking
// that had measured nothing. The components/panorama root is included because
// the console's empty-states live in components, not under app/.
const SURVEILLANCE_ROOTS = [
  "app/gob/vigilancia",
  "app/admin/observaciones",
  "app/gob/panorama",
  "app/admin/panorama",
  "components/panorama",
];
const EPISTEMIC_COMPONENTS = ["LnEmptyState", "OpCallout"];

function collectSurveillanceFiles(): string[] {
  const files: string[] = [];
  for (const root of SURVEILLANCE_ROOTS) {
    const matches = globSync("**/*.tsx", { cwd: resolve(ROOT, root) })
      .map((f) => `${root}/${f}`.replaceAll("\\", "/"))
      .filter((f) => !f.includes("node_modules/") && !f.includes(".test."));
    files.push(...matches);
  }
  return files.sort();
}

/** Extract a self-closing JSX tag's full source text starting at `openIdx`
 * (the index of its leading `<`). Tracks `{…}` brace depth so a nested
 * self-closing element in a prop value (e.g. `icon={<Icon .../>}`) doesn't
 * fool the scan into stopping at the INNER `/>` — only a `/>` at brace depth
 * 0 ends the outer tag. Returns null if no such `/>` is found (e.g. the
 * component isn't used self-closing here — out of scope for this heuristic). */
function extractSelfClosingTag(src: string, openIdx: number): string | null {
  let braceDepth = 0;
  for (let i = openIdx; i < src.length - 1; i++) {
    const ch = src[i];
    if (ch === "{") braceDepth++;
    else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (ch === "/" && src[i + 1] === ">" && braceDepth === 0) {
      return src.slice(openIdx, i + 2);
    }
  }
  return null;
}

/** True if `src` contains an LnEmptyState/OpCallout tag with no `nature=` prop.
 * Heuristic self-closing-tag scan (both components are always self-closed in
 * this codebase's current usage) — good enough for a file-scoped ratchet. */
function hasUnclassifiedEpistemicRender(src: string): boolean {
  for (const component of EPISTEMIC_COMPONENTS) {
    const openRe = new RegExp(`<${component}\\b`, "g");
    for (const open of src.matchAll(openRe)) {
      const tag = extractSelfClosingTag(src, open.index);
      if (tag && !/\bnature\s*=/.test(tag)) return true;
    }
  }
  return false;
}

function findEpistemicNatureGaps(files: string[]): string[] {
  return files.filter((f) => {
    const src = readFileSync(resolve(ROOT, f), "utf8");
    if (!EPISTEMIC_COMPONENTS.some((c) => src.includes(`<${c}`))) return false;
    return hasUnclassifiedEpistemicRender(src);
  });
}

// ---------------------------------------------------------------------------
// Baseline I/O
// ---------------------------------------------------------------------------

type Baseline = {
  _meta: { generatedAt: string; description: string };
  minLoadingSegments: number;
  emptyStateGaps: string[];
  epistemicNatureGaps: string[];
};

function loadBaseline(): Baseline {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
  } catch {
    console.warn(
      `[warn] ${BASELINE_PATH} not found — every gap will fail. Regenerate with: pnpm tsx scripts/check-state-coverage.ts --write-baseline`,
    );
    return {
      _meta: { generatedAt: "", description: "" },
      minLoadingSegments: 0,
      emptyStateGaps: [],
      epistemicNatureGaps: [],
    };
  }
}

function writeBaseline(loadingCount: number, gaps: string[], natureGaps: string[]): void {
  const baseline: Baseline = {
    _meta: {
      generatedAt: new Date().toISOString().slice(0, 10),
      description:
        "Wave 2 state-coverage fence baseline. minLoadingSegments is a FLOOR (only raise it, via --write-baseline, after adding new segment loading.tsx files — never lower it by hand). emptyStateGaps grandfathers list-shaped pages (OpFilterBar signal) with no EmptyState signal in their own directory; curing a gap lets its entry be removed — new gaps not in this list fail lint:states. epistemicNatureGaps (C4, 2026-07-22) grandfathers files under app/gob/vigilancia/** and app/admin/observaciones/** where an LnEmptyState/OpCallout renders something other than a data empty-state (nature classification doesn't apply) — new un-classified surveillance empty-states not in this list fail lint:states.",
    },
    minLoadingSegments: loadingCount,
    emptyStateGaps: gaps,
    epistemicNatureGaps: natureGaps,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(
    `✓ Wrote baseline: minLoadingSegments=${loadingCount}, emptyStateGaps=${gaps.length}, epistemicNatureGaps=${natureGaps.length} to ${BASELINE_PATH}.`,
  );
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function runChecks(): void {
  let hits = 0;

  const missingBoundaries = checkPortalErrorBoundaries();
  for (const segment of missingBoundaries) {
    console.error(`✗ ${segment}: required portal error.tsx is missing.`);
    hits += 1;
  }

  const shellViolations = checkShellMounts();
  for (const v of shellViolations) {
    console.error(`✗ ${v} — offline/maintenance primitive must stay mounted in the shell.`);
    hits += 1;
  }

  const baseline = loadBaseline();

  const loadingCount = countLoadingSegments();
  if (loadingCount === 0) {
    // FAIL CLOSED: zero loading.tsx app-wide means the glob ran from the
    // wrong place, not that every segment lost its skeleton.
    console.error(
      "✗ check-state-coverage: found 0 loading.tsx under app/**  — glob likely misfired.",
    );
    hits += 1;
  } else if (loadingCount < baseline.minLoadingSegments) {
    console.error(
      `✗ loading.tsx segment count dropped: ${loadingCount} found, floor is ${baseline.minLoadingSegments}. A segment-specific loading.tsx was likely deleted — restore it or lower the floor deliberately (--write-baseline) with a reviewed reason.`,
    );
    hits += 1;
  }

  const pages = collectPortalPages();
  if (pages.length === 0) {
    console.error(
      "✗ check-state-coverage: found 0 page.tsx across portal roots — glob likely misfired.",
    );
    hits += 1;
  }
  const gaps = findEmptyStateGaps(pages);
  const allowedGaps = new Set(baseline.emptyStateGaps);
  const newGaps = gaps.filter((g) => !allowedGaps.has(g));
  for (const g of newGaps) {
    console.error(
      `✗ ${g}: renders OpFilterBar (list/dashboard screen) with no EmptyState signal in its own directory — add LnEmptyState (or document why this screen is exempt and add it to the baseline).`,
    );
    hits += 1;
  }
  const staleGaps = baseline.emptyStateGaps.filter((g) => !gaps.includes(g));
  if (staleGaps.length > 0) {
    console.warn(
      `[info] ${staleGaps.length} baselined empty-state gap(s) are now clean — remove from ${BASELINE_PATH} to tighten the ratchet: ${staleGaps.join(", ")}`,
    );
  }

  const surveillanceFiles = collectSurveillanceFiles();
  const natureGaps = findEpistemicNatureGaps(surveillanceFiles);
  const allowedNatureGaps = new Set(baseline.epistemicNatureGaps);
  const newNatureGaps = natureGaps.filter((g) => !allowedNatureGaps.has(g));
  for (const g of newNatureGaps) {
    console.error(
      `✗ ${g}: renders LnEmptyState/OpCallout on a surveillance surface with no explicit nature prop — add nature="measured-zero" | "no-signal" (or document why this render isn't a data empty-state and add it to the baseline).`,
    );
    hits += 1;
  }
  const staleNatureGaps = baseline.epistemicNatureGaps.filter((g) => !natureGaps.includes(g));
  if (staleNatureGaps.length > 0) {
    console.warn(
      `[info] ${staleNatureGaps.length} baselined epistemic-nature gap(s) are now clean — remove from ${BASELINE_PATH} to tighten the ratchet: ${staleNatureGaps.join(", ")}`,
    );
  }

  if (hits > 0) {
    console.error(`\n✗ ${hits} state-coverage violation(s).`);
    process.exit(1);
  }

  console.log(
    `✓ state-coverage fence clean — ${REQUIRED_PORTAL_ERROR_BOUNDARIES.length} portal error boundaries, ${REQUIRED_SHELL_MOUNTS.length} shells with offline+maintenance mounted, ${loadingCount} loading.tsx segments (floor ${baseline.minLoadingSegments}), ${gaps.length} empty-state gaps grandfathered (of ${baseline.emptyStateGaps.length} baselined), ${natureGaps.length} epistemic-nature gaps grandfathered (of ${baseline.epistemicNatureGaps.length} baselined).`,
  );
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-state-coverage.ts") ||
    process.argv[1].endsWith("check-state-coverage.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  if (process.argv.includes("--write-baseline")) {
    writeBaseline(
      countLoadingSegments(),
      findEmptyStateGaps(collectPortalPages()),
      findEpistemicNatureGaps(collectSurveillanceFiles()),
    );
  } else {
    runChecks();
  }
}

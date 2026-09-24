// Icon registry fence — CI guard (nav-chrome icon duplication + registry bypass).
//
// Audit 2026-07-21 (dim-interno:docs/reviews/results/2026-07-21-audit-1-consistencia.md §5,
// "Icons — score 8/10") found the central icon registry (components/Icon.tsx,
// lucide-react backed) is respected almost everywhere in the app — 0 files
// import lucide-react directly outside Icon.tsx — EXCEPT 5 nav-chrome files
// that hand-rolled a HamburgerIcon / CloseIcon / ChevronIcon local component
// duplicating icons already registered (menu → Menu, close → X, chevron-down →
// ChevronDown). Those were the highest-visibility, highest-repetition icon
// usage in the app (the primary nav shells for both citizen and operator
// surfaces) and every one bypassed <Icon> with a stale comment claiming the
// registry didn't cover them. All 5 were migrated to <Icon name="..."/> in the
// same change that added this fence:
//   components/layout/AppCitizenMasthead.tsx, AppShellDrawer.tsx, HeaderNav.tsx,
//   ContextSwitcher.tsx, components/ui/dashboard/OpMobileDrawer.tsx
//
// Two rules:
//
//   (A) Hand-rolled "*Icon"-named component/function whose body renders a raw
//       <svg> — the HamburgerIcon/CloseIcon/ChevronIcon shape. RATCHET
//       (scripts/icon-registry-baseline.json, same shape as
//       check-professionalism.ts Rule 2 / check-eyebrow-title.ts): existing
//       custom glyphs with no registry equivalent (e.g. CitizenTabBar's
//       TabIcon — a bespoke bottom-tab pictogram set, not a registry
//       duplicate) are grandfathered at their current count. The 5 migrated
//       nav-chrome files above are deliberately NOT in the baseline (0
//       allowed) — this exact duplication can never quietly return to them.
//
//   (B) `import ... from "lucide-react"` anywhere outside components/Icon.tsx.
//       HARD rule, no baseline — confirmed 0 today, stays 0.
//
// Emoji-as-icon is intentionally NOT re-implemented here. It is already fully
// fenced by check-professionalism.ts: Rule 1 is a hard ban on emoji Unicode
// ranges outside comments, Rule 2 is a ratchet on standalone pseudo-icon glyphs
// (✓✗⚠★☆…). Duplicating that scan in this file would just be two fences
// maintaining the same regex; lint:professionalism already runs in `verify`.
//
// Detection is line-window / declaration-slice regex, same posture as
// check-tablist-ratchet.ts / check-eyebrow-title.ts / check-professionalism.ts
// — not a JSX parser. Test files are excluded (same convention as those
// fences): a `.test.tsx` referencing an inline SVG assertion is test surface,
// not UI drift. Legitimate non-icon raw <svg> usage (charts/dataviz,
// credential QR, poster rendering, coordinate-based sparkline/map paths,
// decorative brand marks) is not separately flagged by this fence at all — it
// only ever looks for the specific "*Icon"-named-function-with-svg-body shape
// (Rule A), which those files don't exhibit.
//
// Run: pnpm tsx scripts/check-icon-registry.ts   (or: pnpm lint:icons)
// Regenerate baseline (only after a deliberate, reviewed grandfather decision):
//   pnpm tsx scripts/check-icon-registry.ts --write-baseline
// Exits 1 with file:line on each new violation. Exits 0 if clean.

import { globSync, readFileSync, writeFileSync } from "node:fs";

const SOURCE_GLOB = "{app,components}/**/*.{ts,tsx}";
const REGISTRY_FILE = "components/Icon.tsx";
const BASELINE_PATH = "scripts/icon-registry-baseline.json";

function isExcluded(relPath: string): boolean {
  if (relPath.startsWith("node_modules/") || relPath.includes("/node_modules/")) return true;
  if (relPath.includes(".test.") || relPath.includes(".spec.")) return true;
  if (relPath.includes("__tests__/")) return true;
  if (relPath.includes(".stories.")) return true;
  return false;
}

const FILES = globSync(SOURCE_GLOB)
  .map((f) => f.replaceAll("\\", "/"))
  .filter((f) => !isExcluded(f));

// ---------------------------------------------------------------------------
// Rule A — hand-rolled "*Icon" component/function containing a raw <svg>
// ---------------------------------------------------------------------------

// Matches a top-level `function` or `const` declaration whose identifier ENDS
// in "Icon" (case-sensitive on the literal "Icon" suffix, matching the actual
// HamburgerIcon/CloseIcon/ChevronIcon/TabIcon naming convention used in this
// codebase) — the registry's own `Icon`/`FallbackIcon` live in
// components/Icon.tsx, which this scan skips entirely (see REGISTRY_FILE).
const ICON_FN_DECL = /(?:function|const)\s+([A-Za-z_]\w*Icon)\b/g;

export type IconFnHit = { name: string; line: number };

/**
 * Find every "*Icon"-named function/const declaration in `src` whose body
 * (from the declaration to the next top-level "*Icon" declaration, or EOF)
 * contains a literal `<svg` — i.e. a hand-rolled icon component, not a thin
 * wrapper that itself delegates to <Icon name=... /> (e.g. CasesWidget's
 * CaseIcon, which is named "*Icon" but renders <Icon name={icon} /> inside —
 * correctly NOT flagged, since its body has no raw <svg>).
 */
export function findIconFunctionSvgHits(src: string): IconFnHit[] {
  const hits: IconFnHit[] = [];
  const decls = [...src.matchAll(ICON_FN_DECL)];

  for (let i = 0; i < decls.length; i += 1) {
    const decl = decls[i];
    const name = decl[1];
    const declIndex = decl.index ?? 0;
    const start = declIndex + decl[0].length;
    const end = i + 1 < decls.length ? (decls[i + 1].index ?? src.length) : src.length;
    const body = src.slice(start, end);
    if (body.includes("<svg")) {
      const line = src.slice(0, declIndex).split(/\r?\n/).length;
      hits.push({ name, line });
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Rule B — lucide-react import outside the registry (hard, no baseline)
// ---------------------------------------------------------------------------

const LUCIDE_IMPORT = /^\s*import\s+.*\sfrom\s+["']lucide-react["']/;

// ---------------------------------------------------------------------------
// Baseline (Rule A only) — scripts/icon-registry-baseline.json
// ---------------------------------------------------------------------------

type BaselineFile = {
  _meta: { generatedAt: string; description: string };
  files: Record<string, number>;
};

function loadBaseline(): Record<string, number> {
  try {
    return (JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as BaselineFile).files;
  } catch {
    console.warn(
      `[warn] ${BASELINE_PATH} not found — Rule A will be strict (no grandfather). Run: pnpm tsx scripts/check-icon-registry.ts --write-baseline`,
    );
    return {};
  }
}

function writeBaseline(byFile: Map<string, IconFnHit[]>): void {
  const files: Record<string, number> = {};
  for (const [file, hits] of byFile) {
    files[file] = hits.length;
  }
  const output: BaselineFile = {
    _meta: {
      generatedAt: new Date().toISOString().slice(0, 10),
      description:
        "Hand-rolled *Icon-named components/functions that render a raw <svg> (Rule A), grandfathered at their current count. The 5 nav-chrome files migrated to <Icon> in the 2026-07-21 icon-registry fence change (components/layout/AppCitizenMasthead.tsx, AppShellDrawer.tsx, HeaderNav.tsx, ContextSwitcher.tsx, components/ui/dashboard/OpMobileDrawer.tsx) are deliberately NOT listed here — 0 allowed, so this exact duplication (menu/close/chevron re-hand-rolled instead of using the registry) can never quietly return to them. Files listed here (e.g. CitizenTabBar's TabIcon) are bespoke glyphs with no registry equivalent, not registry duplicates. New violations, or counts above baseline, fail lint:icons.",
    },
    files,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(output, null, 2)}\n`);
  const total = Object.values(files).reduce((a, b) => a + b, 0);
  console.log(
    `Baseline written: ${total} grandfathered hand-rolled icon component(s) across ${Object.keys(files).length} file(s).`,
  );
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

function measure(): Map<string, IconFnHit[]> {
  const byFile = new Map<string, IconFnHit[]>();
  for (const file of FILES) {
    if (file === REGISTRY_FILE) continue;
    const src = readFileSync(file, "utf8");
    const hits = findIconFunctionSvgHits(src);
    if (hits.length > 0) byFile.set(file, hits);
  }
  return byFile;
}

function runChecks(): void {
  const byFile = measure();
  const baseline = loadBaseline();
  let hits = 0;
  let grandfathered = 0;
  let lucideHits = 0;

  // --- Rule A: hand-rolled *Icon component/function with a raw <svg> body ---
  for (const [file, fileHits] of byFile) {
    const allowed = baseline[file] ?? 0;
    if (fileHits.length > allowed) {
      hits += 1;
      for (const h of fileHits) {
        console.error(
          `${file}:${h.line}: hand-rolled icon component "${h.name}" renders a raw <svg> (baseline allows ${allowed}) — use <Icon name="..."/> from components/Icon.tsx instead of duplicating a registry glyph.`,
        );
      }
    } else {
      grandfathered += fileHits.length;
    }
  }

  // --- Rule B: lucide-react import outside the registry (hard) ---
  for (const file of FILES) {
    if (file === REGISTRY_FILE) continue;
    const src = readFileSync(file, "utf8");
    src.split(/\r?\n/).forEach((line, i) => {
      if (LUCIDE_IMPORT.test(line)) {
        console.error(
          `${file}:${i + 1}: direct "lucide-react" import outside ${REGISTRY_FILE} — route new icons through the ICON_MAP registry instead.`,
        );
        hits += 1;
        lucideHits += 1;
      }
    });
  }

  const stale = Object.keys(baseline).filter((f) => !byFile.has(f));
  if (stale.length > 0) {
    console.warn(
      `[info] ${stale.length} baselined file(s) are now clean — remove them from ${BASELINE_PATH} to tighten the ratchet: ${stale.join(", ")}`,
    );
  }

  if (hits > 0) {
    console.error(
      `\n✗ ${hits} icon-registry violation(s) (${lucideHits} direct lucide-react import(s) outside the registry).`,
    );
    process.exit(1);
  }

  console.log(
    `✓ Icon registry clean — 0 direct lucide-react imports outside ${REGISTRY_FILE}, 0 new hand-rolled icon duplicates across ${FILES.length} files.`,
  );
  console.log(
    `  Ratchet: ${grandfathered} grandfathered hand-rolled icon component(s) across ${Object.keys(baseline).length} baselined file(s). New ones will fail.`,
  );
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-icon-registry.ts") ||
    process.argv[1].endsWith("check-icon-registry.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  if (process.argv.includes("--write-baseline")) {
    writeBaseline(measure());
  } else {
    runChecks();
  }
}

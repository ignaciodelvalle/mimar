// Lint guard for Poncho design tokens.
//
// Runs in CI to block re-introduction of:
//   1. Raw Tailwind palette utilities (bg-red-700, text-neutral-500, ring-blue-500,
//      etc.) — should always be a gob-* semantic token (bg-gob-danger,
//      text-gob-text-muted, ring-gob-azul-link, …).
//   2. `dark:` utility prefix — dark mode is disabled at the @variant level
//      in app/globals.css; prefixed classes never apply, so they are
//      visual rot that confuses code review.
//   3. Arbitrary hex values inside Tailwind arbitrary-value classnames
//      (e.g. bg-[#eef6f0], border-[#c8e2d2]) — use ln-* token utilities instead
//      (e.g. bg-[var(--color-ln-ok-050)], border-[var(--color-ln-ok-100)]).
//   4. Arbitrary text-[Npx] sizes — use Tailwind's NAMED size utilities
//      (text-sm, text-md, text-3xl, …), which read the --text-* theme scale.
//      NOT text-[var(--text-sm)]: see rule 9, that form silently does nothing.
//   5. Arbitrary spacing p/m/gap/space-[Npx|rem] — prefer Tailwind's default
//      spacing scale or --space-* custom tokens.
//   6. Arbitrary rounded-[Npx] radius — use --radius-xs/sm/md/lg tokens instead.
//   7. Arbitrary shadow-[...] — use --shadow-sm/md/lg tokens instead.
//   8. Hex literals in style=/inline CSS props — replace with CSS vars.
//   9. text-[var(--text-*)] — a DEAD font-size (compiles to `color`).
//  10. font-[var(--font-*)] — a DEAD font-family (compiles to `font-weight`).
//      Use the named family utility (font-ln-mono/serif/sans).
//
// Rules 4-10 use a RATCHET baseline (scripts/design-tokens-baseline.json):
//   - Existing violations in baselined files are grandfathered (pass today).
//   - Any NEW violation (new file or count above baseline) FAILS.
//   - To clear debt: migrate a file, lower its count in the baseline, or
//     remove it entirely once fully migrated.
//
// Run: pnpm tsx scripts/check-design-tokens.ts
// Or:  pnpm lint:tokens
//   … --list-css            print every current CSS violation with file:line:col
//   … --write-css-baseline  regenerate scripts/design-tokens-css-baseline.json
//
// Exits 1 with file:line:col on each hit. Exits 0 if clean.
//
// Autofix: scripts/codemod-poncho-tokens.ts (palette) +
// scripts/codemod-purge-dark.ts (dark prefix) +
// scripts/codemod-status-tints.cjs (hex tints → ln-* tokens).
// Add new mappings to those scripts when this guard catches a pattern they don't yet cover.
//
// Rules C1-C8 apply the same idea to .css files (see scripts/css-token-scan.ts),
// under their own ratchet baseline: scripts/design-tokens-css-baseline.json.
//
// Note: .css files USED to be outside every fence, and this comment used to say
// "app/globals.css is .css, so it's never globbed in" as though that were a
// property of the file rather than a hole in the guard. It was a hole: the file
// that DEFINES the typographic scale ignored it in 96% of its own font-size
// declarations, and three measured defects came in through it (RA-10,
// 2026-07-31). Rules C1-C8 close it. Regenerate the CSS baseline with:
//   pnpm tsx scripts/check-design-tokens.ts --write-css-baseline
//
// components/ui/** is now INCLUDED — the exclusion was removed per Wave-3 audit
// (§6.5) because 90% of arbitrary values live there.

import { globSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { sep } from "node:path";

import { stripComments } from "./lib/strip-comments.mjs";

import {
  CSS_CATEGORIES,
  CSS_CATEGORY_HINTS,
  type CssCounts,
  ZERO_CSS_COUNTS,
  loadFontWeightSets,
  scanCss,
  tallyCss,
} from "./css-token-scan";

// ---------------------------------------------------------------------------
// File set — no components/ui/ exclusion (removed per Wave-3 audit §6.5)
// ---------------------------------------------------------------------------

const EXCLUDE_PATH_PREFIXES = ["node_modules/"];
const FILES = globSync("{app,components}/**/*.{ts,tsx}").filter((f) => {
  const p = f.replaceAll("\\", "/");
  // Test/spec files reference className strings inside assertions (e.g.
  // toHaveClass("rounded-[3px]")) — that is test surface, not styling drift, so
  // exclude them (same convention lint:select/lint:buttons use for tests).
  if (p.includes(".test.") || p.includes(".spec.")) return false;
  return !EXCLUDE_PATH_PREFIXES.some((prefix) => p.startsWith(prefix) || p.includes(`/${prefix}`));
});

// Every stylesheet in the repo. Four files, all previously unfenced:
// app/globals.css plus the three per-document print sheets.
const CSS_FILES = globSync("{app,components}/**/*.css").filter(
  (f) => !f.replaceAll("\\", "/").includes("node_modules/"),
);

const CSS_BASELINE_PATH = "scripts/design-tokens-css-baseline.json";

// ---------------------------------------------------------------------------
// Rules 1–3 (pre-existing hard rules — no ratchet, always fail on any hit)
// ---------------------------------------------------------------------------

const RAW_PALETTE_FAMILIES =
  "neutral|zinc|slate|stone|gray|amber|emerald|sky|indigo|rose|red|blue|yellow|pink|purple|orange|teal|cyan|lime|fuchsia|violet|green";
const RAW_PALETTE_UTILITIES =
  "bg|text|border|ring|divide|from|to|via|outline|shadow|placeholder|fill|stroke|caret|decoration|accent";
const RAW_PALETTE = new RegExp(
  `\\b(${RAW_PALETTE_UTILITIES})-(${RAW_PALETTE_FAMILIES})-\\d+(?:\\/\\d+)?\\b`,
  "g",
);
const DARK_PREFIX = /\bdark:[\w\-/[\]()%.:]+/g;

// Arbitrary hex values in Tailwind arbitrary-value classnames.
// Matches patterns like: bg-[#abc], border-[#f1c6bf], text-[#123456ff]
// Use ln-* token utilities instead (e.g. bg-[var(--color-ln-ok-050)]).
const ARBITRARY_HEX =
  /\b(?:bg|text|border|ring|outline|fill|stroke|from|to|via)-\[#[0-9a-fA-F]{3,8}\]/g;

// Allowlist: hex values with no direct token equivalent that are intentionally left as-is.
// Each entry must include a justification comment.
const ARBITRARY_HEX_ALLOWLIST = new Set<string>([
  // components/ui/Sheet.tsx — #fcfbf7 is a warm paper tone used in the bottom
  // sheet handle; grandfathered from the pre-Wave-3 components/ui/ exclusion.
  // Migration: add --color-ln-paper-warm token when the Sheet is refactored.
  "bg-[#fcfbf7]",

  // components/ui/dashboard/OpRail.tsx — gradient from navy-active to violeta.
  // Grandfathered; these values have no direct ln-* token yet.
  "from-[#3a6cb3]",
  "to-[#6a4c93]",
]);

// Status components that render the canonical open/escalated/closed/merged grammar.
// They must source status tones from the semantic st-* layer so the color
// auto-remaps per skin (operator → ln-op-*, citizen → ln-*). CaseBadge is included
// because it was the F2 holdout: it shipped raw citizen ln-ok (green "Abierto")
// before the st-* migration. OpStatusPill is the shared primitive.
export const STATUS_COMPONENTS = new Set(
  [
    "components/CaseBadge.tsx",
    "components/ui/dashboard/OpPill.tsx",
    "components/ui/dashboard/OpStateBadge.tsx",
    "components/ui/dashboard/OpStatusPill.tsx",
    "components/ui/dashboard/CaseStatusBadge.tsx",
    "components/ui/dashboard/OpKpi.tsx",
  ].map((p) => p.replaceAll("/", sep)),
);

// Matches raw ln-op-ok/warn/danger/viol token utilities that the st-* layer replaces.
// Does NOT match ln-op-ok-bg / ln-op-ok-bd companions (those are covered transitively).
// WARN-level: still valid CSS, just nudges toward st-*.
export const RAW_OP_STATUS = /\b(?:bg|text|border)-ln-op-(?:ok|warn|danger|viol)(?:-bg|-bd)?\b/g;

// Matches raw CITIZEN status tones (ln-ok/warn/err/danger/violeta) — both the class
// utility form (text-ln-ok, ring-ln-warn) and the arbitrary CSS-var form
// (bg-[var(--color-ln-ok-050)]). This is the exact CaseBadge regression: a status
// pill hardcoding a citizen tone instead of st-*, so "Abierto" rendered green on
// operator surfaces. HARD-ERROR inside STATUS_COMPONENTS. Structural ln-* tokens
// (ln-card/ink/line/mute/stripe) and ln-op-* are intentionally NOT matched.
export const RAW_CITIZEN_STATUS =
  /\b(?:bg|text|border|ring)-(?:\[var\(--color-)?ln-(?:ok|warn|err|danger|violeta)(?:-\d+)?/g;

// ---------------------------------------------------------------------------
// Undefined operator-token guard (silent-invisible class)
//
// In Tailwind v4 an undefined utility emits NO CSS — the element renders
// transparent/invisible with no error. `ln-op-verde` / `ln-op-rojo` /
// `ln-op-amarillo` (Spanish color names that were never defined tokens) shipped
// this way across ~11 gob/admin screens: adoption/health bars that rendered
// blank. This guard FAILS on any `<util>-ln-op-<name>` whose <name> is not a
// defined `--color-ln-op-*` token. The allowlist is PARSED from app/globals.css
// (parseDefinedOpTokens) so it stays in sync with the theme automatically.
// ---------------------------------------------------------------------------

// Path to the theme file that declares the --color-ln-op-* tokens. It is a .css
// file, so it is never in the ts/tsx FILES glob — read explicitly for the allowlist.
const OP_TOKENS_CSS_PATH = "app/globals.css";

/**
 * Parse the set of DEFINED operator token names from theme CSS, e.g.
 * `--color-ln-op-ok: …` → "ok", `--color-ln-op-danger-bd: …` → "danger-bd".
 * Exported for unit tests.
 */
export function parseDefinedOpTokens(css: string): Set<string> {
  const out = new Set<string>();
  for (const m of css.matchAll(/--color-ln-op-([a-z0-9]+(?:-[a-z0-9]+)*)\s*:/g)) {
    out.add(m[1]);
  }
  return out;
}

// Matches an operator token utility `<util>-ln-op-<name>`, after any variant
// prefix (hover:, focus:) and before any opacity suffix (/40). Capture group 1
// is <name> (may be compound: ok-bg, danger-bd, azul-700, celeste-050). Checked
// against the parsed allowlist; any <name> not present is a hard error.
export const OP_TOKEN_UTILITY =
  /\b(?:bg|text|border|ring|divide|from|to|via|outline|fill|stroke|placeholder|caret|decoration|accent)-ln-op-([a-z0-9]+(?:-[a-z0-9]+)*)/g;

// ---------------------------------------------------------------------------
// Undefined ln-token REFERENCE guard (same silent-invisible class, other form)
//
// The guard above only sees the UTILITY spelling (`bg-ln-op-verde`). The other
// way to reach a token is `bg-[var(--color-ln-x)]` / `style={{ background:
// "var(--color-ln-x)" }}` — the form this repo blesses everywhere, and the one
// rule 3 (arbitrary hex) actively pushes people toward. Nothing checked that the
// name inside `var()` resolves to anything. Three did not:
//
//   --color-ln-paper-2  4 refs / 3 files — both neutral login notices, the
//                       "sin confirmar" vaccine badge, a session-row hover
//   --color-ln-rule     1 ref — the same badge's border
//   --color-ln-canvas   1 ref — the whole <main> ground of asistencia/presentar
//
// All six rendered with no background/border at all. An undefined custom
// property makes the declaration invalid at computed-value time, which is
// silent: no console warning, no build error, just a missing surface.
//
// ONLY the no-fallback form is flagged. `var(--color-ln-x, #fff)` is not this
// bug — the fallback renders — so it is deliberately out of scope rather than
// unnoticed.
// ---------------------------------------------------------------------------

/**
 * Parse the set of DEFINED `--color-ln-*` token names from theme CSS, e.g.
 * `--color-ln-paper: …` → "ln-paper". Covers the `ln-op-*` operator tokens too,
 * since they share the prefix. Exported for unit tests.
 */
export function parseDefinedLnTokens(css: string): Set<string> {
  const out = new Set<string>();
  for (const m of css.matchAll(/--color-(ln-[a-z0-9]+(?:-[a-z0-9]+)*)\s*:/g)) {
    out.add(m[1]);
  }
  return out;
}

// Capture group 1 is the token name referenced through `var()`, with no
// fallback argument. Matches in .tsx className strings and in .css alike.
export const LN_TOKEN_VAR_REFERENCE = /var\(\s*--color-(ln-[a-z0-9]+(?:-[a-z0-9]+)*)\s*\)/g;

/** A `//` line comment or a `*` JSDoc continuation — prose, not styling. */
function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("*");
}

// ---------------------------------------------------------------------------
// Rules 4–10 (new ratchet rules — fail only on NEW violations above baseline)
// ---------------------------------------------------------------------------

// Rule 4: Arbitrary text sizes — text-[Npx] or text-[N.Npx].
export const ARBITRARY_TEXT_PX = /\btext-\[\d+\.?\d*px\]/g;

// Rule 9: text-[var(--text-*)] — a DEAD font-size (measured 2026-07-29).
//
// This form used to be documented right here as "the correct token form" and
// recommended by rule 4's own error message, so 703 of them accumulated across
// 207 files. Every one of them is a no-op. Tailwind v4 cannot tell whether an
// arbitrary `text-[…]` is a size or a colour, and for a bare CSS variable it
// resolves to COLOUR. Read straight out of the compiled stylesheet:
//
//   .text-\[var\(--text-sm\)\]{color:var(--text-sm)}
//
// So the element gets `color: 12px` — invalid, dropped — and keeps whatever
// font-size it inherited. Nothing failed: not the build, not this fence, not
// 12.5k tests. It only surfaced when a heading was measured in the browser and
// came back 16px instead of 28px.
//
// The working form is Tailwind's NAMED utility (`text-sm`, `text-3xl`), which
// compiles to `font-size:var(--text-sm)` because --text-* IS Tailwind v4's
// font-size namespace. Same token, same single source of truth, and it actually
// applies.
//
// Was ratcheted rather than fixed in one sweep, because unbreaking 703
// declarations meant 703 elements suddenly rendering at their INTENDED size —
// a visible change across the whole app that needed a deliberate pass with
// the PO, not a silent codemod. That pass ran (P4.1 "los 703", plan
// 2026-08-01): the codemod moved 702 declarations to the named utility
// (703→702 is a benign drift, see the plan entry), `deadTextVar` is 0 across
// the baseline, and 85 elements changed COLOUR as a documented correction of
// the alphabetical-cascade bug, not a regression (commits b39d9d2f,
// 435fa426; captures in dim-interno:docs/reviews/results/2026-08-01-703-pass/). Kept as a
// ratchet rule (like rule 10 below) so a new dead declaration is a build
// failure, not new inherited debt.
export const DEAD_TEXT_VAR = /\btext-\[var\(--text-[a-z0-9-]+\)\]/g;

// Rule 10: font-[var(--font-*)] — a DEAD font-family (measured 2026-07-31).
//
// The exact twin of rule 9, and it went unguarded for the same reason rule 9
// went unnoticed: DEAD_TEXT_VAR above is anchored on the `text-` prefix, so
// this population had no fence at all and grew to 520 uses across 143 files.
//
// `font-` is as ambiguous to Tailwind v4 as `text-` is — it is the prefix for
// font-family, font-weight AND font-style — and for a bare CSS variable
// Tailwind resolves it to font-WEIGHT. Read straight out of the compiled
// stylesheet:
//
//   .font-\[var\(--font-ln-mono\)\]{--tw-font-weight:var(--font-ln-mono);
//                                   font-weight:var(--font-ln-mono)}
//
// `--font-ln-mono` is a font STACK, not a <font-weight>, so the declaration is
// invalid, the browser drops it, and the element keeps the font-family it
// INHERITED — the body's "Encode Sans", never the intended IBM Plex face. 349
// of the 520 were asking for the monospace face and none of them got it.
//
// The working form is the NAMED family utility (`font-ln-mono`,
// `font-ln-serif`, `font-ln-sans`), which compiles to a real `font-family`
// because --font-* IS Tailwind v4's font-family namespace. Same token, same
// single source of truth, and it actually applies.
//
// Driven to 0 across the whole baseline by the SC-7 pass
// (scripts/codemod-dead-font-var.mjs). Unlike rule 9 this rule was born at
// zero, so any hit is a NEW regression, not inherited debt.
//
// Deliberately NOT limited to the three ln-* families: a fourth token added
// later must not be able to reintroduce the same dead form.
export const DEAD_FONT_VAR = /\bfont-\[var\(--font-[a-z0-9-]+\)\]/g;

// Rule 5: Arbitrary spacing — p/m/gap/space etc. with [Npx] or [Nrem].
// Also matches Tailwind's compound shorthand (2-4 underscore-separated values,
// e.g. p-[14px_16px]) — a single-value-only regex missed this entirely
// (verified: p-[14px_16px] in OpCard.tsx/OpKpi.tsx produced zero matches
// before this extension).
// Note: p-[var(--space-*)] etc. are intentionally NOT matched (correct token form).
export const ARBITRARY_SPACING_PX =
  /\b(?:p|m|gap|space|px|py|pt|pb|pl|pr|mx|my|mt|mb|ml|mr|gap-x|gap-y)-\[\d+\.?\d*(?:px|rem)(?:_\d+\.?\d*(?:px|rem)){0,3}\]/g;

// Rule 6: Arbitrary radius — rounded-[Npx].
// Note: rounded-[var(--radius-*)] is intentionally NOT matched (correct token form).
export const ARBITRARY_RADIUS_PX = /\brounded-\[\d+\.?\d*px\]/g;

// Rule 7: Arbitrary shadow — shadow-[...] (any arbitrary shadow value).
// Exempts shadow-[var(--shadow-*)] which IS the correct token form.
// Only flags raw value literals like shadow-[0_1px_2px_rgba(0,0,0,0.1)].
export const ARBITRARY_SHADOW = /\bshadow-\[(?!var\(--)[^\]]+\]/g;

// Rule 8: Hex literals in style= / inline CSS props
// Catches: style={{ color: '#abc' }}, fill="#123456", backgroundColor="#fff"
export const HEX_IN_STYLE =
  /(?:style|fill|color|stroke|background|backgroundColor)=\{[^}]*#[0-9a-fA-F]{3,8}/g;

// ---------------------------------------------------------------------------
// Baseline loader — reads scripts/design-tokens-baseline.json
//
// Format: { files: { "relative/path.tsx": { text, space, rounded, shadow, hexStyle } } }
// Any file absent from the baseline has an implicit baseline of 0 for all counts.
// A file present in the baseline is grandfathered up to that count per category.
// New violations (count > baseline OR new file not in baseline) FAIL.
// ---------------------------------------------------------------------------

type BaselineCounts = {
  text: number;
  deadTextVar: number;
  deadFontVar: number;
  space: number;
  rounded: number;
  shadow: number;
  hexStyle: number;
};

type BaselineFile = {
  _meta: { totalViolations: number };
  files: Record<string, BaselineCounts>;
};

function loadBaseline(): BaselineFile["files"] {
  try {
    const req = createRequire(import.meta.url);
    const data = req("./design-tokens-baseline.json") as BaselineFile;
    return data.files;
  } catch {
    console.warn(
      "[warn] scripts/design-tokens-baseline.json not found — all ratchet rules will be strict (no grandfather). Run: node scripts/generate-design-tokens-baseline.mjs to regenerate.",
    );
    return {};
  }
}

// ---------------------------------------------------------------------------
// CSS ratchet (rules C1–C8) — scripts/design-tokens-css-baseline.json
//
// A SEPARATE file from design-tokens-baseline.json on purpose. The JSX baseline
// is rewritten wholesale by scripts/generate-design-tokens-baseline.mjs, which
// knows nothing about CSS; sharing one file would let a routine JSX regenerate
// silently delete the CSS baseline and un-ratchet all of rules C1–C8.
//
// Keys are `<path>#<bucket>` — the landing (`app/landing.css#lp`) and the core
// sheet (`app/globals.css#core`) are counted independently. The bucket is
// computed per selector, not per path, so the lp key followed the layer when it
// moved out of globals.css (2026-08-19). See the CssBucket docstring in
// css-token-scan.ts for why the landing gets its own bucket.
// ---------------------------------------------------------------------------

type CssBaselineFile = {
  _meta: { generatedAt: string; totalViolations: number; description: string };
  buckets: Record<string, CssCounts>;
};

function loadCssBaseline(): Record<string, CssCounts> {
  try {
    const data = JSON.parse(readFileSync(CSS_BASELINE_PATH, "utf8")) as CssBaselineFile;
    return data.buckets ?? {};
  } catch {
    console.warn(
      `[warn] ${CSS_BASELINE_PATH} not found — all CSS ratchet rules will be strict (no grandfather). Regenerate with: pnpm tsx scripts/check-design-tokens.ts --write-css-baseline`,
    );
    return {};
  }
}

/** Scan every stylesheet and tally per `<file>#<bucket>` key. */
function scanAllCss(): Record<string, CssCounts> {
  const fontWeightSets = loadFontWeightSets();
  const all = CSS_FILES.flatMap((f) =>
    scanCss(readFileSync(f, "utf8"), {
      file: f.replaceAll("\\", "/"),
      fontWeightSets,
    }),
  );
  return tallyCss(all);
}

function writeCssBaseline(): void {
  const buckets = scanAllCss();
  const total = Object.values(buckets).reduce(
    (sum, c) => sum + CSS_CATEGORIES.reduce((s, k) => s + c[k], 0),
    0,
  );
  const output: CssBaselineFile = {
    _meta: {
      generatedAt: new Date().toISOString().slice(0, 10),
      totalViolations: total,
      description:
        "Ratchet baseline for the CSS half of the design-token fence (rules C1–C8 in " +
        "scripts/css-token-scan.ts). Keys are `<path>#<bucket>`; `.lp` (the landing) is " +
        "counted separately from the rest of the sheet. These counts are GRANDFATHERED " +
        "debt, not a target — lower them as declarations migrate to tokens, never raise " +
        "them. Regenerate: pnpm tsx scripts/check-design-tokens.ts --write-css-baseline",
    },
    buckets: Object.fromEntries(
      Object.keys(buckets)
        .sort()
        .map((k) => [k, buckets[k]]),
    ),
  };
  writeFileSync(CSS_BASELINE_PATH, `${JSON.stringify(output, null, 2)}\n`);
  console.log(
    `CSS baseline written: ${total} grandfathered violation(s) across ${Object.keys(buckets).length} bucket(s).`,
  );
}

/** Returns the number of ratchet failures (0 = clean). */
function checkCssRatchet(): number {
  const baseline = loadCssBaseline();
  const actual = scanAllCss();
  let failures = 0;
  let grandfathered = 0;

  // Union of both key sets: a bucket that has been fully migrated disappears
  // from `actual`, and a brand-new stylesheet is absent from `baseline` (which
  // makes it strict at 0 — exactly what a new file should be).
  for (const key of new Set([...Object.keys(actual), ...Object.keys(baseline)])) {
    const seen = { ...ZERO_CSS_COUNTS, ...(actual[key] ?? {}) };
    // Spread ZERO_CSS_COUNTS FIRST so a category the baseline file predates is
    // strict rather than `undefined` — `seen > undefined` is always false, which
    // would silently switch the rule off for that bucket. Same trap the JSX
    // ratchet documents at ZERO_COUNTS.
    const allowed = { ...ZERO_CSS_COUNTS, ...(baseline[key] ?? {}) };
    for (const category of CSS_CATEGORIES) {
      grandfathered += Math.min(seen[category], allowed[category]);
      if (seen[category] > allowed[category]) {
        const [label, hint] = CSS_CATEGORY_HINTS[category];
        console.error(
          `${key}: css ratchet — ${seen[category]} ${label} violation(s) (baseline allows ${allowed[category]}). ${hint}. To grandfather, run: pnpm tsx scripts/check-design-tokens.ts --write-css-baseline`,
        );
        failures += 1;
      }
    }
  }

  cssRatchetSummary = `  CSS ratchet: ${grandfathered} grandfathered raw values across ${Object.keys(baseline).length} bucket(s) in ${CSS_FILES.length} stylesheet(s) (rules C1–C8). New violations will fail.`;
  return failures;
}

/** Filled in by checkCssRatchet, printed with the other summary lines. */
let cssRatchetSummary = "";

/**
 * Print every current CSS violation with file:line:col. Not part of the ratchet
 * — this is the "show me the debt" view, since a ratchet that only reports
 * counts makes the individual declarations unfindable.
 */
function reportCssViolations(): void {
  const fontWeightSets = loadFontWeightSets();
  for (const f of CSS_FILES) {
    const rel = f.replaceAll("\\", "/");
    for (const v of scanCss(readFileSync(f, "utf8"), { file: rel, fontWeightSets })) {
      console.log(
        `${rel}:${v.line}:${v.col}: [${v.bucket}/${v.category}] ${v.selector} { ${v.prop}: ${v.value} }`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Ratchet counter — counts per-file hits for rules 4–10, compares to baseline
// ---------------------------------------------------------------------------

// Every ratchet category at zero. Spread FIRST under a baseline entry so a
// category the baseline file predates (e.g. deadFontVar before SC-7) is strict
// rather than `undefined`, which would make every `seen > allowed` comparison
// false and silently switch the rule off for that file.
const ZERO_COUNTS: BaselineCounts = {
  text: 0,
  deadTextVar: 0,
  deadFontVar: 0,
  space: 0,
  rounded: 0,
  shadow: 0,
  hexStyle: 0,
};

function countMatches(src: string, re: RegExp): number {
  return [...src.matchAll(re)].length;
}

function runChecks(): void {
  const baseline = loadBaseline();

  // Parse the defined --color-ln-op-* allowlist from theme CSS. If the file is
  // unreadable, disable the undefined-token guard rather than flag every token.
  let definedOpTokens = new Set<string>();
  try {
    definedOpTokens = parseDefinedOpTokens(readFileSync(OP_TOKENS_CSS_PATH, "utf8"));
  } catch {
    console.warn(
      `[warn] ${OP_TOKENS_CSS_PATH} not readable — undefined ln-op-* token guard skipped.`,
    );
  }
  const opGuardActive = definedOpTokens.size > 0;

  // Same theme file, same fail-soft posture: if it cannot be read, disable the
  // reference guard rather than flag every `var(--color-ln-*)` in the repo.
  let definedLnTokens = new Set<string>();
  try {
    definedLnTokens = parseDefinedLnTokens(readFileSync(OP_TOKENS_CSS_PATH, "utf8"));
  } catch {
    console.warn(
      `[warn] ${OP_TOKENS_CSS_PATH} not readable — undefined ln-* var() reference guard skipped.`,
    );
  }
  const lnRefGuardActive = definedLnTokens.size > 0;

  // Non-vacuity: a regex regression would check nothing and report clean. The
  // summary prints this, and the floor below turns "checked nothing" into a
  // failure rather than a green light.
  let lnRefsScanned = 0;
  const MIN_LN_REFS_SCANNED = 200;

  /** Reports every `var(--color-ln-*)` in `src` that resolves to nothing. */
  const checkLnReferences = (file: string, src: string): number => {
    if (!lnRefGuardActive) return 0;
    let found = 0;
    src.split(/\r?\n/).forEach((line, i) => {
      if (isCommentLine(line)) return;
      for (const match of line.matchAll(LN_TOKEN_VAR_REFERENCE)) {
        lnRefsScanned += 1;
        if (definedLnTokens.has(match[1])) continue;
        console.error(
          `${file}:${i + 1}:${(match.index ?? 0) + 1}: undefined token reference "${match[0]}" — --color-${match[1]} is declared nowhere in ${OP_TOKENS_CSS_PATH}. An undefined custom property makes the declaration invalid at computed-value time, so the surface renders with nothing at all — silently. Declare the token or use one that exists.`,
        );
        found += 1;
      }
    });
    return found;
  };

  let hits = 0;

  // Ratchet per-file totals for rules 4–10
  const ratchetResults: Array<{
    file: string;
    category: keyof BaselineCounts;
    actual: number;
    allowed: number;
  }> = [];

  for (const file of FILES) {
    const relPath = file.replaceAll("\\", "/");
    // COMMENTS ARE STRIPPED FIRST, and this fence was one of the last holdouts.
    // Without it, a comment that accurately names a forbidden value IS a
    // violation: on 2026-09-11 a card whose comment explained why its button had
    // been migrated away from an off-scale spacing literal tripped this rule on
    // the explanation, after the value itself was already gone. That is the
    // fail-CLOSED direction scripts/lib/strip-comments.mjs documents in its own
    // header, and the cure it was written for. It substitutes whitespace 1:1 and
    // keeps newlines, so the line numbers reported below still point at the
    // original file, and it deliberately KEEPS string contents so a real class
    // string in a literal stays visible.
    const src = stripComments(readFileSync(file, "utf8"));
    const lines = src.split(/\r?\n/);
    // A file absent from the baseline is strict on every category. A file
    // PRESENT in the baseline but missing a category key would otherwise
    // compare `seen > undefined` — always false — and silently disable the
    // rule for that file, so ZERO_COUNTS backfills every key it omits.
    const baselineCounts: BaselineCounts = {
      ...ZERO_COUNTS,
      ...(baseline[relPath] ?? {}),
    };

    // --- Rule 11 (line-level, no ratchet): var() references that resolve ---
    hits += checkLnReferences(file, src);

    // --- Rules 1–3 (line-level, no ratchet) ---
    lines.forEach((line, i) => {
      for (const match of line.matchAll(RAW_PALETTE)) {
        console.error(
          `${file}:${i + 1}:${(match.index ?? 0) + 1}: raw Tailwind palette "${match[0]}" — use a gob-* semantic token`,
        );
        hits += 1;
      }
      for (const match of line.matchAll(DARK_PREFIX)) {
        console.error(
          `${file}:${i + 1}:${(match.index ?? 0) + 1}: "${match[0]}" — dark mode is disabled, remove the prefix`,
        );
        hits += 1;
      }
      for (const match of line.matchAll(ARBITRARY_HEX)) {
        if (ARBITRARY_HEX_ALLOWLIST.has(match[0])) continue;
        console.error(
          `${file}:${i + 1}:${(match.index ?? 0) + 1}: arbitrary hex "${match[0]}" — use a ln-* token utility (e.g. bg-[var(--color-ln-ok-050)]). Autofix: pnpm tsx scripts/codemod-status-tints.cjs`,
        );
        hits += 1;
      }
      if (opGuardActive) {
        for (const match of line.matchAll(OP_TOKEN_UTILITY)) {
          const name = match[1];
          if (!definedOpTokens.has(name)) {
            console.error(
              `${file}:${i + 1}:${(match.index ?? 0) + 1}: undefined operator token "ln-op-${name}" (in "${match[0]}") — not a defined --color-ln-op-* token. Tailwind v4 emits no CSS for it, so the element renders invisible. Use a defined token from ${OP_TOKENS_CSS_PATH}.`,
            );
            hits += 1;
          }
        }
      }
      if (STATUS_COMPONENTS.has(file)) {
        // Skip comment lines (TSX single-line comments // …) for both status rules.
        const isComment = line.trimStart().startsWith("//");
        // Hard-error: raw citizen status tone in a status component (CaseBadge regression).
        if (!isComment) {
          for (const match of line.matchAll(RAW_CITIZEN_STATUS)) {
            console.error(
              `${file}:${i + 1}:${(match.index ?? 0) + 1}: raw citizen status tone "${match[0]}" in a status component — use the st-* layer (e.g. text-[var(--color-st-warn)]) so the tone auto-remaps per skin.`,
            );
            hits += 1;
          }
        }
        // Warn-level: raw ln-op-ok/warn/danger/viol — nudge toward st-*.
        if (!isComment) {
          for (const match of line.matchAll(RAW_OP_STATUS)) {
            console.warn(
              `[warn] ${file}:${i + 1}:${(match.index ?? 0) + 1}: "${match[0]}" in operator status component — prefer st-* token (e.g. text-[var(--color-st-ok)]). See globals.css .op-surface block.`,
            );
          }
        }
      }
    });

    // --- Rules 4–10 (file-level ratchet) ---
    const actual = {
      text: countMatches(src, ARBITRARY_TEXT_PX),
      deadTextVar: countMatches(src, DEAD_TEXT_VAR),
      deadFontVar: countMatches(src, DEAD_FONT_VAR),
      space: countMatches(src, ARBITRARY_SPACING_PX),
      rounded: countMatches(src, ARBITRARY_RADIUS_PX),
      shadow: countMatches(src, ARBITRARY_SHADOW),
      hexStyle: countMatches(src, HEX_IN_STYLE),
    };

    const categories: Array<[keyof BaselineCounts, string, string]> = [
      [
        "text",
        "text-[Npx]",
        "use Tailwind's NAMED size utility, which reads the --text-* scale (text-sm, text-3xl, …). NOT text-[var(--text-sm)] — that compiles to `color` and does nothing.",
      ],
      [
        "deadTextVar",
        "text-[var(--text-*)]",
        "DEAD font-size: Tailwind v4 compiles this to `color:var(--text-*)`, so the element keeps its inherited size. Use the named utility instead (text-sm, text-3xl, …).",
      ],
      [
        "deadFontVar",
        "font-[var(--font-*)]",
        "DEAD font-family: Tailwind v4 compiles this to `font-weight:var(--font-*)`, which is not a valid <font-weight>, so the element keeps its inherited family. Use the named utility instead (font-ln-mono, font-ln-serif, font-ln-sans). Autofix: node scripts/codemod-dead-font-var.mjs",
      ],
      [
        "space",
        "spacing-[Npx|rem]",
        "use Tailwind spacing scale or --space-* tokens (e.g. p-3 instead of p-[12px])",
      ],
      ["rounded", "rounded-[Npx]", "use a --radius-* token (e.g. rounded-[var(--radius-sm)])"],
      ["shadow", "shadow-[...]", "use a --shadow-* token (e.g. shadow-[var(--shadow-md)])"],
      ["hexStyle", "hex in style=", "use a CSS var (e.g. var(--color-ln-ok)) in style props"],
    ];

    for (const [key, label, hint] of categories) {
      const allowed = baselineCounts[key];
      const seen = actual[key];
      if (seen > allowed) {
        ratchetResults.push({ file: relPath, category: key, actual: seen, allowed });
        console.error(
          `${file}: ratchet — ${seen} ${label} violation(s) (baseline allows ${allowed}). ${hint}. To grandfather, run: node scripts/generate-design-tokens-baseline.mjs`,
        );
        hits += 1;
      }
    }
  }

  // --- Rule 11 over stylesheets too ---
  // The bug class is a property of the REFERENCE, not of the file type, and a
  // print sheet naming a token that no longer exists fails exactly as quietly.
  // globals.css is scanned alongside the rest: it declares the tokens, so its
  // own references resolve, and a token deleted out from under a reference in
  // the same file is precisely what this should catch.
  for (const cssFile of CSS_FILES) {
    hits += checkLnReferences(cssFile, readFileSync(cssFile, "utf8"));
  }

  // --- Rules C1–C8 (CSS ratchet) ---
  hits += checkCssRatchet();

  if (lnRefGuardActive && lnRefsScanned < MIN_LN_REFS_SCANNED) {
    console.error(
      `\n✗ the ln-* var() reference guard scanned only ${lnRefsScanned} reference(s), below the floor of ${MIN_LN_REFS_SCANNED}. Either the regex broke or the file globs did; a guard that measures nothing must not report clean.`,
    );
    hits += 1;
  }

  if (hits > 0) {
    console.error(
      `\n✗ ${hits} design-token violation(s). Autofix: pnpm tsx scripts/codemod-poncho-tokens.ts && pnpm tsx scripts/codemod-purge-dark.ts && node scripts/codemod-status-tints.cjs`,
    );
    process.exit(1);
  }

  const totalBaselined = Object.values(baseline).reduce(
    (sum, c) => sum + c.text + c.space + c.rounded + c.shadow + c.hexStyle,
    0,
  );
  console.log(
    `✓ Design tokens clean — 0 raw palette, 0 dark: prefix, 0 arbitrary hex across ${FILES.length} files.`,
  );
  console.log(
    `  References: ${lnRefsScanned} var(--color-ln-*) reference(s) checked against ${definedLnTokens.size} declared token(s); all resolve.`,
  );
  console.log(
    `  Ratchet: ${totalBaselined} grandfathered arbitrary values across ${Object.keys(baseline).length} files (rules 4–10). New violations will fail.`,
  );
  if (cssRatchetSummary) console.log(cssRatchetSummary);
}

// Only scan the repo when invoked as a CLI (pnpm lint:tokens / tsx). Importing
// this module from unit tests must not trigger the scan or process.exit.
const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-design-tokens.ts") ||
    process.argv[1].endsWith("check-design-tokens.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  if (process.argv.includes("--write-css-baseline")) {
    // The CSS baseline is generated by the CHECKER itself rather than by a
    // sibling script. The JSX half keeps its regexes duplicated in
    // generate-design-tokens-baseline.mjs and the comments there warn twice
    // that "both must be updated together" — a sync hazard the CSS half simply
    // does not have, because generator and checker call the same scanCss().
    writeCssBaseline();
  } else if (process.argv.includes("--list-css")) {
    reportCssViolations();
  } else {
    runChecks();
  }
}

// CSS half of the Poncho design-token fence.
//
// WHY THIS FILE EXISTS
// --------------------
// scripts/check-design-tokens.ts globs `{app,components}/**/*.{ts,tsx}`. Every
// .css file in the repo was therefore outside every fence — 4184 lines of
// app/globals.css plus three print stylesheets — and the old glob comment said
// so out loud ("app/globals.css is .css, so it is never globbed in") as though
// that were a property of the file rather than a hole in the guard.
//
// The hole was not theoretical. Three measured defects came in through it
// (RA-10, 2026-07-31):
//
//   1. The button-radius canon commit e23ebca1 named the landing's 8px in its
//      own message and shipped without fixing it, because
//      `.lp .lp-btn { border-radius: … }` is CSS and check-raw-buttons.mjs
//      only reads `rounded-*` utilities in JSX.
//   2. The public credential's micro-typography sits BELOW the scale's own
//      floor (--text-xs: 10px): .ln-qr-cap at 8px is the text a funcionario
//      types when the QR will not scan.
//   3. `.ln-band-title` asks for `font-weight: 500` on IBM Plex Mono, which
//      loads only 400/600 — a declaration the browser silently drops.
//
// The file that DEFINES the typographic scale ignored it in 96% of its own
// font-size declarations. This module closes that.
//
// DESIGN
// ------
// A brace/paren-aware CSS walker, not a regex sweep. It has to be a walker
// because one rule is block-scoped (a font-weight is only dead relative to the
// font-family declared beside it) and because bucketing needs the enclosing
// selector, which a line-oriented regex cannot see.
//
// Comments are stripped FIRST, replaced space-for-space so line and column
// numbers survive. This is not optional: the token fence has been fooled twice
// in this wave by tokens quoted inside comments, and app/globals.css is heavily
// prose-annotated — e.g. line 570 ("iOS Safari zooms into any input whose
// computed font-size is below 16px") is a comment that a naive `rg font-size`
// counts as a declaration. That single comment is why RA-10 reported 130 raw
// font-sizes where the executable count is 129.

import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CssCategory =
  | "fontSize"
  | "fontHalfPx"
  | "fontBelowFloor"
  | "radius"
  | "shadow"
  | "hex"
  | "deadWeight"
  | "duration";

/**
 * Baseline buckets. `.lp` (the landing's ~335 rules) gets its own bucket rather
 * than sharing one with the app: it carries 90 of the 136 raw font-sizes and 42
 * of the 53 raw radii, so a single shared counter would let the landing add
 * drift whenever the credential removed some and the ratchet would report "no
 * change". Two buckets = two independent ratchets.
 *
 * This is a BASELINE split, not an exemption. The .lp header comment
 * (app/globals.css:636) states the layer is "remapped onto the repo's ln-*
 * tokens (repo tokens win over the handoff hex values)" — it is scoped for
 * cascade isolation, not excused from the token system.
 */
export type CssBucket = "lp" | "core";

export type CssViolation = {
  file: string;
  line: number;
  col: number;
  bucket: CssBucket;
  category: CssCategory;
  prop: string;
  value: string;
  selector: string;
};

export type CssCounts = Record<CssCategory, number>;

export const ZERO_CSS_COUNTS: CssCounts = {
  fontSize: 0,
  fontHalfPx: 0,
  fontBelowFloor: 0,
  radius: 0,
  shadow: 0,
  hex: 0,
  deadWeight: 0,
  duration: 0,
};

export const CSS_CATEGORIES: readonly CssCategory[] = [
  "fontSize",
  "fontHalfPx",
  "fontBelowFloor",
  "radius",
  "shadow",
  "hex",
  "deadWeight",
  "duration",
] as const;

/** Human-readable label + remediation hint per category, for the CLI report. */
export const CSS_CATEGORY_HINTS: Record<CssCategory, [string, string]> = {
  fontSize: [
    "raw font-size",
    "use a --text-* token (e.g. font-size: var(--text-sm)) — the scale is declared in the @theme block of app/globals.css",
  ],
  fontHalfPx: [
    "half-pixel font-size",
    "the scale's own comment (app/globals.css:169) says half-px values 'consolidate to the step above' — do that instead of adding another one",
  ],
  fontBelowFloor: [
    "font-size below the --text-xs floor",
    "nothing may render smaller than the scale's smallest step; raise it to var(--text-xs) or larger",
  ],
  radius: [
    "raw border-radius",
    "use a --radius-* token (--radius-xs/sm/md/lg, or --radius-pill / --radius-op-btn for buttons)",
  ],
  shadow: ["raw box-shadow", "use a --shadow-sm/md/lg token"],
  hex: [
    "raw hex literal",
    "declare the colour as a --color-* custom property and reference it with var()",
  ],
  deadWeight: [
    "font-weight the family never loaded",
    "next/font downloads only the weights listed in app/layout.tsx, so this declaration is silently remapped to another face — pick a loaded weight, or add the weight to the next/font call",
  ],
  duration: [
    "raw transition/animation duration",
    "use a --motion-* token (--motion-fast/base/slow/deliberate/ambient), declared in the @theme block of app/globals.css — the motion audit (dim-interno:docs/reviews/2026-08-04-motion-audit.md §3.3) found 18 distinct durations and 0 tokens, and the scale exists so a 19th cannot be added by accident",
  ],
};

// ---------------------------------------------------------------------------
// Comment stripping
// ---------------------------------------------------------------------------

/**
 * Replace every CSS block comment with the same number of characters (spaces;
 * newlines preserved) so line AND column numbers in the stripped text match the
 * original exactly. Callers must scan the STRIPPED text: anything a comment
 * says about font-size or #hex is prose, not a declaration.
 */
export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

// ---------------------------------------------------------------------------
// Loaded font weights — parsed from app/layout.tsx (next/font/local)
// ---------------------------------------------------------------------------

/**
 * Map a next/font CSS variable name (e.g. "--a-mono-font") to the weight set
 * actually downloaded for it. next/font emits ONLY the listed weights; a
 * `font-weight` the family never loaded is silently remapped by the browser to
 * the nearest available face, so the declaration reads as intent and renders as
 * something else.
 *
 * This is the one member of the JSX rule-9/rule-10 pair with a real CSS
 * translation: those two rules are about a declaration that compiles to
 * nothing and fails silently, and this is the CSS shape of the same class.
 *
 * Exported for unit tests.
 */
export function parseFontWeightSets(layoutSrc: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  // Two call shapes, tried separately so neither's requirements leak into the
  // other:
  //  - `SomeFont({ … })` (next/font/google): body is flat, no nested braces,
  //    may be all on one line — bounded by the first unmatched `})`.
  //  - `localFont({ … })` (next/font/local, used since L-21, 2026-09-18):
  //    body nests one level for `src: [{ path, weight, style }, ...]`, so it
  //    can't be bounded by "no braces" — bounded by its own closing `\n})`
  //    instead. A call whose closing `\n})` isn't found ends the match early
  //    and simply drops that family, which fails OPEN (no false positives).
  const bodies = [
    ...layoutSrc.matchAll(/\b[A-Z]\w*\(\{([^{}]*)\}\)/g),
    ...layoutSrc.matchAll(/\blocalFont\(\{([\s\S]*?)\n\}\)/g),
  ].map((m) => m[1]);

  for (const body of bodies) {
    const varM = /variable:\s*"([^"]+)"/.exec(body);
    if (!varM) continue;
    const weights = new Set<number>();
    const arrayM = /weight:\s*\[([^\]]*)\]/.exec(body);
    if (arrayM) {
      for (const w of arrayM[1].matchAll(/\d+/g)) weights.add(Number(w[0]));
    } else {
      // next/font/local repeats `weight: "NNN"` once per `src` entry; collect
      // all of them (a single next/font/google variable-weight call has just
      // one, so this also covers that shape).
      for (const w of body.matchAll(/weight:\s*"(\d+)"/g)) weights.add(Number(w[1]));
    }
    // A variable-font call with no `weight` key loads the whole axis. Recording
    // nothing means the check skips that family rather than flagging every
    // weight as dead.
    if (weights.size > 0) out.set(varM[1], weights);
  }
  return out;
}

export function loadFontWeightSets(layoutPath = "app/layout.tsx"): Map<string, Set<number>> {
  try {
    return parseFontWeightSets(readFileSync(layoutPath, "utf8"));
  } catch {
    return new Map();
  }
}

/**
 * Follow a font-family value through the sheet's own custom properties down to
 * the terminal variable that next/font owns.
 *
 *   var(--font-ln-mono)
 *     → --font-ln-mono: var(--a-mono-font, "IBM Plex Mono"), "Menlo", monospace
 *     → "--a-mono-font"   (terminal: not defined in CSS, injected by next/font)
 *
 * Returns null when the value names no variable at all (a literal stack) or the
 * alias chain is cyclic. Exported for unit tests.
 */
export function resolveFontVar(value: string, cssVars: Map<string, string>): string | null {
  let cur = value;
  for (let guard = 0; guard < 12; guard += 1) {
    const m = /var\(\s*(--[\w-]+)/.exec(cur);
    if (!m) return null;
    const name = m[1];
    const next = cssVars.get(name);
    if (next === undefined) return name; // terminal — owned by next/font
    cur = next;
  }
  return null; // cyclic alias chain — fail open
}

const WEIGHT_KEYWORDS: Record<string, number> = { normal: 400, bold: 700 };

// ---------------------------------------------------------------------------
// The walker
// ---------------------------------------------------------------------------

type Decl = { prop: string; value: string; line: number; col: number };

/** Fallback typographic floor if --text-xs cannot be parsed from the sheet. */
const DEFAULT_FLOOR_PX = 10;

/** `.lp`, `.lp-btn`, `.lp-nav` — but not `.lpx`. */
const LP_SELECTOR = /\.lp\b/;

const RADIUS_PROP =
  /^border-(?:(?:top|bottom)-(?:left|right)-|(?:start|end)-(?:start|end)-)?radius$/;

const HEX_LITERAL = /#[0-9a-fA-F]{3,8}\b/g;

/**
 * Rule C8 props: the two duration longhands and the two shorthands that carry a
 * duration positionally.
 *
 * `transition-delay` / `animation-delay` are deliberately EXCLUDED. A delay is a
 * cadence, not a step on the motion scale — the landing's stagger is one 80ms
 * beat multiplied by `--d` (app/globals.css `.lp-reveal`), and pointing it at a
 * --motion-* token would be a category error, not a migration.
 */
const DURATION_PROP = /^(?:transition|animation)(?:-duration)?$/;

/**
 * A <time> literal, guarded on both sides so it cannot match inside an
 * identifier. Without the lookbehind an `@keyframes` name ending in a digit
 * (`animation: fade2s …`) would read as a duration; without the lookahead
 * `ease-in-out` and custom-property names would.
 */
const TIME_LITERAL = /(?<![\w.-])(\d+(?:\.\d+)?)(ms|s)(?![\w-])/g;

/**
 * Durations at or below this are exempt from C8. Two populations live here and
 * neither is a scale step:
 *   - `0s` / `0ms`, which is "no transition", and
 *   - the `0.01ms !important` prefers-reduced-motion floor
 *     (app/globals.css) — that declaration is the OFF SWITCH for the whole
 *     motion system. Baselining it would park two permanently-unfixable
 *     violations in the ratchet and weaken the fence for everything else.
 */
const DURATION_EXEMPT_MS = 1;

/**
 * Rule C8: how many RAW duration literals a declaration carries.
 *
 * Counted per LITERAL rather than per declaration: `transition: opacity 150ms,
 * transform 150ms` is two values a future edit can drift apart independently,
 * and counting it once would let a migration that fixes half of a shorthand
 * register as fully clean.
 *
 * Lives outside classifyDecl so the classifier stays readable as the rule list
 * grows — same reason C7 lives in findDeadWeight(). Exported for unit tests.
 */
export function countRawDurations(prop: string, value: string): number {
  if (!DURATION_PROP.test(prop) || IGNORED_VALUES.test(value)) return 0;
  let n = 0;
  for (const m of value.matchAll(TIME_LITERAL)) {
    const ms = m[2] === "s" ? Number(m[1]) * 1000 : Number(m[1]);
    if (ms > DURATION_EXEMPT_MS) n += 1;
  }
  return n;
}
const HALF_PX = /^\d+\.5px$/;
const FLUID_FN = /\b(?:clamp|min|max|calc)\(/;
const IGNORED_VALUES = /^(inherit|initial|unset|revert|revert-layer|none|auto)$/i;

export type ScanOptions = {
  file?: string;
  fontWeightSets?: Map<string, Set<number>>;
  /** Override the below-floor threshold; normally parsed from --text-xs. */
  floorPx?: number;
};

/**
 * Which categories a single declaration violates — rules C1-C6 and C8.
 *
 * Pure and module-level on purpose: the classification is the part that grows
 * as rules are added, and keeping it out of the walker means a new rule never
 * has to touch the parsing loop. Rule C7 is the exception and lives in
 * findDeadWeight() below, because it is block-scoped rather than
 * declaration-scoped.
 *
 * Exported for unit tests.
 */
export function classifyDecl(prop: string, value: string, floorPx: number): CssCategory[] {
  // Token DEFINITIONS are where raw values are SUPPOSED to live. A hex or a px
  // in `--color-ln-op-page: #0a0f1c` is the single source of truth, not drift.
  if (prop.startsWith("--")) return [];

  const out: CssCategory[] = [];
  const ignorable = /var\(\s*--/.test(value) || IGNORED_VALUES.test(value);

  // --- Rules C1 / C2 / C3: font-size ---------------------------------------
  if (prop === "font-size" && !ignorable && !/^\d+(\.\d+)?%$/.test(value)) {
    // rem is converted at the 16px root, because the floor is about legibility
    // and 0.5rem is 8px on screen exactly as 8px is. Collecting only `px` left
    // the whole rem spelling of the defect unmeasured — `clamp(0.5rem, 1vw,
    // 2rem)` bottoms out at 8px and used to pass this rule clean, in direct
    // contradiction of the comment below claiming the floor covers the ramp's
    // minimum. `em` is deliberately NOT converted: it resolves against the
    // parent's computed size, which no static scan can know.
    const pxs = [
      ...[...value.matchAll(/(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1])),
      ...[...value.matchAll(/(\d+(?:\.\d+)?)rem/g)].map((m) => Number(m[1]) * 16),
    ];
    // clamp()/min()/max()/calc() is a DELIBERATE fluid-type choice. The scale
    // is a ladder of fixed px steps with no fluid token, so flagging these
    // would push authors toward a WORSE fixed value. Exempt from the raw-size
    // rule — but the FLOOR still applies to the ramp's minimum, because a fluid
    // ramp bottoming out at 8px is the same legibility problem as a fixed 8px,
    // and leaving the function form wholly unchecked would be an open escape
    // hatch (`clamp(8px, 8px, 8px)`).
    const isFluid = FLUID_FN.test(value);
    if (!isFluid) {
      out.push("fontSize");
      // Half-pixel sizes get their OWN counter, OVERLAPPING fontSize rather
      // than partitioning it. Overlap is deliberate: consolidating 12.5px to
      // 13px must lower a count, never move a violation from one bucket to
      // another and trip the ratchet on a genuine improvement.
      if (HALF_PX.test(value)) out.push("fontHalfPx");
    }
    if (pxs.length > 0 && Math.min(...pxs) < floorPx) out.push("fontBelowFloor");
  }

  // --- Rule C4: border-radius ------------------------------------------------
  // Percentage radii are exempt. `border-radius: 50%` is a SHAPE (circle /
  // ellipse), not a step on the radius scale: no --radius-* token can express
  // it and none ever will, so flagging it would emit "use a --radius-* token"
  // as advice with no valid target. A fence that gives a wrong instruction is a
  // fence people switch off. There are 10 of these, all circular dots and
  // avatars. `999px`/`9999px` stays flagged — that IS the pill, and
  // --radius-pill exists precisely for it.
  if (
    RADIUS_PROP.test(prop) &&
    !ignorable &&
    !/^0(px|%)?$/.test(value) &&
    !/^\d+(?:\.\d+)?%$/.test(value)
  ) {
    out.push("radius");
  }

  // --- Rule C5: box-shadow ---------------------------------------------------
  if (prop === "box-shadow" && !ignorable) out.push("shadow");

  // --- Rule C6: raw hex in a non-custom-property declaration -----------------
  for (const _m of value.matchAll(HEX_LITERAL)) out.push("hex");

  // --- Rule C8: raw transition/animation duration ----------------------------
  for (let i = countRawDurations(prop, value); i > 0; i -= 1) out.push("duration");

  return out;
}

/**
 * Rule C7: a font-weight the declared family never loaded.
 *
 * Block-scoped by necessity — "500" is only wrong relative to the font-family
 * sitting next to it. IBM Plex Mono loads 400/600, so
 * `.ln-band-title { font-family: var(--font-ln-mono); font-weight: 500 }`
 * renders at 400: the browser's font-matching algorithm, for a desired weight
 * in [400,500], searches available weights <= desired descending before looking
 * above. The line naming the credential asks for medium and draws regular,
 * white on navy, at 10px with 0.24em tracking.
 *
 * Fails OPEN in every ambiguous case: unresolvable alias chain, a family the
 * app does not own, a weight keyword outside normal/bold, missing layout.tsx.
 */
/** Is any selector on the enclosing stack part of the landing layer? */
function isLpStack(stack: readonly string[]): boolean {
  return stack.some((s) => LP_SELECTOR.test(s));
}

/** Is the declaration inside the @theme token-declaration block? */
function isThemeStack(stack: readonly string[]): boolean {
  return stack.some((s) => /^@theme\b/.test(s));
}

/** Split a buffered `prop: value` fragment into a Decl, or null if it is not one. */
function parseDecl(buf: string, line: number, col: number): Decl | null {
  const idx = buf.indexOf(":");
  if (idx < 0) return null;
  const prop = buf.slice(0, idx).trim().toLowerCase();
  const value = buf.slice(idx + 1).trim();
  if (prop === "" || value === "") return null;
  // line/col already point at the first non-whitespace character of the buffer.
  return { prop, value, line, col };
}

/**
 * Expand a `font:` SHORTHAND into the synthetic `font-family` + `font-weight`
 * declarations C7 reasons about.
 *
 * Why this exists: C7 used to look only at a literal `font-weight` property, so
 * `.lp-hcard-badge { font: 700 10px / 1 var(--font-ln-mono) }` was invisible to
 * it. Every audit of the dead-weight problem therefore counted FOUR dead CSS
 * declarations when there were five — the shorthand was the one that hid, and
 * it hid from a `font-weight` grep for exactly the same reason.
 *
 * Deliberately conservative, and fails OPEN like the rest of C7:
 *
 *  - the weight is the first standalone 100–900 / bold / normal token, which
 *    the shorthand grammar puts before the mandatory size;
 *  - the family is resolved only when the value contains EXACTLY ONE `var(…)`.
 *    With two or more there is no way to tell a `var()` size or line-height
 *    from a `var()` family without implementing the whole shorthand grammar,
 *    and a fence that guesses which one is the family is worse than a fence
 *    that declines. Every such value is skipped.
 */
function expandFontShorthand(decl: Decl): { family: Decl; weight: Decl } | null {
  const weightMatch = /(?:^|[\s,])(bold|normal|[1-9]00)(?=[\s,])/i.exec(decl.value);
  if (!weightMatch) return null;
  const familyMatches = [...decl.value.matchAll(/var\(\s*--[a-z0-9-]+[^)]*\)/gi)];
  if (familyMatches.length !== 1) return null;
  return {
    family: { ...decl, prop: "font-family", value: familyMatches[0][0] },
    weight: { ...decl, prop: "font-weight", value: weightMatch[1] },
  };
}

function findDeadWeight(
  decls: readonly Decl[],
  cssVars: Map<string, string>,
  fontWeightSets: Map<string, Set<number>>,
): { decl: Decl; terminal: string; loaded: Set<number> } | null {
  if (fontWeightSets.size === 0) return null;
  // Shorthands are expanded in place so a rule that mixes `font:` with a later
  // `font-weight:` still resolves by the normal last-declaration-wins rule.
  const expanded = decls.flatMap((d) => {
    if (d.prop !== "font") return [d];
    const parts = expandFontShorthand(d);
    return parts ? [parts.family, parts.weight] : [d];
  });
  const famDecl = [...expanded].reverse().find((d) => d.prop === "font-family");
  const fwDecl = [...expanded].reverse().find((d) => d.prop === "font-weight");
  if (!famDecl || !fwDecl) return null;
  const raw = fwDecl.value.toLowerCase();
  const weight = WEIGHT_KEYWORDS[raw] ?? (/^\d+$/.test(raw) ? Number(raw) : Number.NaN);
  if (!Number.isFinite(weight)) return null;
  const terminal = resolveFontVar(famDecl.value, cssVars);
  if (!terminal) return null;
  const loaded = fontWeightSets.get(terminal);
  if (!loaded || loaded.size === 0 || loaded.has(weight)) return null;
  return { decl: fwDecl, terminal, loaded };
}

/**
 * Buffered declaration text plus the source position of its first
 * non-whitespace character — `line`/`col` are what a violation reports, and
 * they must point at the property name, not at the leading newline the buffer
 * happens to start with.
 */
type DeclBuffer = { text: string; line: number; col: number; curLine: number; curCol: number };

function bufAppend(b: DeclBuffer, ch: string): void {
  if (b.text.trim() === "" && ch.trim() !== "") {
    b.line = b.curLine;
    b.col = b.curCol;
  }
  b.text += ch;
}

/** Advance the source cursor one character. Called for EVERY character. */
function bufAdvance(b: DeclBuffer, ch: string): void {
  if (ch === "\n") {
    b.curLine += 1;
    b.curCol = 1;
  } else {
    b.curCol += 1;
  }
}

/** Callbacks the walker hands each declaration and each closing block to. */
type CssVisitor = {
  /** `stack` is live — the innermost selector is its last element. */
  onDecl(decl: Decl, stack: readonly string[]): void;
  /** Called as a block closes; `stack` EXCLUDES the block's own `selector`. */
  onBlockClose(decls: readonly Decl[], stack: readonly string[], selector: string): void;
};

/**
 * Brace/paren-aware walk over ALREADY-COMMENT-STRIPPED CSS.
 *
 * Paren depth matters: a value like `url("data:image/svg+xml;utf8,…")` or
 * `@media (max-width: 767px)` contains `;` and `:` that must not be read as
 * declaration punctuation.
 */
function walkCss(src: string, visitor: CssVisitor): void {
  const selectorStack: string[] = [];
  const blockDecls: Decl[][] = [];
  const buf: DeclBuffer = { text: "", line: 1, col: 1, curLine: 1, curCol: 1 };
  let parens = 0;

  const emitDecl = () => {
    const d = parseDecl(buf.text, buf.line, buf.col);
    if (!d) return;
    if (blockDecls.length > 0) blockDecls[blockDecls.length - 1].push(d);
    visitor.onDecl(d, selectorStack);
  };

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "(") parens += 1;
    else if (ch === ")") parens = Math.max(0, parens - 1);

    const atTop = parens === 0;
    if (atTop && ch === "{") {
      selectorStack.push(buf.text.trim().replace(/\s+/g, " "));
      blockDecls.push([]);
      buf.text = "";
    } else if (atTop && ch === "}") {
      emitDecl(); // a final declaration with no trailing semicolon
      const decls = blockDecls.pop() ?? [];
      const selector = selectorStack.pop() ?? "";
      visitor.onBlockClose(decls, selectorStack, selector);
      buf.text = "";
    } else if (atTop && ch === ";") {
      // At depth 0 this is an at-rule STATEMENT (@import, @variant), not a
      // declaration.
      if (selectorStack.length > 0) emitDecl();
      buf.text = "";
    } else {
      bufAppend(buf, ch);
    }

    bufAdvance(buf, ch);
  }
}

/**
 * Scan one stylesheet. `css` is the RAW source — comments are stripped here so
 * callers cannot forget to.
 */
export function scanCss(css: string, opts: ScanOptions = {}): CssViolation[] {
  const file = opts.file ?? "<css>";
  const fontWeightSets = opts.fontWeightSets ?? new Map<string, Set<number>>();
  const src = stripCssComments(css);

  const floorM = /--text-xs\s*:\s*(\d+(?:\.\d+)?)px/.exec(src);
  const floorPx = opts.floorPx ?? (floorM ? Number(floorM[1]) : DEFAULT_FLOOR_PX);

  const out: CssViolation[] = [];
  const cssVars = new Map<string, string>();

  walkCss(src, {
    onDecl(d, stack) {
      // Record every custom property so font-family aliases can be resolved and
      // so --text-xs is known wherever it is declared. classifyDecl then exempts
      // custom properties from every value rule: token DEFINITIONS are where raw
      // values are SUPPOSED to live.
      if (d.prop.startsWith("--")) {
        cssVars.set(d.prop, d.value);
        return;
      }
      // @theme is the token declaration block — nothing inside it is drift.
      if (isThemeStack(stack)) return;
      const bucket: CssBucket = isLpStack(stack) ? "lp" : "core";
      const selector = stack[stack.length - 1] ?? "";
      for (const category of classifyDecl(d.prop, d.value, floorPx)) {
        out.push({
          file,
          line: d.line,
          col: d.col,
          bucket,
          category,
          prop: d.prop,
          value: d.value,
          selector,
        });
      }
    },

    onBlockClose(decls, stack, selector) {
      const dead = findDeadWeight(decls, cssVars, fontWeightSets);
      if (!dead) return;
      out.push({
        file,
        line: dead.decl.line,
        col: dead.decl.col,
        // The bucket must be computed with this block's OWN selector included.
        // The landing's rules are `.lp .lp-ch-num` — a single stack entry — so
        // checking only the ancestors that survive the pop would file every one
        // of them under "core".
        bucket: isLpStack([...stack, selector]) ? "lp" : "core",
        category: "deadWeight",
        prop: "font-weight",
        value: `${dead.decl.value} on ${dead.terminal} (loaded: ${[...dead.loaded].sort((a, b) => a - b).join("/")})`,
        selector,
      });
    },
  });

  return out;
}

// ---------------------------------------------------------------------------
// Tally
// ---------------------------------------------------------------------------

/** Group violations into `<file>#<bucket>` baseline keys. */
export function tallyCss(violations: readonly CssViolation[]): Record<string, CssCounts> {
  const out: Record<string, CssCounts> = {};
  for (const v of violations) {
    const key = `${v.file}#${v.bucket}`;
    out[key] ??= { ...ZERO_CSS_COUNTS };
    out[key][v.category] += 1;
  }
  return out;
}

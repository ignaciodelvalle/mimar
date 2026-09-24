// Fence — `@dim/contract/tokens` must agree with `app/globals.css`, exactly.
// READ-ONLY.
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// The web app's visual identity is declared in CSS custom properties inside the
// `@theme` block of app/globals.css. Metro does not run Tailwind and React
// Native cannot resolve `var(--color-ln-azul)`, so the mobile client needs the
// resolved values as data. `packages/contract/src/tokens/ln-tokens.ts` is that
// data.
//
// A second copy of a value is a divergence with a start date. This one already
// happened: apps/mobile/src/ui/theme.ts opened with a header saying it
// "MIRRORS the web app's Tailwind greys" — and mirrored a different palette
// entirely (neutral #111827 / #e5e7eb / #f7f7f5 against the web's warm #1b2a33
// / #e4dfd3 / #fbfaf5). Nobody noticed for the life of the app, because there
// was nothing that could notice. The PO noticed, by putting the emulator next
// to the browser.
//
// FENCE, NOT CODEMOD, AND WHY THAT IS THE RIGHT TRADE TODAY
// ---------------------------------------------------------------------------
// The full B46 end state is generation: the CSS emitted FROM the TypeScript, so
// the two cannot be written independently at all. That is a build change, and
// `@theme` carries ~170 tokens most of which have paragraphs of rationale
// attached — prose a generator would have to carry or destroy. This repo's
// established cheaper instrument is a fence, and a fence buys the property that
// actually matters: the two cannot silently disagree. The codemod stays the end
// state; see the header of ln-tokens.ts.
//
// WHAT "DRIFT IN EITHER DIRECTION" MEANS HERE
// ---------------------------------------------------------------------------
// Both directions of VALUE drift are caught, because the comparison is
// symmetric string equality on a shared key:
//
//   · someone edits the hex in ln-tokens.ts   → TS ≠ CSS → red
//   · someone edits the hex in globals.css    → CSS ≠ TS → red
//   · someone RENAMES or DELETES the property in globals.css
//                                             → the key is missing → red
//
// The one asymmetry is deliberate and is NOT a hole: a CSS token the contract
// does not export is fine. The contract exports the subset a native client
// renders, not all ~170; requiring parity on the whole block would make every
// new operator-tier token a mobile change for no reason.
//
// THE NON-VACUITY FLOOR
// ---------------------------------------------------------------------------
// A fence whose parse silently returns nothing is worse than no fence: it is a
// green light with no measurement behind it. Two floors guard that. The CSS
// parse must find at least MIN_THEME_DECLARATIONS declarations in the @theme
// block (it currently finds 168; a broken brace match or a Tailwind syntax
// change would collapse it toward zero), and the comparison must actually
// compare at least MIN_TOKENS_CHECKED tokens — the count exported at the time
// this fence was written. Removing an export is legal, but it costs an
// intentional edit here, which is the whole point of a ratchet.
//
// Run:  pnpm tsx scripts/check-design-token-parity.ts   (or: pnpm lint:token-parity)
// Exits 0 when every exported token matches the CSS.
// Exits 1 listing each mismatch.

import { readFileSync } from "node:fs";
import { LN_CSS_FONT_TOKENS, LN_CSS_TOKENS } from "@dim/contract/tokens";

export const GLOBALS_CSS = "app/globals.css";

/**
 * Floors. See "THE NON-VACUITY FLOOR" above.
 *
 * MIN_TOKENS_CHECKED is 60 — the 57 exact-match tokens plus the 3 font
 * families exported on 2026-08-25. Raising an export raises nothing here;
 * DROPPING one below this number is what has to be deliberate.
 * (59 -> 60 when --color-ln-paper-2 was declared: it was referenced by four
 * call sites while declared nowhere, so the fence had never covered it.)
 */
export const MIN_THEME_DECLARATIONS = 120;
export const MIN_TOKENS_CHECKED = 60;

/**
 * The declarations inside the `@theme` block, as `name → value`.
 *
 * Comments are stripped BEFORE the brace match, and that ordering is
 * load-bearing rather than tidy: globals.css documents its tokens heavily, a
 * comment inside the block is free to contain a brace, and a brace matcher that
 * ran first would close the block early and silently return a prefix of the
 * tokens. A prefix parses fine and passes for everything it happens to include.
 */
export function parseThemeBlock(css: string): Map<string, string> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");

  const start = withoutComments.indexOf("@theme");
  if (start === -1) return new Map();

  const open = withoutComments.indexOf("{", start);
  if (open === -1) return new Map();

  let depth = 0;
  let close = -1;
  for (let i = open; i < withoutComments.length; i += 1) {
    const ch = withoutComments[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return new Map();

  const body = withoutComments.slice(open + 1, close);
  const declarations = new Map<string, string>();
  // `[^;]+` so a declaration wrapped across lines (the font stacks are) is read
  // whole; whitespace is then collapsed so the comparison does not depend on
  // where Prettier decided to break the line.
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    const name = match[1];
    const value = match[2];
    if (name === undefined || value === undefined) continue;
    declarations.set(name, value.replace(/\s+/g, " ").trim());
  }
  return declarations;
}

export type Mismatch = {
  token: string;
  expected: string;
  actual: string | undefined;
  rule: "equals" | "contains";
};

/** Exact string equality — the palette, the radii, the scales. */
export function compareExact(declarations: Map<string, string>): Mismatch[] {
  const mismatches: Mismatch[] = [];
  for (const [token, expected] of Object.entries(LN_CSS_TOKENS)) {
    const actual = declarations.get(token);
    if (actual !== expected) mismatches.push({ token, expected, actual, rule: "equals" });
  }
  return mismatches;
}

/**
 * Containment — the font families.
 *
 * The CSS declares stacks with a next/font variable in front:
 *   --font-ln-serif: var(--a-serif-font, "IBM Plex Serif"), Georgia, serif;
 * A native client wants the family out of that and nothing else, so equality
 * would be a fence against a string no consumer of this token ever uses. What
 * must hold is that the CSS still names the family this contract promises.
 */
export function compareFontFamilies(declarations: Map<string, string>): Mismatch[] {
  const mismatches: Mismatch[] = [];
  for (const [token, family] of Object.entries(LN_CSS_FONT_TOKENS)) {
    const actual = declarations.get(token);
    if (actual === undefined || !actual.includes(family)) {
      mismatches.push({ token, expected: family, actual, rule: "contains" });
    }
  }
  return mismatches;
}

export function tokensChecked(): number {
  return Object.keys(LN_CSS_TOKENS).length + Object.keys(LN_CSS_FONT_TOKENS).length;
}

function describe(m: Mismatch): string {
  const verb = m.rule === "equals" ? "must equal" : "must contain";
  const found = m.actual === undefined ? "(the property is not declared at all)" : `"${m.actual}"`;
  return `    ${m.token}\n        contract says ${verb} "${m.expected}"\n        globals.css has ${found}`;
}

function runCheck(): void {
  const css = readFileSync(GLOBALS_CSS, "utf8");
  const declarations = parseThemeBlock(css);

  if (declarations.size < MIN_THEME_DECLARATIONS) {
    console.error(
      [
        "",
        `✗ check-design-token-parity: parsed only ${declarations.size} declaration(s) out of the`,
        `  @theme block in ${GLOBALS_CSS}, below the floor of ${MIN_THEME_DECLARATIONS}.`,
        "",
        "  That is NOT a pass. It means the parse broke — the block moved, the",
        "  syntax changed, or the brace match closed early — and a broken parse",
        "  would wave every token through.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  const checked = tokensChecked();
  if (checked < MIN_TOKENS_CHECKED) {
    console.error(
      [
        "",
        `✗ check-design-token-parity: the contract exports ${checked} fenced token(s),`,
        `  below the floor of ${MIN_TOKENS_CHECKED}.`,
        "",
        "  Dropping a token is allowed; doing it silently is not. Lower",
        "  MIN_TOKENS_CHECKED in this file in the same commit, and say why.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  const mismatches = [...compareExact(declarations), ...compareFontFamilies(declarations)];

  if (mismatches.length > 0) {
    console.error(
      [
        "",
        `✗ Design-token parity FAILED — ${mismatches.length} of ${checked} token(s) disagree between`,
        `  packages/contract/src/tokens/ln-tokens.ts and ${GLOBALS_CSS}:`,
        "",
        ...mismatches.map(describe),
        "",
        "  One of the two was edited without the other. Decide which is right and",
        "  change BOTH — the web reads the CSS, apps/mobile reads the contract, and",
        "  a value that differs between them is the brand splitting in two.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  console.log(
    `✓ Design-token parity — ${checked} token(s) in @dim/contract/tokens match ${GLOBALS_CSS} ` +
      `(${declarations.size} declarations parsed from @theme).`,
  );
}

// Only run when invoked as a CLI; importing from tests must not exit.
const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-design-token-parity.ts") ||
    process.argv[1].endsWith("check-design-token-parity.js"));

if (isMain) {
  try {
    runCheck();
  } catch (err) {
    console.error("✗ check-design-token-parity: unexpected error:", err);
    process.exit(1);
  }
}

/**
 * Unit tests for scripts/check-design-tokens.ts — the citizen-status-tone guard.
 *
 * Pure fixture tests (no filesystem I/O): exercise the exported RAW_CITIZEN_STATUS
 * regex against known-bad and known-good className fragments to verify recall
 * (it catches the CaseBadge regression — a status pill hardcoding a citizen tone)
 * and precision (no false positives on structural ln-* tokens, ln-op-* tokens,
 * or the correct st-* form).
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DEAD_FONT_VAR,
  DEAD_TEXT_VAR,
  LN_TOKEN_VAR_REFERENCE,
  OP_TOKEN_UTILITY,
  RAW_CITIZEN_STATUS,
  STATUS_COMPONENTS,
  parseDefinedLnTokens,
  parseDefinedOpTokens,
} from "@/scripts/check-design-tokens";
import {
  type CssCategory,
  parseFontWeightSets,
  resolveFontVar,
  scanCss,
  stripCssComments,
  tallyCss,
} from "@/scripts/css-token-scan";

describe("RAW_CITIZEN_STATUS — recall (catches the CaseBadge regression)", () => {
  const BAD = [
    "text-ln-ok", // the exact green "Abierto" holdout
    "ring-ln-ok",
    "text-ln-warn",
    "border-ln-err",
    "bg-ln-danger",
    "text-ln-violeta",
    "bg-[var(--color-ln-ok-050)]", // arbitrary CSS-var form
    "bg-[var(--color-ln-warn-050)]",
  ];
  for (const cls of BAD) {
    it(`flags "${cls}"`, () => {
      RAW_CITIZEN_STATUS.lastIndex = 0;
      expect(cls).toMatch(RAW_CITIZEN_STATUS);
    });
  }
});

describe("RAW_CITIZEN_STATUS — precision (no false positives)", () => {
  const GOOD = [
    // Structural citizen tokens — surface/ink/line, not status tones.
    "bg-ln-card",
    "text-ln-ink",
    "ring-ln-line",
    "text-ln-mute",
    "bg-ln-stripe",
    // Operator-skin tones use the ln-op- prefix — covered by RAW_OP_STATUS (warn).
    "text-ln-op-warn",
    "bg-ln-op-ok-bg",
    // The correct, canonical st-* form must never be flagged.
    "text-[var(--color-st-warn)]",
    "bg-[var(--color-st-ok-bg)]",
  ];
  for (const cls of GOOD) {
    it(`does NOT flag "${cls}"`, () => {
      RAW_CITIZEN_STATUS.lastIndex = 0;
      expect(cls).not.toMatch(RAW_CITIZEN_STATUS);
    });
  }
});

// Rule 10 (SC-7). `font-` is the prefix for font-family, font-weight AND
// font-style, so Tailwind v4 cannot type a bare CSS variable and resolves it to
// font-WEIGHT: `.font-\[var\(--font-ln-mono\)\]{font-weight:var(--font-ln-mono)}`.
// A font stack is not a valid <font-weight>, the declaration is dropped, and the
// element silently keeps its INHERITED family. 520 of these across 143 files
// went unguarded because DEAD_TEXT_VAR is anchored on the `text-` prefix.
describe("DEAD_FONT_VAR — recall (catches the dead font-family form)", () => {
  const BAD = [
    "font-[var(--font-ln-mono)]",
    "font-[var(--font-ln-serif)]",
    "font-[var(--font-ln-sans)]",
    // Must not be limited to the three families that exist today — a token
    // added later has to be caught by the same rule.
    "font-[var(--font-ln-display)]",
    // Variant-prefixed forms are still dead.
    "sm:font-[var(--font-ln-mono)]",
    "hover:font-[var(--font-ln-serif)]",
    // Real-world shape: one class among many.
    "m-0 font-[var(--font-ln-serif)] text-3xl font-semibold",
  ];
  for (const cls of BAD) {
    it(`flags "${cls}"`, () => {
      DEAD_FONT_VAR.lastIndex = 0;
      expect(cls).toMatch(DEAD_FONT_VAR);
    });
  }
});

describe("DEAD_FONT_VAR — precision (no false positives)", () => {
  const GOOD = [
    // The correct, working form — compiles to a real font-family.
    "font-ln-mono",
    "font-ln-serif",
    "font-ln-sans",
    // Weight and style utilities share the prefix but are unambiguous.
    "font-semibold",
    "font-medium",
    "font-bold",
    "font-italic",
    // Rule 9's territory, not rule 10's.
    "text-[var(--text-sm)]",
    // Other arbitrary token forms that are correct and must stay untouched.
    "bg-[var(--color-ln-card)]",
    "rounded-[var(--radius-sm)]",
    "shadow-[var(--shadow-md)]",
  ];
  for (const cls of GOOD) {
    it(`does NOT flag "${cls}"`, () => {
      DEAD_FONT_VAR.lastIndex = 0;
      expect(cls).not.toMatch(DEAD_FONT_VAR);
    });
  }
});

describe("DEAD_FONT_VAR and DEAD_TEXT_VAR do not overlap", () => {
  it("each rule owns exactly its own prefix", () => {
    DEAD_FONT_VAR.lastIndex = 0;
    DEAD_TEXT_VAR.lastIndex = 0;
    expect("font-[var(--font-ln-mono)]").not.toMatch(DEAD_TEXT_VAR);
    DEAD_TEXT_VAR.lastIndex = 0;
    DEAD_FONT_VAR.lastIndex = 0;
    expect("text-[var(--text-sm)]").not.toMatch(DEAD_FONT_VAR);
  });
});

describe("STATUS_COMPONENTS — guarded set includes the CaseBadge holdout", () => {
  it("includes components/CaseBadge.tsx (the 5th status component)", () => {
    const hasCaseBadge = [...STATUS_COMPONENTS].some((p) => p.includes("CaseBadge.tsx"));
    expect(hasCaseBadge).toBe(true);
  });
});

// A tiny theme fixture standing in for app/globals.css. The guard parses the
// real file at runtime; the test pins the parse + detection logic.
const THEME_CSS = `
  :root {
    --color-ln-op-ok: #1e7a3e;
    --color-ln-op-ok-bg: #e5f4eb;
    --color-ln-op-warn: #96600e;
    --color-ln-op-danger: #b71c1c;
    --color-ln-op-azul-700: #0a4576;
    --color-ln-op-stripe: #f7f9fb;
  }
`;

/** Return the undefined <name>s the guard would flag on a className string. */
function undefinedOpTokens(cls: string, allowlist: Set<string>): string[] {
  OP_TOKEN_UTILITY.lastIndex = 0;
  return [...cls.matchAll(OP_TOKEN_UTILITY)].map((m) => m[1]).filter((n) => !allowlist.has(n));
}

describe("parseDefinedOpTokens — builds the allowlist from theme CSS", () => {
  it("extracts simple and compound token names", () => {
    const tokens = parseDefinedOpTokens(THEME_CSS);
    expect(tokens.has("ok")).toBe(true);
    expect(tokens.has("ok-bg")).toBe(true);
    expect(tokens.has("azul-700")).toBe(true);
    expect(tokens.has("stripe")).toBe(true);
    // Never-defined Spanish color names must be absent.
    expect(tokens.has("verde")).toBe(false);
    expect(tokens.has("rojo")).toBe(false);
    expect(tokens.has("amarillo")).toBe(false);
  });
});

describe("undefined ln-op-* token guard — silent-invisible class", () => {
  const allowlist = parseDefinedOpTokens(THEME_CSS);

  it("flags the undefined Spanish color tokens", () => {
    expect(undefinedOpTokens("text-ln-op-verde", allowlist)).toEqual(["verde"]);
    expect(undefinedOpTokens("bg-ln-op-rojo", allowlist)).toEqual(["rojo"]);
    expect(undefinedOpTokens("text-ln-op-amarillo", allowlist)).toEqual(["amarillo"]);
    expect(undefinedOpTokens("hover:bg-ln-op-hover", allowlist)).toEqual(["hover"]);
    expect(undefinedOpTokens("bg-ln-op-fake", allowlist)).toEqual(["fake"]);
  });

  it("does NOT flag defined tokens (incl. compound + opacity + variant forms)", () => {
    expect(undefinedOpTokens("bg-ln-op-ok", allowlist)).toEqual([]);
    expect(undefinedOpTokens("bg-ln-op-ok-bg", allowlist)).toEqual([]);
    expect(undefinedOpTokens("hover:bg-ln-op-stripe/50", allowlist)).toEqual([]);
    expect(undefinedOpTokens("focus:ring-ln-op-azul-700", allowlist)).toEqual([]);
    expect(undefinedOpTokens("text-ln-op-danger text-ln-op-warn bg-ln-op-ok", allowlist)).toEqual(
      [],
    );
  });

  it("flags only the undefined token in a mixed className", () => {
    expect(
      undefinedOpTokens("text-ln-op-ok bg-ln-op-verde border-ln-op-danger", allowlist),
    ).toEqual(["verde"]);
  });
});

// ===========================================================================
// Rules C1–C8 — the CSS half of the fence (scripts/css-token-scan.ts).
//
// Until 2026-07-31 the fence globbed only {app,components}/**/*.{ts,tsx}, so
// all four stylesheets in the repo — including the 4184-line app/globals.css
// that DEFINES the typographic scale — were outside every guard. These tests
// pin the reader's behaviour on fixtures; the ratchet itself is exercised by
// live mutation of the real sheet.
// ===========================================================================

/** Categories flagged for a one-rule fixture, in source order. */
function categoriesOf(css: string, opts?: Parameters<typeof scanCss>[1]): CssCategory[] {
  return scanCss(css, opts).map((v) => v.category);
}

describe("stripCssComments — the fence has been fooled by comments twice", () => {
  it("blanks comment bodies but preserves line AND column positions", () => {
    const css = "a {\n  /* font-size: 8px; */\n  color: red;\n}\n";
    const out = stripCssComments(css);
    expect(out.split("\n").length).toBe(css.split("\n").length);
    expect(out.length).toBe(css.length);
    expect(out).not.toContain("font-size");
    expect(out).toContain("color: red;");
  });

  it("preserves newlines inside a MULTI-line comment so later line numbers stay true", () => {
    const css = ".a {\n  /* one\n     two\n     three */\n  font-size: 13px;\n}\n";
    const hits = scanCss(css);
    expect(hits.map((h) => h.category)).toEqual(["fontSize"]);
    // The declaration is on source line 5 — only correct if the three comment
    // lines were preserved as newlines rather than collapsed.
    expect(hits[0].line).toBe(5);
  });

  it("does NOT count a font-size quoted inside a comment", () => {
    // This is app/globals.css:570 in miniature — "iOS Safari zooms into any
    // input whose computed font-size is below 16px" is prose, and a line-wise
    // `rg font-size` counts it. That single comment is the whole difference
    // between RA-10's reported 130 raw font-sizes and the executable 129.
    const css =
      ".a {\n  /* font-size: 8px is too small, and #ff0000 is not a token */\n  color: red;\n}\n";
    expect(scanCss(css)).toEqual([]);
  });

  it("does NOT count a border-radius or box-shadow quoted inside a comment", () => {
    const css = "/* border-radius: 8px; box-shadow: 0 1px 2px #000; */\n.a { color: red; }\n";
    expect(scanCss(css)).toEqual([]);
  });
});

describe("rule C1 — raw font-size", () => {
  it("flags a raw px size and does NOT flag the token form", () => {
    expect(categoriesOf(".a { font-size: 13px; }")).toEqual(["fontSize"]);
    expect(categoriesOf(".a { font-size: var(--text-md); }")).toEqual([]);
  });

  it("flags rem/em literals — they are raw values too, just in another unit", () => {
    expect(categoriesOf(".a { font-size: 1.125rem; }")).toEqual(["fontSize"]);
  });

  it("does NOT flag keywords or relative percentages", () => {
    expect(categoriesOf(".a { font-size: inherit; }")).toEqual([]);
    expect(categoriesOf(".a { font-size: 100%; }")).toEqual([]);
  });

  it("does NOT flag declarations inside @theme — that is where tokens are DEFINED", () => {
    expect(categoriesOf("@theme { --text-sm: 12px; --radius-lg: 8px; }")).toEqual([]);
  });
});

describe("rule C2 — half-pixel font-size gets its own counter", () => {
  it("flags 12.5px as BOTH fontSize and fontHalfPx (overlapping, not partitioned)", () => {
    // Overlap is deliberate. If half-px PARTITIONED fontSize instead, then
    // consolidating 12.5px -> 13px would decrement fontHalfPx and INCREMENT
    // fontSize, so the ratchet would fail on a genuine improvement.
    expect(categoriesOf(".a { font-size: 12.5px; }")).toEqual(["fontSize", "fontHalfPx"]);
  });

  it("does not treat a whole-pixel size as half-pixel", () => {
    expect(categoriesOf(".a { font-size: 12px; }")).toEqual(["fontSize"]);
  });

  it("counts a below-floor half-pixel in all three counters", () => {
    // 8.5px is .ln-prov — the verificado/autodeclarado chip on the public
    // credential, i.e. the trust signal of the whole document.
    expect(categoriesOf(".a { font-size: 8.5px; }", { floorPx: 10 })).toEqual([
      "fontSize",
      "fontHalfPx",
      "fontBelowFloor",
    ]);
  });
});

describe("rule C3 — font-size below the scale's own floor", () => {
  it("reads the floor from --text-xs in the sheet itself", () => {
    const css = "@theme { --text-xs: 10px; }\n.ln-qr-cap { font-size: 8px; }\n";
    expect(categoriesOf(css)).toEqual(["fontSize", "fontBelowFloor"]);
  });

  it("does not flag a size sitting exactly on the floor", () => {
    expect(categoriesOf(".a { font-size: 10px; }", { floorPx: 10 })).toEqual(["fontSize"]);
  });
});

describe("rule C1/C3 — clamp() is a deliberate fluid choice, but not an escape hatch", () => {
  it("does NOT flag a fluid ramp as a raw size", () => {
    // The scale is a ladder of fixed px steps with no fluid token, so flagging
    // this would push the author toward a WORSE fixed value.
    expect(categoriesOf(".a { font-size: clamp(17px, 1.7vw, 21px); }", { floorPx: 10 })).toEqual(
      [],
    );
  });

  it("DOES flag a fluid ramp whose minimum is below the floor", () => {
    // Otherwise `clamp(8px, 8px, 8px)` would be an open door through the floor.
    expect(categoriesOf(".a { font-size: clamp(8px, 1vw, 14px); }", { floorPx: 10 })).toEqual([
      "fontBelowFloor",
    ]);
  });

  it("DOES flag it when the minimum is spelled in rem", () => {
    // The px case above was the only one covered, so the entire rem spelling of
    // the defect went unmeasured: 0.5rem is 8px on screen, and the rule is
    // about legibility, not notation. A test that covers one spelling of a
    // value reads as covering the value.
    expect(categoriesOf(".a { font-size: clamp(0.5rem, 1vw, 2rem); }", { floorPx: 10 })).toEqual([
      "fontBelowFloor",
    ]);
  });

  it("does NOT flag a rem ramp that clears the floor", () => {
    // The control: without it, converting rem at any multiplier at all — or
    // flagging every rem outright — would pass the test above.
    expect(categoriesOf(".a { font-size: clamp(1rem, 1vw, 2rem); }", { floorPx: 10 })).toEqual([]);
  });

  it("does NOT convert em — it resolves against the parent, which no static scan knows", () => {
    expect(categoriesOf(".a { font-size: clamp(0.5em, 1vw, 2em); }", { floorPx: 10 })).toEqual([]);
  });
});

describe("rule C4 — border-radius", () => {
  it("flags raw px, including the pill written out longhand", () => {
    expect(categoriesOf(".a { border-radius: 8px; }")).toEqual(["radius"]);
    // --radius-pill exists precisely for this.
    expect(categoriesOf(".a { border-radius: 999px; }")).toEqual(["radius"]);
  });

  it("does NOT flag the token form, zero, or a percentage SHAPE", () => {
    expect(categoriesOf(".a { border-radius: var(--radius-pill); }")).toEqual([]);
    expect(categoriesOf(".a { border-radius: 0; }")).toEqual([]);
    // 50% is a circle. No --radius-* token can express it and none ever will,
    // so flagging it would emit advice with no valid target.
    expect(categoriesOf(".a { border-radius: 50%; }")).toEqual([]);
  });

  it("covers the per-corner longhands", () => {
    expect(categoriesOf(".a { border-top-left-radius: 6px; }")).toEqual(["radius"]);
    expect(categoriesOf(".a { border-end-end-radius: 6px; }")).toEqual(["radius"]);
  });
});

describe("rules C5/C6 — box-shadow and raw hex", () => {
  it("flags a raw shadow but not the token form or none", () => {
    expect(categoriesOf(".a { box-shadow: 0 1px 2px rgba(0,0,0,.1); }")).toEqual(["shadow"]);
    expect(categoriesOf(".a { box-shadow: var(--shadow-md); }")).toEqual([]);
    expect(categoriesOf(".a { box-shadow: none; }")).toEqual([]);
  });

  it("flags a hex literal in a normal declaration", () => {
    expect(categoriesOf(".a { color: #fff; }")).toEqual(["hex"]);
  });

  it("does NOT flag a hex in a CUSTOM PROPERTY — that is the token definition", () => {
    // `.op-surface { --color-ln-op-page: #0a0f1c }` is the single source of
    // truth for the operator skin, not drift.
    expect(categoriesOf(".op-surface { --color-ln-op-page: #0a0f1c; }")).toEqual([]);
  });

  it("counts every hex in a multi-stop gradient", () => {
    expect(categoriesOf(".a { background: linear-gradient(#fff 0%, #000 100%); }")).toEqual([
      "hex",
      "hex",
    ]);
  });
});

describe("rule C8 — raw transition/animation duration", () => {
  it("flags a raw duration in either longhand", () => {
    expect(categoriesOf(".a { transition-duration: 200ms; }")).toEqual(["duration"]);
    expect(categoriesOf(".a { animation-duration: 0.4s; }")).toEqual(["duration"]);
  });

  it("flags every literal in a shorthand, not just the first", () => {
    // Two values a later edit can drift apart independently — counting the
    // declaration once would let a half-migrated shorthand read as clean.
    expect(
      categoriesOf(".a { transition: opacity 150ms ease-out, transform 180ms ease-out; }"),
    ).toEqual(["duration", "duration"]);
  });

  it("does NOT flag the token form", () => {
    expect(categoriesOf(".a { transition: opacity var(--motion-fast) ease-out; }")).toEqual([]);
    expect(
      categoriesOf(".a { animation: skeleton-sweep var(--motion-ambient) linear infinite; }"),
    ).toEqual([]);
  });

  it("still catches a half-migrated shorthand", () => {
    expect(categoriesOf(".a { transition: opacity var(--motion-fast), transform 200ms; }")).toEqual(
      ["duration"],
    );
  });

  it("does NOT flag `none`, zero, or the prefers-reduced-motion floor", () => {
    expect(categoriesOf(".a { transition: none; }")).toEqual([]);
    expect(categoriesOf(".a { transition: opacity 0s; }")).toEqual([]);
    // The 0.01ms floor is the OFF SWITCH for the whole motion system, not a
    // step on the scale — baselining it would park a permanently-unfixable
    // violation in the ratchet.
    expect(categoriesOf("* { animation-duration: 0.01ms !important; }")).toEqual([]);
  });

  it("does NOT flag a DELAY — a cadence is not a step on the motion scale", () => {
    expect(categoriesOf(".a { transition-delay: 80ms; }")).toEqual([]);
    expect(categoriesOf(".a { transition-delay: calc(var(--d, 0) * 80ms); }")).toEqual([]);
  });

  it("does NOT read an identifier as a duration", () => {
    // A keyframes name ending in a digit, and the easing keywords, both sit
    // next to the duration slot in the shorthand grammar.
    expect(categoriesOf(".a { animation: fade2s var(--motion-fast) ease-in-out both; }")).toEqual(
      [],
    );
  });

  it("does NOT flag the token DEFINITION — that is where raw values belong", () => {
    expect(categoriesOf(":root { --motion-base: 180ms; }")).toEqual([]);
  });
});

describe("rule C7 — a font-weight the family never loaded", () => {
  // next/font downloads ONLY the listed weights. The browser then remaps a
  // missing weight to the nearest available face, so the declaration reads as
  // intent and renders as something else — the CSS shape of the same
  // silently-dead-declaration class that JSX rules 9 and 10 exist for.
  const LAYOUT = `
    const ibmPlexMono = IBM_Plex_Mono({
      subsets: ["latin"],
      weight: ["400", "600"],
      variable: "--a-mono-font",
      display: "swap",
    });
    const encodeSans = Encode_Sans({
      subsets: ["latin"],
      weight: ["400", "500", "600", "700"],
      variable: "--encode-sans-font",
      display: "swap",
    });
  `;
  const fontWeightSets = parseFontWeightSets(LAYOUT);

  const THEME = `@theme {
    --font-ln-mono: var(--a-mono-font, "IBM Plex Mono"), "Menlo", monospace;
    --font-sans: var(--encode-sans-font, "Encode Sans"), system-ui;
  }
  `;

  it("parses the weight sets out of the next/font calls", () => {
    expect([...(fontWeightSets.get("--a-mono-font") ?? [])].sort()).toEqual([400, 600]);
    expect([...(fontWeightSets.get("--encode-sans-font") ?? [])].sort()).toEqual([
      400, 500, 600, 700,
    ]);
  });

  it("resolves a font-family through the sheet's own alias chain", () => {
    const vars = new Map([
      ["--lp-mono", "var(--font-ln-mono)"],
      ["--font-ln-mono", 'var(--a-mono-font, "IBM Plex Mono"), monospace'],
    ]);
    expect(resolveFontVar("var(--lp-mono)", vars)).toBe("--a-mono-font");
    expect(resolveFontVar("Georgia, serif", vars)).toBeNull();
  });

  it("flags .ln-band-title asking for 500 on a 400/600 family", () => {
    // The line naming the credential: 10px, 0.24em tracking, white on navy.
    // It asks for medium and draws regular.
    const css = `${THEME}
      .ln-band-title { font-family: var(--font-ln-mono); font-weight: 500; }`;
    expect(categoriesOf(css, { fontWeightSets })).toEqual(["deadWeight"]);
  });

  it("flags 700 on the same family — 700 is not loaded either", () => {
    const css = `${THEME}.ln-ledlbl { font-family: var(--font-ln-mono); font-weight: 700; }`;
    expect(categoriesOf(css, { fontWeightSets })).toEqual(["deadWeight"]);
  });

  it("does NOT flag a weight the family actually loaded", () => {
    const css = `${THEME}.a { font-family: var(--font-ln-mono); font-weight: 600; }`;
    expect(categoriesOf(css, { fontWeightSets })).toEqual([]);
    const css2 = `${THEME}.b { font-family: var(--font-sans); font-weight: 500; }`;
    expect(categoriesOf(css2, { fontWeightSets })).toEqual([]);
  });

  it("flags a dead weight declared through the `font:` SHORTHAND", () => {
    // The blind spot that made every audit of this problem count FOUR dead CSS
    // declarations when there were five. `.lp-hcard-badge` declares its weight
    // in the shorthand and has no `font-weight` property at all, so a rule that
    // looks only for `font-weight` — which is what C7 did, and what a grep does
    // — cannot see it.
    const css = `${THEME}.lp-hcard-badge { font: 700 10px / 1 var(--font-ln-mono); }`;
    expect(categoriesOf(css, { fontWeightSets })).toEqual(["deadWeight"]);
  });

  it("does NOT flag a shorthand whose weight the family loaded", () => {
    const css = `${THEME}.a { font: 600 10px / 1 var(--font-ln-mono); }`;
    expect(categoriesOf(css, { fontWeightSets })).toEqual([]);
  });

  it("lets a later font-weight override the shorthand's weight", () => {
    // Shorthand sets 600 (loaded), the following declaration resets it to 700
    // (not loaded). Last declaration wins, so this rule IS dead.
    const dead = `${THEME}.a { font: 600 10px / 1 var(--font-ln-mono); font-weight: 700; }`;
    expect(categoriesOf(dead, { fontWeightSets })).toEqual(["deadWeight"]);
    // And the reverse: shorthand's 600 wins over an earlier dead 700.
    const live = `${THEME}.a { font-weight: 700; font: 600 10px / 1 var(--font-ln-mono); }`;
    expect(categoriesOf(live, { fontWeightSets })).toEqual([]);
  });

  it("fails OPEN on a shorthand it cannot decompose", () => {
    // No family var to resolve, and a size-only shorthand with no weight —
    // neither may be guessed at.
    const noVar = `${THEME}.a { font: 700 10px / 1 Georgia, serif; }`;
    expect(categoriesOf(noVar, { fontWeightSets })).toEqual([]);
    const noWeight = `${THEME}.a { font: 10px / 1 var(--font-ln-mono); }`;
    expect(categoriesOf(noWeight, { fontWeightSets })).toEqual([]);
    // Two var()s: one of them is the family and one is a size or line-height,
    // and nothing short of the full shorthand grammar can say which. Declining
    // is the point — picking the first or the last would be a coin flip that
    // reports a violation against whichever token happened to lose.
    const ambiguous = `${THEME}.a { font: 700 var(--sz) / 1 var(--font-ln-mono); }`;
    expect(categoriesOf(ambiguous, { fontWeightSets })).toEqual([]);
  });

  it("fails OPEN on anything it cannot resolve", () => {
    // Unknown family, literal stack, keyword weight, and no layout data at all
    // must never produce a violation — a fence that guesses is worse than none.
    const unknown = `${THEME}.a { font-family: var(--font-mystery); font-weight: 500; }`;
    expect(categoriesOf(unknown, { fontWeightSets })).toEqual([]);
    const literal = ".a { font-family: Georgia, serif; font-weight: 500; }";
    expect(categoriesOf(literal, { fontWeightSets })).toEqual([]);
    const keyword = `${THEME}.a { font-family: var(--font-ln-mono); font-weight: lighter; }`;
    expect(categoriesOf(keyword, { fontWeightSets })).toEqual([]);
    const noLayout = `${THEME}.a { font-family: var(--font-ln-mono); font-weight: 500; }`;
    expect(categoriesOf(noLayout)).toEqual([]);
  });
});

describe("bucketing — the landing is its own ratchet, not an exemption", () => {
  it("files a .lp rule under lp and everything else under core", () => {
    const css = ".lp .lp-btn { font-size: 15px; }\n.ln-prov { font-size: 11px; }\n";
    const t = tallyCss(scanCss(css, { file: "app/globals.css" }));
    expect(t["app/globals.css#lp"].fontSize).toBe(1);
    expect(t["app/globals.css#core"].fontSize).toBe(1);
  });

  it("files a .lp-prefixed top-level selector under lp (`.lp-nav`, not just `.lp x`)", () => {
    const t = tallyCss(scanCss(".lp-nav { font-size: 14px; }", { file: "f.css" }));
    expect(t["f.css#lp"].fontSize).toBe(1);
  });

  it("does not mistake a class merely starting with the letters lp", () => {
    const t = tallyCss(scanCss(".lpx-thing { font-size: 14px; }", { file: "f.css" }));
    expect(t["f.css#core"].fontSize).toBe(1);
  });

  it("files a .lp rule nested in @media under lp", () => {
    const css = "@media (max-width: 560px) {\n  .lp .lp-h-hero { font-size: 30px; }\n}\n";
    const t = tallyCss(scanCss(css, { file: "f.css" }));
    expect(t["f.css#lp"].fontSize).toBe(1);
  });

  it("bucketing survives the block-close path used by rule C7", () => {
    // Regression guard: closeBlock() pops the selector stack, so computing the
    // bucket from the SURVIVING ancestors would file every single-level `.lp x`
    // rule under core.
    const fontWeightSets = parseFontWeightSets(
      'const f = IBM_Plex_Mono({ weight: ["400","600"], variable: "--a-mono-font" });',
    );
    const css = `@theme { --lp-mono: var(--a-mono-font, "IBM Plex Mono"); }
      .lp .lp-ch-num { font-family: var(--lp-mono); font-weight: 500; }`;
    const t = tallyCss(scanCss(css, { file: "f.css", fontWeightSets }));
    expect(t["f.css#lp"]?.deadWeight).toBe(1);
    expect(t["f.css#core"]?.deadWeight ?? 0).toBe(0);
  });
});

describe("walker robustness", () => {
  it("does not split a declaration on a semicolon inside parentheses", () => {
    const css = '.a { background: url("data:image/svg+xml;utf8,<svg/>"); color: #fff; }';
    expect(categoriesOf(css)).toEqual(["hex"]);
  });

  it("catches a final declaration with no trailing semicolon", () => {
    expect(categoriesOf(".a { font-size: 13px }")).toEqual(["fontSize"]);
  });

  it("ignores top-level at-rule statements", () => {
    expect(
      categoriesOf('@import "tailwindcss";\n@variant dark (&:where(.dark, .dark *));'),
    ).toEqual([]);
  });

  it("reports the line and column of the property, on the stripped source", () => {
    const css = ".a {\n  color: red;\n  font-size: 8px;\n}\n";
    const [hit] = scanCss(css, { floorPx: 10 });
    expect(hit.line).toBe(3);
    expect(hit.col).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Rule 11 — var(--color-ln-*) references must resolve to a declared token.
//
// The bug this closes: `--color-ln-paper-2`, `--color-ln-rule` and
// `--color-ln-canvas` were referenced by six call sites while declared nowhere.
// `bg-[var(--token)]` is a BLESSED form, so no existing rule looked at the name
// inside it, and an undefined custom property fails silently — the surface just
// renders with no background.
// ---------------------------------------------------------------------------

/** The token names a reference scan would flag against `declared`. */
function unresolvedLnRefs(src: string, declared: Set<string>): string[] {
  LN_TOKEN_VAR_REFERENCE.lastIndex = 0;
  return [...src.matchAll(LN_TOKEN_VAR_REFERENCE)].map((m) => m[1]).filter((n) => !declared.has(n));
}

const LN_THEME_CSS = `
  @theme {
    --color-ln-paper: #fbfaf5;
    --color-ln-paper-2: #f8f7f1;
    --color-ln-line: #e4dfd3;
    --color-ln-ok-050: #eef6f0;
    --color-ln-op-ok: #1e7a3e;
  }
`;

describe("parseDefinedLnTokens — builds the allowlist from theme CSS", () => {
  const declared = parseDefinedLnTokens(LN_THEME_CSS);

  it("extracts simple, numeric-suffixed and compound token names", () => {
    expect(declared.has("ln-paper")).toBe(true);
    expect(declared.has("ln-paper-2")).toBe(true);
    expect(declared.has("ln-ok-050")).toBe(true);
    // The ln-op-* operator palette shares the prefix and is covered too.
    expect(declared.has("ln-op-ok")).toBe(true);
  });

  it("does not invent tokens that were never declared", () => {
    expect(declared.has("ln-rule")).toBe(false);
    expect(declared.has("ln-canvas")).toBe(false);
  });
});

describe("LN_TOKEN_VAR_REFERENCE — recall over the forms the repo actually uses", () => {
  const declared = parseDefinedLnTokens(LN_THEME_CSS);

  it("flags the three real dangling tokens, in their real spellings", () => {
    // className arbitrary value — both login notices and the row hover.
    expect(unresolvedLnRefs('className="bg-[var(--color-ln-paper-2)]"', new Set())).toEqual([
      "ln-paper-2",
    ]);
    expect(unresolvedLnRefs("hover:bg-[var(--color-ln-paper-2)]", new Set())).toEqual([
      "ln-paper-2",
    ]);
    // style-prop object value — the "sin confirmar" vaccine badge.
    expect(unresolvedLnRefs('border: "var(--color-ln-rule)",', declared)).toEqual(["ln-rule"]);
    // The whole <main> ground of asistencia/presentar.
    expect(unresolvedLnRefs("bg-[var(--color-ln-canvas)]", declared)).toEqual(["ln-canvas"]);
    // Plain CSS, same bug class.
    expect(unresolvedLnRefs("background: var(--color-ln-canvas);", declared)).toEqual([
      "ln-canvas",
    ]);
  });

  it("does NOT flag declared tokens", () => {
    expect(unresolvedLnRefs("bg-[var(--color-ln-paper-2)]", declared)).toEqual([]);
    expect(
      unresolvedLnRefs("border-[var(--color-ln-line)] bg-[var(--color-ln-ok-050)]", declared),
    ).toEqual([]);
    expect(unresolvedLnRefs("text-[var(--color-ln-op-ok)]", declared)).toEqual([]);
  });

  it("flags only the undefined token in a mixed className", () => {
    expect(
      unresolvedLnRefs(
        'className="border-[var(--color-ln-line)] bg-[var(--color-ln-rule)]"',
        declared,
      ),
    ).toEqual(["ln-rule"]);
  });

  it("ignores the fallback form, which is not this bug", () => {
    // `var(--x, #fff)` renders the fallback, so an undeclared name there is not
    // the silent-invisible defect. Out of scope ON PURPOSE, not by oversight.
    expect(unresolvedLnRefs("var(--color-ln-canvas, #fbfaf5)", declared)).toEqual([]);
  });
});

describe("regression — the real globals.css resolves every ln-* reference", () => {
  const declared = parseDefinedLnTokens(readFileSync("app/globals.css", "utf8"));

  it("declares the token four call sites across three files were already using", () => {
    expect(declared.has("ln-paper-2")).toBe(true);
  });

  it("leaves no dangling reference anywhere in app/ or components/", () => {
    // Belt and braces over the CLI scan: a dangle reintroduced in a file the
    // globs miss would still be caught by the scan, but this pins the two
    // repointed call sites specifically.
    const badge = readFileSync("components/pet-profile/VacunasStatusBadges.tsx", "utf8");
    expect(unresolvedLnRefs(badge, declared)).toEqual([]);
    const presentar = readFileSync(
      "app/(app)/mis-mascotas/[publicToken]/asistencia/presentar/page.tsx",
      "utf8",
    );
    expect(unresolvedLnRefs(presentar, declared)).toEqual([]);
  });
});

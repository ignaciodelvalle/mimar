// Offline guard for the design-token parity fence
// (scripts/check-design-token-parity.ts).
//
// The fence's verdict rests on two things: what it manages to parse out of the
// `@theme` block, and what it does with a value that disagrees. Both are pinned
// here against synthetic CSS, so a change to the parser cannot quietly turn the
// fence into a green light — and one test runs the comparison against the REAL
// app/globals.css, so the pair cannot pass in the abstract while the shipped
// files disagree.

import { readFileSync } from "node:fs";

import { LN_CSS_FONT_TOKENS, LN_CSS_TOKENS, LN_RADII, LN_TYPE } from "@dim/contract/tokens";
import { describe, expect, it } from "vitest";

import {
  GLOBALS_CSS,
  MIN_THEME_DECLARATIONS,
  MIN_TOKENS_CHECKED,
  compareExact,
  compareFontFamilies,
  parseThemeBlock,
  tokensChecked,
} from "@/scripts/check-design-token-parity";

describe("parseThemeBlock", () => {
  it("reads name → value pairs out of the block", () => {
    const declarations = parseThemeBlock("@theme {\n  --color-ln-azul: #0e5a99;\n}");
    expect(declarations.get("--color-ln-azul")).toBe("#0e5a99");
  });

  it("collapses a declaration wrapped across lines — the font stacks are", () => {
    const css =
      '@theme {\n  --font-ln-serif: var(--a-serif-font, "IBM Plex Serif"),\n    Georgia,\n    serif;\n}';
    expect(parseThemeBlock(css).get("--font-ln-serif")).toBe(
      'var(--a-serif-font, "IBM Plex Serif"), Georgia, serif',
    );
  });

  // THE ORDERING BUG THIS PINS. globals.css documents nearly every token, and a
  // brace matcher that ran BEFORE comments were stripped would close the block
  // at a brace inside prose — returning a PREFIX of the tokens, which parses
  // fine and passes for everything it happens to include.
  it("is not closed early by a brace inside a comment", () => {
    const css = [
      "@theme {",
      "  --radius-sm: 4px;",
      "  /* the pill is scale-invariant: at any size, radius } stays correct */",
      "  --radius-pill: 9999px;",
      "}",
    ].join("\n");
    const declarations = parseThemeBlock(css);
    expect(declarations.get("--radius-pill")).toBe("9999px");
    expect(declarations.size).toBe(2);
  });

  it("returns nothing when there is no @theme block — the caller treats that as a broken parse", () => {
    expect(parseThemeBlock(":root { --color-ln-azul: #0e5a99; }").size).toBe(0);
  });
});

describe("compareExact", () => {
  it("is silent when every token agrees", () => {
    const declarations = new Map<string, string>(Object.entries(LN_CSS_TOKENS));
    expect(compareExact(declarations)).toEqual([]);
  });

  // Both directions of value drift reach this function as the same shape: one
  // key, two different strings. Which side was edited is not something the
  // fence can know, and the message says so.
  it("reports a value edited on the CSS side", () => {
    const declarations = new Map<string, string>(Object.entries(LN_CSS_TOKENS));
    declarations.set("--color-ln-azul", "#0e5a9a");
    expect(compareExact(declarations)).toEqual([
      { token: "--color-ln-azul", expected: "#0e5a99", actual: "#0e5a9a", rule: "equals" },
    ]);
  });

  it("reports a property the CSS no longer declares at all", () => {
    const declarations = new Map<string, string>(Object.entries(LN_CSS_TOKENS));
    declarations.delete("--radius-input");
    expect(compareExact(declarations)).toEqual([
      { token: "--radius-input", expected: "10px", actual: undefined, rule: "equals" },
    ]);
  });
});

describe("compareFontFamilies", () => {
  it("accepts the real stack shape — the family inside a var() fallback", () => {
    const declarations = new Map([
      ["--font-ln-serif", 'var(--a-serif-font, "IBM Plex Serif"), Georgia, serif'],
      ["--font-ln-sans", 'var(--a-sans-font, "IBM Plex Sans"), system-ui, sans-serif'],
      ["--font-ln-mono", 'var(--a-mono-font, "IBM Plex Mono"), "Menlo", monospace'],
    ]);
    expect(compareFontFamilies(declarations)).toEqual([]);
  });

  it("refuses a stack the family was swapped out of", () => {
    const declarations = new Map([
      ["--font-ln-serif", 'var(--a-serif-font, "Source Serif"), Georgia, serif'],
      ["--font-ln-sans", 'var(--a-sans-font, "IBM Plex Sans"), system-ui, sans-serif'],
      ["--font-ln-mono", 'var(--a-mono-font, "IBM Plex Mono"), "Menlo", monospace'],
    ]);
    expect(compareFontFamilies(declarations)).toEqual([
      {
        token: "--font-ln-serif",
        expected: "IBM Plex Serif",
        actual: 'var(--a-serif-font, "Source Serif"), Georgia, serif',
        rule: "contains",
      },
    ]);
  });
});

describe("the floors", () => {
  it("counts every fenced token, exact-match and font alike", () => {
    expect(tokensChecked()).toBe(
      Object.keys(LN_CSS_TOKENS).length + Object.keys(LN_CSS_FONT_TOKENS).length,
    );
  });

  // A ratchet: exports may grow freely, but dropping below the floor has to be
  // a deliberate edit to the fence rather than a quiet deletion here.
  it("exports at least as many tokens as the floor demands", () => {
    expect(tokensChecked()).toBeGreaterThanOrEqual(MIN_TOKENS_CHECKED);
  });
});

describe("against the real app/globals.css", () => {
  const declarations = parseThemeBlock(readFileSync(GLOBALS_CSS, "utf8"));

  it("parses a real @theme block, well above the non-vacuity floor", () => {
    expect(declarations.size).toBeGreaterThanOrEqual(MIN_THEME_DECLARATIONS);
  });

  it("agrees with the shipped CSS on every token", () => {
    expect([...compareExact(declarations), ...compareFontFamilies(declarations)]).toEqual([]);
  });
});

describe("the derived objects", () => {
  // The ergonomic exports are indexed off LN_CSS_TOKENS rather than restated,
  // which is what makes fencing the raw map sufficient. These pin the
  // derivation itself — a `parseFloat` that started returning NaN would leave
  // the fence green and every native style silently broken.
  it("turns a px declaration into the number a StyleSheet wants", () => {
    expect(LN_RADII.sm).toBe(4);
    expect(LN_RADII.input).toBe(10);
    expect(LN_TYPE.xl3).toBe(28);
  });
});

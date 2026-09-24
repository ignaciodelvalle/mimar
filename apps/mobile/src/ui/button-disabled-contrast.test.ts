// A-3 (M7 accessibility pass) — the disabled PrimaryButton clears 3:1.
//
// WHY THIS EXISTS. `PrimaryButton`'s disabled state fades the WHOLE button
// (fill + white label) to 60% opacity (`DISABLED_OPACITY`, theme.ts) over
// whatever surface it sits on. That composites BOTH colours toward the page
// at once, so the ratio BETWEEN them collapses even though neither one is
// individually hard to see — the same lesson `globals.css`'s hover-trio
// comment already recorded for the web ("Opacity fades the ELEMENT"). Measured
// with the pre-fix fill (`COLORS.accent`) this landed at 2.94–2.99:1,
// under the 3:1 floor WCAG 1.4.11 sets for a UI component. `kit.tsx` now
// swaps the disabled PRIMARY fill for `COLORS.accentPressed` before the
// opacity is applied (`buttonPrimaryDisabledFill`) — this file is the
// arithmetic proof that the swap actually clears the floor, on every surface
// a card can sit on, not just the one it happened to be measured against.
//
// THE HELPER IS THE SAME WCAG 2.1 relative-luminance formula
// `__tests__/token-contrast.test.ts` already uses for the web's tokens — not
// imported from there (that file reads hex straight out of `app/globals.css`,
// a path this package has no reason to depend on), reimplemented here against
// this app's own `COLORS` tokens. An `Rgb` OBJECT rather than a tuple: this
// repo's `tsconfig` has `noUncheckedIndexedAccess`, and a named-field shape
// sidesteps it instead of fighting it with assertions.

import { describe, expect, it } from "@jest/globals";

import { COLORS, DISABLED_OPACITY } from "./theme";

type Rgb = { r: number; g: number; b: number };

function hexToRgb(hex: string): Rgb {
  const clean = hex.replace("#", "");
  return {
    r: Number.parseInt(clean.slice(0, 2), 16),
    g: Number.parseInt(clean.slice(2, 4), 16),
    b: Number.parseInt(clean.slice(4, 6), 16),
  };
}

function channel(c: number): number {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.1 relative luminance. */
function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** Alpha-composites `fg` over `bg` at `alpha` — what `opacity` on the whole
 *  button does to each of its colours against whatever is behind it. */
function blend(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return {
    r: Math.round(fg.r * alpha + bg.r * (1 - alpha)),
    g: Math.round(fg.g * alpha + bg.g * (1 - alpha)),
    b: Math.round(fg.b * alpha + bg.b * (1 - alpha)),
  };
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };

/** Every surface a `PrimaryButton` actually renders on in this app — a card
 *  (`COLORS.surface`) or the page ground (`COLORS.canvas`). Checking only one
 *  is the exact "unchecked pair" mistake `token-contrast.test.ts`'s own header
 *  warns about for the web tokens this app mirrors. */
const SURFACES = {
  "COLORS.surface (white card)": COLORS.surface,
  "COLORS.canvas (cream page)": COLORS.canvas,
} as const;

const AA_UI_COMPONENT = 3.0;

describe("PrimaryButton disabled — white label vs the composited fill clears 3:1", () => {
  for (const [name, surfaceHex] of Object.entries(SURFACES)) {
    it(`on ${name}`, () => {
      const surface = hexToRgb(surfaceHex);
      const text = blend(WHITE, surface, DISABLED_OPACITY);
      // `buttonPrimaryDisabledFill` — accentPressed, not accent. Regressing
      // this back to COLORS.accent is exactly the mutation this test exists
      // to catch: on COLORS.surface that composites to ~2.96:1, under floor.
      const fill = blend(hexToRgb(COLORS.accentPressed), surface, DISABLED_OPACITY);
      const ratio = contrast(text, fill);
      // jest's `expect` (unlike vitest's) takes no assertion-message argument,
      // so the failure context lives in the `it` title and this comment: a red
      // here means the composited ratio fell under the WCAG 1.4.11 floor.
      expect(Number(ratio.toFixed(2))).toBeGreaterThanOrEqual(AA_UI_COMPONENT);
    });
  }

  it("non-vacuity: the PRE-FIX fill (COLORS.accent) actually fails, so this floor has teeth", () => {
    const surface = hexToRgb(COLORS.surface);
    const text = blend(WHITE, surface, DISABLED_OPACITY);
    const preFixFill = blend(hexToRgb(COLORS.accent), surface, DISABLED_OPACITY);
    const ratio = contrast(text, preFixFill);
    expect(ratio).toBeLessThan(AA_UI_COMPONENT);
  });
});

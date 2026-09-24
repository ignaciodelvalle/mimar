// A-3 (M7 accessibility pass, fresh-review follow-up 2026-09-24) — the
// disabled PrimaryButton clears 3:1, read from the RENDERED control.
//
// WHY RENDERED AND NOT THE TOKENS IN ISOLATION. The first version of this file
// computed the ratio from `COLORS.accentPressed` composited under
// `DISABLED_OPACITY` by hand — correct arithmetic for how `opacity` behaves
// on a single flat colour, and WRONG for how Android actually renders it:
// without `needsOffscreenAlphaCompositing`, the platform applies `opacity` PER
// CHILD rather than to the composited result, so the white label and the blue
// fill fade toward the page independently. A hand-computed "composite" ratio
// could stay green forever while the real control drifted under it — the
// exact blind spot a fitness test exists to close. `PrimaryButton` now carries
// NO opacity in its disabled state at all (see its own docblock), so this
// file reads the two colours straight off the rendered node's resolved
// styles — the same thing `StyleSheet.flatten` on a queried element does in
// `PetDocumentScreen.test.tsx` and `DocumentChromeNative.geometry.test.ts` —
// and fails if anyone reintroduces opacity or reverts the fill token.
//
// `.tsx`, NOT `.ts` (the first version's mistake): rendering `<PrimaryButton
// />` needs JSX, which this repo's babel config only parses in a `.tsx` file.
//
// THE HELPER IS THE SAME WCAG 2.1 relative-luminance formula
// `__tests__/token-contrast.test.ts` already uses for the web's tokens — not
// imported from there (that file reads hex straight out of `app/globals.css`,
// a path this package has no reason to depend on), reimplemented here. An
// `Rgb` OBJECT rather than a tuple: this repo's `tsconfig` has
// `noUncheckedIndexedAccess`, and a named-field shape sidesteps it instead of
// fighting it with assertions.

import { describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import { StyleSheet, type TextStyle, type ViewStyle } from "react-native";

import { PrimaryButton } from "./kit";
import { COLORS } from "./theme";

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

const AA_UI_COMPONENT = 3.0;

/** The two page surfaces a `PrimaryButton` actually renders on in this app —
 *  a card (`COLORS.surface`) or the page ground (`COLORS.canvas`). Checking
 *  only one is the exact "unchecked pair" mistake `token-contrast.test.ts`'s
 *  own header warns about for the web tokens this app mirrors. */
const SURFACES = {
  "COLORS.surface (white card)": COLORS.surface,
  "COLORS.canvas (cream page)": COLORS.canvas,
} as const;

describe("PrimaryButton disabled — rendered fill and label clear 3:1, no opacity involved", () => {
  render(<PrimaryButton label="Enviar" onPress={jest.fn()} disabled />);

  const buttonStyle: ViewStyle = StyleSheet.flatten(
    screen.getByRole("button", { name: "Enviar" }).props.style,
  );
  const labelStyle: TextStyle = StyleSheet.flatten(screen.getByText("Enviar").props.style);

  it("carries no opacity at all — Android's per-child compositing is the whole reason this changed", () => {
    expect(buttonStyle.opacity).toBeUndefined();
  });

  it("renders the label fully opaque white", () => {
    expect(labelStyle.color).toBe(COLORS.surface);
  });

  it("renders the fill as COLORS.celeste, not the enabled accent", () => {
    expect(buttonStyle.backgroundColor).toBe(COLORS.celeste);
    expect(buttonStyle.backgroundColor).not.toBe(COLORS.accent);
  });

  it("label vs fill clears 3:1, read straight off the rendered node", () => {
    const ratio = contrast(
      hexToRgb(labelStyle.color as string),
      hexToRgb(buttonStyle.backgroundColor as string),
    );
    expect(Number(ratio.toFixed(2))).toBeGreaterThanOrEqual(AA_UI_COMPONENT);
  });

  for (const [name, surfaceHex] of Object.entries(SURFACES)) {
    it(`fill vs ${name} clears 3:1`, () => {
      const ratio = contrast(hexToRgb(buttonStyle.backgroundColor as string), hexToRgb(surfaceHex));
      expect(Number(ratio.toFixed(2))).toBeGreaterThanOrEqual(AA_UI_COMPONENT);
    });
  }

  it("non-vacuity: the PRE-FIX opacity-composited accent actually failed, so this floor has teeth", () => {
    // Hand-computed, the way the first (wrong) version of this file measured
    // it: white text and COLORS.accent fill, both faded to 60% opacity over
    // COLORS.surface — the defect this whole rewrite exists to close.
    const DISABLED_OPACITY = 0.6;
    const blend = (fg: Rgb, bg: Rgb, alpha: number): Rgb => ({
      r: Math.round(fg.r * alpha + bg.r * (1 - alpha)),
      g: Math.round(fg.g * alpha + bg.g * (1 - alpha)),
      b: Math.round(fg.b * alpha + bg.b * (1 - alpha)),
    });
    const surface = hexToRgb(COLORS.surface);
    const preFixText = blend({ r: 255, g: 255, b: 255 }, surface, DISABLED_OPACITY);
    const preFixFill = blend(hexToRgb(COLORS.accent), surface, DISABLED_OPACITY);
    expect(contrast(preFixText, preFixFill)).toBeLessThan(AA_UI_COMPONENT);
  });
});

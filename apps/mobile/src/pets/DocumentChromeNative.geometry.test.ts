// The band's layout budget, as arithmetic instead of prose.
//
// WHY THIS FILE EXISTS. The band used to be an absolute-title strip whose
// height was derived from a title wrap + in-band situation chip + identity
// poke. The web landing recipe (2026-10) replaced that with padding:
// pad-top + head + pad-bottom. The identity frames rise only into the bottom
// pad. This file pins that sum and the poke ≤ pad-bottom rule so a future
// edit cannot silently collide the photo with the head row.
//
// jest has no Yoga — react-test-renderer produces a JSON tree and never lays
// anything out — so this measures nothing about pixels. What it pins is that
// the constants the chrome exports ARE the numbers the StyleSheets carry.

import { describe, expect, it } from "@jest/globals";
import { StyleSheet, type TextStyle } from "react-native";

import {
  BAND_H,
  BAND_HEAD_MIN_H,
  BAND_MARK_SIZE,
  BAND_MAX_FONT_SCALE,
  BAND_PAD_BOTTOM,
  BAND_PAD_TOP,
  FACE_SECTION_PAD_V,
  IDENTITY_POKE_OUT,
  documentChromeStyles,
} from "./DocumentChromeNative";
import { ownerFaceStyles } from "./OwnerFace";

describe("the band's height is the padding recipe", () => {
  it("sums pad-top + head + pad-bottom", () => {
    expect(BAND_H).toBe(BAND_PAD_TOP + BAND_HEAD_MIN_H + BAND_PAD_BOTTOM);
    expect(BAND_H).toBe(106);
  });

  it("keeps the identity poke inside the bottom pad (no collision with the head)", () => {
    expect(IDENTITY_POKE_OUT).toBeLessThanOrEqual(BAND_PAD_BOTTOM);
    expect(IDENTITY_POKE_OUT).toBe(36);
  });

  it("leaves the head row clear of the rising frames", () => {
    // Frames enter the band at BAND_H + FACE_SECTION_PAD_V − poke, measured
    // from the face content box. Relative to the band's own top that is
    // BAND_H − poke into the band — which must sit at or below the head's
    // bottom (pad-top + head).
    const headBottom = BAND_PAD_TOP + BAND_HEAD_MIN_H;
    const framesEnterBandFromTop = BAND_H - IDENTITY_POKE_OUT;
    expect(framesEnterBandFromTop).toBeGreaterThanOrEqual(headBottom);
  });
});

describe("the StyleSheets carry the constants the recipe quotes", () => {
  it("pins the band's height and padding", () => {
    const band = StyleSheet.flatten(documentChromeStyles.band);
    expect(band.height).toBe(BAND_H);
    expect(band.paddingTop).toBe(BAND_PAD_TOP);
    expect(band.paddingBottom).toBe(BAND_PAD_BOTTOM);
  });

  it("pins the face section's padding", () => {
    expect(StyleSheet.flatten(documentChromeStyles.sec).paddingVertical).toBe(FACE_SECTION_PAD_V);
  });

  it("pins the centred photo mount to the band rise (QR left the face)", () => {
    expect(StyleSheet.flatten(ownerFaceStyles.photoMount).marginTop).toBe(-IDENTITY_POKE_OUT);
    expect(StyleSheet.flatten(ownerFaceStyles.photoMount).width).toBe(116);
  });

  it("pins the turn hit to the web's 22px mark size", () => {
    const hit = StyleSheet.flatten(documentChromeStyles.turnHit);
    expect(hit.width).toBe(BAND_MARK_SIZE);
    expect(hit.height).toBe(BAND_MARK_SIZE);
  });
});

describe("letterhead font-scale cap", () => {
  it("stays at the membrete ceiling (decision 17A)", () => {
    expect(BAND_MAX_FONT_SCALE).toBeLessThanOrEqual(1.3);
  });
});

// ---------------------------------------------------------------------------
// A-2 (2026-09-24, M7 accessibility pass), restored on the new band 2026-10-06.
// ---------------------------------------------------------------------------
//
// EVERYTHING ABOVE IS ARITHMETIC AT THE UNSCALED FONT — the gap the PO's report
// exposed on the old band. The band's text (the doctype) carries
// `maxFontSizeMultiplier={BAND_MAX_FONT_SCALE}` and DOES grow with the
// reader's system font, up to that cap. jest has no Yoga, so this recomputes
// the one quantity that moves with scale — the doctype's line — from the
// StyleSheet itself, capped exactly where the component caps it, and asserts
// the head row and the rising frames still hold.
//
// The in-band chip arithmetic that used to live here is gone with the chip:
// the situation chip left the band (under the name / below the band), and its
// constants were deleted rather than kept as dead exports.

function effectiveScale(systemFontScale: number): number {
  return Math.min(systemFontScale, BAND_MAX_FONT_SCALE);
}

/** The doctype's line box at this system font scale (RN scales lineHeight too). */
function doctypeLineAt(systemFontScale: number): number {
  const doctype: TextStyle = StyleSheet.flatten(documentChromeStyles.bandDoctype);
  const fontSize = doctype.fontSize ?? 0;
  const line = doctype.lineHeight ?? Math.ceil(1.3 * fontSize);
  return Math.ceil(line * effectiveScale(systemFontScale));
}

/** The head row's height: its floor, the 22px marks, or the scaled doctype. */
function headRowAt(systemFontScale: number): number {
  return Math.max(BAND_HEAD_MIN_H, BAND_MARK_SIZE, doctypeLineAt(systemFontScale));
}

describe("A-2: the band head holds at any system font scale", () => {
  // 1.0 (no scaling), 1.3 (exactly the cap), 2.0 (past the cap — must equal
  // 1.3, since BAND_MAX_FONT_SCALE clamps the doctype there).
  const SCALES = [1.0, 1.3, 2.0];

  for (const scale of SCALES) {
    it(`the doctype never grows the head row past its floor, at system font scale ${scale}`, () => {
      expect(headRowAt(scale)).toBe(BAND_HEAD_MIN_H);
    });

    it(`the frames rising into the band still clear the head, at system font scale ${scale}`, () => {
      expect(BAND_H - IDENTITY_POKE_OUT).toBeGreaterThanOrEqual(BAND_PAD_TOP + headRowAt(scale));
    });
  }

  it("1.3 and 2.0 land on the identical line — the cap is doing the clamping, not luck", () => {
    expect(doctypeLineAt(1.3)).toBe(doctypeLineAt(2.0));
  });

  it("non-vacuity: scaling to the cap actually changes the line versus unscaled", () => {
    // If this ever equalled the unscaled line, BAND_MAX_FONT_SCALE broke or the
    // helper stopped reading it, and the loop above checks one budget thrice.
    expect(doctypeLineAt(1.3)).toBeGreaterThan(doctypeLineAt(1.0));
  });
});

// The band's layout budget, as arithmetic instead of prose.
//
// WHY THIS FILE EXISTS. `BAND_H`'s docblock derives the band height from four
// things that share the strip, and until 2026-09-03 that derivation was WRONG
// in two places at once: it omitted `FaceSection`'s own paddingVertical (so it
// placed the identity frames 20 points higher than they are) and it took the
// chip's 10px text as the chip's tallest child when the 16px icon beside it is
// taller (so it measured the chip 5 points short). The two errors cancelled
// into a plausible "nine points of clearance" that described no layout. The
// numbers were prose; nothing read them.
//
// They are constants now, and this file is what reads them. jest has no Yoga —
// react-test-renderer produces a JSON tree and never lays anything out — so
// this measures nothing and asserts nothing about pixels. What it pins is that
// the constants the docblock quotes ARE the numbers the StyleSheets carry, and
// that the arithmetic between them still leaves the chip clear of the frames.
// A future edit to the padding, the poke-out, the chip's line or the band's
// height re-runs the derivation here instead of in somebody's head.
//
// THE ONE THING IT CANNOT SEE is a font swap: the title's wrap and the chip
// text's line height come from IBM Plex Mono's shipped metrics, and a different
// face would move both. The 16px icon is the binding term for the chip's height
// on purpose — it is a fixed number this test can hold.

import { describe, expect, it } from "@jest/globals";
import { StyleSheet, type TextStyle, type ViewStyle } from "react-native";

import { TOUCH_TARGET } from "../ui/theme";
import {
  BAND_CHIP_BORDER,
  BAND_CHIP_PAD_V,
  BAND_CHIP_TOP,
  BAND_H,
  BAND_MAX_FONT_SCALE,
  FACE_SECTION_PAD_V,
  ICON_SM,
  IDENTITY_POKE_OUT,
  documentChromeStyles,
} from "./DocumentChromeNative";
import { ownerFaceStyles } from "./OwnerFace";

/** The chip's bottom edge, band-relative. The 16px icon is the tallest child. */
const chipBottom = BAND_CHIP_TOP + 2 * BAND_CHIP_BORDER + 2 * BAND_CHIP_PAD_V + ICON_SM;

/** Where the identity frames' white ring enters the band. `FaceSection`'s
 *  padding is the term the old docblock omitted. */
const frameTop = BAND_H + FACE_SECTION_PAD_V - IDENTITY_POKE_OUT;

/** The minimum gap between the state chip and the frames rising into the band.
 *  Below this the credential's headline signal starts sliding back under a
 *  photograph, which is the 2026-09-03 defect that raised BAND_H in the first
 *  place. */
const MIN_CLEARANCE = 8;

describe("the band's height is a budget the numbers actually add up to", () => {
  it("puts the chip's bottom and the frames' top where the docblock says", () => {
    expect(chipBottom).toBe(102);
    expect(frameTop).toBe(116);
  });

  it("leaves the state chip clear of the frames that rise into the band", () => {
    expect(frameTop - chipBottom).toBeGreaterThanOrEqual(MIN_CLEARANCE);
  });

  it("puts the chip's line below the flip control (A-1: a TOUCH_TARGET square at top 14)", () => {
    const FLIP_TOP = 14;
    expect(BAND_CHIP_TOP).toBeGreaterThanOrEqual(FLIP_TOP + TOUCH_TARGET);
  });

  it("puts the chip's line below a two-line title, unscaled", () => {
    // The title wraps to two lines at 360dp: top 16 + 2 × 13.0 + 3 marginTop +
    // the 10.4 subtitle line. The chip must clear that too.
    expect(BAND_CHIP_TOP).toBeGreaterThanOrEqual(16 + 2 * 13 + 3 + Math.ceil(1.3 * 8));
  });

  it("keeps the 16px icon as the chip's tallest child, which the height assumes", () => {
    // Widened to `TextStyle`: `flatten` keeps the literal's own keys, and the
    // point of this assertion is the key that is NOT there.
    const text: TextStyle = StyleSheet.flatten(documentChromeStyles.bandChipText);
    expect(text.fontSize).toBe(10);
    // No explicit lineHeight, so the text measures ~1.30em = 13 — under the
    // icon. A lineHeight taller than ICON_SM would silently grow the chip and
    // eat the clearance above.
    expect(text.lineHeight ?? Math.ceil(1.3 * (text.fontSize ?? 0))).toBeLessThanOrEqual(ICON_SM);
  });
});

describe("the StyleSheets carry the constants the docblock quotes", () => {
  it("pins the chip's line, padding and border", () => {
    const chip = StyleSheet.flatten(documentChromeStyles.bandChip);
    expect(chip.top).toBe(BAND_CHIP_TOP);
    expect(chip.paddingVertical).toBe(BAND_CHIP_PAD_V);
    expect(chip.borderWidth).toBe(BAND_CHIP_BORDER);
  });

  it("pins the band's own height and the face section's padding", () => {
    expect(StyleSheet.flatten(documentChromeStyles.band).height).toBe(BAND_H);
    expect(StyleSheet.flatten(documentChromeStyles.sec).paddingVertical).toBe(FACE_SECTION_PAD_V);
  });

  it("pins BOTH identity frames to the same rise", () => {
    // The photo and the QR mirror each other on purpose — that pairing is what
    // the band budget above assumes. The QR's rise lives in `qrFrameInRow`
    // because only the flanking arm has a band above it to rise into.
    expect(StyleSheet.flatten(ownerFaceStyles.photo).marginTop).toBe(-IDENTITY_POKE_OUT);
    expect(StyleSheet.flatten(ownerFaceStyles.qrFrameInRow).marginTop).toBe(-IDENTITY_POKE_OUT);
    // …and the bare frame does NOT carry it, or the standalone arm would rise
    // over the identity refusal it sits under.
    const bareFrame: ViewStyle = StyleSheet.flatten(ownerFaceStyles.qrFrame);
    expect(bareFrame.marginTop).toBeUndefined();
  });
});

// The flip control's own square is pinned where it is RENDERED
// (PetDocumentScreen.test.tsx), not here: what matters about it is that the
// style reaches the control, which a StyleSheet read cannot see.

// ---------------------------------------------------------------------------
// A-2 (2026-09-24, M7 accessibility pass, PO decision 17A / "membrete").
// ---------------------------------------------------------------------------
//
// EVERYTHING ABOVE THIS LINE IS ARITHMETIC AT THE UNSCALED FONT. That was the
// exact gap the PO's report exposed: the title and the chip both carry
// `maxFontSizeMultiplier={BAND_MAX_FONT_SCALE}` and DO grow, up to that cap,
// with the reader's system font size — the layout budget above never asked
// what happens at the cap itself. jest still has no Yoga (see the file
// header), so this cannot render a wrapped title either; what it CAN do is
// the same thing the rest of this file does — recompute the two quantities
// that actually move with scale (the title's line height, and the chip's
// tallest child) from IBM Plex Mono's own stated metrics, and assert the
// budget holds at the reader's EFFECTIVE scale, capped exactly where the
// component itself caps it.
const TITLE_TOP = 16;
const TITLE_MARGIN_TO_SUBTITLE = 3;
const TITLE_FONT_SIZE = 10;
const SUBTITLE_FONT_SIZE = 8;
const CHIP_TEXT_FONT_SIZE = 10;
/** IBM Plex Mono's shipped line-height coefficient — the same 1.3 every other
 *  derivation in this file and `BAND_H`'s own docblock uses. */
const LINE_HEIGHT_EM = 1.3;

function scaledLineHeight(fontSize: number, systemFontScale: number): number {
  const effectiveScale = Math.min(systemFontScale, BAND_MAX_FONT_SCALE);
  return Math.ceil(LINE_HEIGHT_EM * fontSize * effectiveScale);
}

/** Where the title block's last line (the subtitle) ends, at this system
 *  font scale — the quantity `BAND_CHIP_TOP` has to clear. */
function titleBottomAt(systemFontScale: number): number {
  const titleLine = scaledLineHeight(TITLE_FONT_SIZE, systemFontScale);
  const subtitleLine = scaledLineHeight(SUBTITLE_FONT_SIZE, systemFontScale);
  return TITLE_TOP + 2 * titleLine + TITLE_MARGIN_TO_SUBTITLE + subtitleLine;
}

/** The chip's bottom edge at this system font scale — the icon is the
 *  tallest child only below the cap; the chip's OWN capped text overtakes it
 *  once scaled, which the unscaled arithmetic above cannot see. */
function chipBottomAt(systemFontScale: number): number {
  const tallestChild = Math.max(ICON_SM, scaledLineHeight(CHIP_TEXT_FONT_SIZE, systemFontScale));
  return BAND_CHIP_TOP + 2 * BAND_CHIP_BORDER + 2 * BAND_CHIP_PAD_V + tallestChild;
}

describe("A-2: the title and the chip do not collide at any system font scale", () => {
  // 1.0 (no scaling), 1.3 (exactly the cap), 2.0 (past the cap — must render
  // IDENTICALLY to 1.3, since BAND_MAX_FONT_SCALE clamps both nodes there).
  // The PO's report was specifically about 1.3; 2.0 is in the task because a
  // clamp that were ever implemented per-node instead of via one shared
  // constant could still diverge between the title and the chip above it.
  const SCALES = [1.0, 1.3, 2.0];

  for (const scale of SCALES) {
    // jest's `expect` takes no assertion-message argument (unlike vitest's) —
    // the `it` title carries the scale, a red here means the title overran
    // the chip's own line at that scale.
    it(`title ends before the chip begins, at system font scale ${scale}`, () => {
      expect(BAND_CHIP_TOP).toBeGreaterThanOrEqual(titleBottomAt(scale));
    });

    it(`the chip still clears the frames rising into the band, at system font scale ${scale}`, () => {
      expect(frameTop - chipBottomAt(scale)).toBeGreaterThanOrEqual(MIN_CLEARANCE);
    });
  }

  it("1.3 and 2.0 land on the identical budget — the cap is doing the clamping, not luck", () => {
    expect(titleBottomAt(1.3)).toBe(titleBottomAt(2.0));
    expect(chipBottomAt(1.3)).toBe(chipBottomAt(2.0));
  });

  it("non-vacuity: scaling past the cap actually changes the numbers versus unscaled", () => {
    // If this ever equalled titleBottomAt(1.0), either BAND_MAX_FONT_SCALE
    // broke or this helper stopped reading it — either way the assertions
    // above would be checking the same budget three times over, not three
    // different scales.
    expect(titleBottomAt(1.3)).toBeGreaterThan(titleBottomAt(1.0));
    expect(chipBottomAt(1.3)).toBeGreaterThan(chipBottomAt(1.0));
  });
});

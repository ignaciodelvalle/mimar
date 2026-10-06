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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
  type FaceWatermarkGeometry,
  IDENTITY_POKE_OUT,
  PAPER_MAX_STRETCH,
  documentChromeStyles,
  faceWatermarkGeometry,
} from "./DocumentChromeNative";
import { ownerFaceStyles } from "./OwnerFace";
import { ESCARAPELA, PAPER, PHOTO_MOUNT } from "./chrome-visual";

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

  it("gives the photo mount no elevation of its own — the card lift is the one light layer", () => {
    // A second Android elevation nested inside the rotating card is a second
    // shadow layer the J7 repaints every frame of the turn.
    expect(PHOTO_MOUNT).not.toHaveProperty("elevation");
    // Source-read, not the flattened style: jest-expo resolves Platform.select
    // to its iOS arm, so an `android: { elevation }` arm would never show up
    // in `StyleSheet.flatten` here (same posture as HeaderBackButton.test.tsx).
    const source = readFileSync(join(__dirname, "OwnerFace.tsx"), "utf8").replace(
      /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
      "",
    );
    const mount = /photoMount:\s*\{([\s\S]*?)\n {2}\},/.exec(source)?.[1];
    expect(mount).toBeDefined();
    expect(mount).toContain("PHOTO_MOUNT.size");
    expect(mount).not.toMatch(/elevation/);
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

// ---------------------------------------------------------------------------
// Paper grain + escarapela (PO 2026-10-06: both textures come back).
// ---------------------------------------------------------------------------
//
// On Android a %-height absolute Image of the escarapela grew the card to ~window
// height (mimar AVD, 2026-10-05). The cure is that every watermark number is
// computed here, from the measured face box, and no % string reaches a style.

describe("the watermark knobs are the ones the device pass tuned", () => {
  it("keeps the paper and escarapela values from the original recipe", () => {
    expect(PAPER).toEqual({ opacity: 0.55 });
    expect(ESCARAPELA).toEqual({ opacity: 0.28, topPct: 18, heightPct: 70 });
  });

  it("ships both rasters in the bundle", () => {
    for (const name of ["landing-passport-paper.png", "landing-escarapela.png"]) {
      expect(existsSync(join(__dirname, "..", "..", "assets", name))).toBe(true);
    }
  });
});

/** Where each grain tile actually PAINTS: scaleY pivots on the square's centre. */
function paintedSpans(paper: FaceWatermarkGeometry["paper"]): Array<[number, number]> {
  return paper.tiles.map((tile) => {
    const centre = tile.top + paper.side / 2;
    const half = (paper.side * tile.scaleY) / 2;
    return [centre - half, centre + half];
  });
}

/** The tiles leave no gap and no overlap, and cover 0 … at least `height`. */
function expectGrainCovers(paper: FaceWatermarkGeometry["paper"], height: number) {
  const spans = paintedSpans(paper);
  expect(spans[0]?.[0]).toBeCloseTo(0, 5);
  for (let i = 1; i < spans.length; i++) {
    expect(spans[i]?.[0]).toBeCloseTo(spans[i - 1]?.[1] ?? Number.NaN, 5);
    // Whole-dp seams: neighbouring tiles meet on a pixel edge.
    expect(Math.abs((spans[i]?.[0] ?? 0) - Math.round(spans[i]?.[0] ?? 0))).toBeLessThan(1e-6);
  }
  expect(spans.at(-1)?.[1]).toBeGreaterThanOrEqual(height + 1);
}

describe("faceWatermarkGeometry — plain numbers from the measured box", () => {
  it("stretches the grain over a phone-sized face in at most 2× tiles", () => {
    const { paper } = faceWatermarkGeometry(360, 800);
    expect(paper.side).toBe(361);
    expect(paper.tiles).toHaveLength(2);
    for (const tile of paper.tiles) expect(tile.scaleY).toBeLessThanOrEqual(PAPER_MAX_STRETCH);
    expectGrainCovers(paper, 800);
  });

  it("stacks tiles on a 2400dp libreta instead of stretching one 6× into streaks", () => {
    const { paper } = faceWatermarkGeometry(343, 2400);
    expect(paper.tiles.length).toBe(4);
    for (const tile of paper.tiles) {
      expect(tile.scaleY).toBeGreaterThan(0);
      expect(tile.scaleY).toBeLessThanOrEqual(PAPER_MAX_STRETCH);
    }
    expectGrainCovers(paper, 2400);
  });

  it("overshoots a fractional box on the right and bottom — no un-grained hairline", () => {
    for (const [width, height] of [
      [342.6, 799.4],
      [343.5, 640.5],
      [359.01, 2400.99],
    ] as const) {
      const { paper } = faceWatermarkGeometry(width, height);
      expect(paper.side).toBeGreaterThanOrEqual(width + 1);
      expectGrainCovers(paper, height);
    }
  });

  it("centres a full-width escarapela square in the 18%…88% box", () => {
    expect(faceWatermarkGeometry(360, 800).escarapela).toEqual({ left: 0, top: 244, size: 360 });
  });

  it("bounds the escarapela by the box on a short face instead of growing past it", () => {
    const { escarapela } = faceWatermarkGeometry(360, 300);
    expect(escarapela.size).toBe(210);
    expect(escarapela.left).toBe(75);
    expect(escarapela.top).toBe(54);
    expect(escarapela.top + escarapela.size).toBeLessThanOrEqual(300);
  });

  it("asks for the same bitmap on both faces — the turn changes height, not width", () => {
    const front = faceWatermarkGeometry(343, 900);
    const back = faceWatermarkGeometry(343, 640);
    expect(back.paper.side).toBe(front.paper.side);
    expect(back.escarapela.size).toBe(front.escarapela.size);
  });

  it("returns only finite numbers", () => {
    const g = faceWatermarkGeometry(343, 761);
    const tileNumbers = g.paper.tiles.flatMap((tile) => [tile.top, tile.scaleY]);
    for (const value of [g.paper.side, ...tileNumbers, ...Object.values(g.escarapela)]) {
      expect(typeof value).toBe("number");
      expect(Number.isFinite(value)).toBe(true);
    }
  });
});

describe("the watermark layer cannot size the face", () => {
  it("is an absoluteFill layer under everything, with no size of its own", () => {
    const layer = StyleSheet.flatten(documentChromeStyles.watermarkLayer);
    expect(layer).toMatchObject({ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 });
    expect(layer.zIndex).toBe(0);
    for (const key of ["width", "height", "minHeight", "aspectRatio", "flex"]) {
      expect(layer).not.toHaveProperty(key);
    }
  });

  it("gives the Images a position and nothing else — their box is numeric, per render", () => {
    expect(StyleSheet.flatten(documentChromeStyles.watermarkImage)).toEqual({
      position: "absolute",
    });
  });

  it("uses absoluteFill, which exists in RN 0.86 (absoluteFillObject does not)", () => {
    const source = readFileSync(join(__dirname, "DocumentChromeNative.tsx"), "utf8").replace(
      /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
      "",
    );
    expect(source).not.toContain("absoluteFillObject");
    expect(source).toContain("StyleSheet.absoluteFill");
  });
});

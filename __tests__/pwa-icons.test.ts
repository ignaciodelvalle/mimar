// The WEB's three PWA icons, held to the same mark the phone ships.
//
// WHY THIS FILE EXISTS
// ---------------------------------------------------------------------------
// Until 2026-09-04 the web and the phone shipped DIFFERENT MARKS and nothing in
// the repo compared them. `public/icons/icon-{192,512,512-maskable}.png` were
// hand-generated once from the retired fingerprint scan, no script produced
// them, and no test measured them; `apps/mobile/assets/*` had already moved to
// the chamfered plaque. A user who installed the web app and then the phone app
// got two different pictures of the same product, and the only instrument that
// would ever have reported it was somebody's eyes.
//
// `scripts/build-mobile-app-icons.ts` now emits all seven images from the one
// SVG, and this file is the fence that keeps the web's three descended from it.
// The assertions come in three layers, and each catches something the others
// cannot:
//
//   · SHAPE OF THE FILE — exact dimensions, no alpha channel, paper corner.
//     Catches a hand-made replacement dropped in under the same name.
//   · GEOMETRY OF THE INK — ratio, centring, and the circular-mask radius.
//     Catches a regenerated file whose recipe drifted.
//   · ONE MARK — the web's 512 icon and the phone's 1024 icon are the same
//     composition at two sizes. This is the assertion the other two cannot
//     make, and the one that was missing while the two clients disagreed.
//
// The constants are IMPORTED from the generator rather than restated, because a
// restated ratio is two numbers agreeing with each other. What is NOT imported
// is any measurement: every number below is read off the PNG bytes.

import { readFileSync } from "node:fs";
import path from "node:path";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  BRAND_BLUE,
  PAPER,
  RATIO_LAUNCHER,
  RATIO_MASKABLE,
} from "@/scripts/build-mobile-app-icons";

const ROOT = process.cwd();

const WEB_ICONS = {
  small: "public/icons/icon-192.png",
  large: "public/icons/icon-512.png",
  maskable: "public/icons/icon-512-maskable.png",
} as const;

/** The phone's launcher icon — the same composition at 1024. */
const PHONE_ICON = "apps/mobile/assets/icon.png";

/**
 * Google's content keyline for an adaptive icon, as a fraction of the layer.
 *
 * TWO CIRCLES, NOT ONE, and this is the tighter of them. Android GUARANTEES
 * that the centre 72dp of a 108dp layer survives every OEM mask (radius
 * 36/108 = 0.333); it RECOMMENDS keeping content inside a 66dp keyline
 * (radius 33/108 = 0.3056). The same pair is asserted on the phone's adaptive
 * foreground in apps/mobile/src/release/release-config.test.ts; a maskable web
 * icon is cropped by the browser to a shape it does not announce in advance,
 * so it answers to the same geometry.
 */
const CONTENT_KEYLINE_RADIUS = 33 / 108;

/** How far an RGB triple sits from a reference colour, in the worst channel. */
function channelDistance(
  pixel: readonly [number, number, number],
  reference: { readonly r: number; readonly g: number; readonly b: number },
): number {
  return Math.max(
    Math.abs(pixel[0] - reference.r),
    Math.abs(pixel[1] - reference.g),
    Math.abs(pixel[2] - reference.b),
  );
}

function hex(pixel: readonly [number, number, number]): string {
  return `#${pixel.map((value) => value.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

type Measured = {
  readonly width: number;
  readonly height: number;
  readonly hasAlpha: boolean;
  readonly topLeft: string;
  readonly centre: readonly [number, number, number];
  /** Bounding box of every pixel that is not the paper ground. */
  readonly ink: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
    /** Distance from the CANVAS centre to the farthest inked pixel, in px. */
    readonly maxRadius: number;
    /**
     * The most common colour among the inked pixels, and its share of them.
     *
     * THIS, AND NOT THE CENTRE PIXEL, IS HOW THE MARK'S COLOUR IS ASSERTED.
     * The plaque is one flat `currentColor` fill, so its interior reproduces
     * EXACTLY through any downscale and the mode is `#0E5A99` on the nose in
     * every output. A single sampled pixel does not survive the same trip:
     * measured on the geometric centre of these files, the phone's 1024 icon
     * reads (14,90,153) and the web's 512 reads (15,90,153), because the
     * centre of the viewBox lands two or three pixels under the paw pad's top
     * edge and lanczos3 rings across it differently at each scale factor. An
     * equality on that pixel would be a fence that fails when the RESAMPLER
     * moves, not when the MARK does.
     */
    readonly dominant: string;
    readonly dominantShare: number;
  };
};

/**
 * Measure an OPAQUE icon: the ink is everything that is not the paper ground.
 *
 * WHY NOT AN ALPHA TRIM. All four files this reads are opaque by requirement —
 * the App Store rejects an alpha channel on an icon, and a maskable PWA icon
 * has no second layer to supply a ground — so every pixel carries alpha 255 (or
 * no alpha channel at all) and an alpha-based bounding box would return the
 * whole canvas on a correct file. Presence is measured by COLOUR DISTANCE from
 * `#FBFAF5` instead. The plaque is brand blue on cream, so real ink sits far
 * past the threshold and only the resampler's anti-aliased fringe sits near it.
 *
 * WHY sharp AND NOT A HAND-ROLLED DECODER, when release-config.test.ts hand-
 * rolls one for the same job: sharp is already a `dependencies` entry of THIS
 * package (the web app uses it at runtime), so there is nothing to add. The
 * mobile package is the one that would have to pull a native image library into
 * a React Native test graph, which is why it decodes PNG by hand and this does
 * not. Same measurement, different cost on each side.
 */
async function measure(relative: string): Promise<Measured> {
  const absolute = path.join(ROOT, relative);
  const meta = await sharp(absolute).metadata();
  const { data, info } = await sharp(absolute).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  const at = (x: number, y: number): [number, number, number] => {
    const i = (y * width + x) * channels;
    return [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0];
  };

  return {
    width,
    height,
    hasAlpha: meta.hasAlpha === true,
    topLeft: hex(at(0, 0)),
    centre: at(Math.floor(width / 2), Math.floor(height / 2)),
    ink: scanInk(at, width, height, relative),
  };
}

/**
 * ONE walk over the pixels, producing every ink statistic this file asserts on.
 *
 * Split out of measure() rather than inlined because the two do different jobs:
 * measure() decodes a file, this reasons about a picture. Extremes are written
 * as Math.min/Math.max rather than as five nested `if`s for the same reason the
 * mobile package's inkBounds() is — a comparison two loops deep is charged for
 * its depth by biome's cognitive-complexity rule, and "extremes" is what this
 * means anyway.
 */
function scanInk(
  at: (x: number, y: number) => [number, number, number],
  width: number,
  height: number,
  label: string,
): Measured["ink"] {
  // Threshold 24/255: comfortably past anti-aliasing, far short of the
  // blue-on-cream contrast the mark actually carries.
  const THRESHOLD = 24;
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const box = { left: width, right: -1, top: height, bottom: -1, maxRadiusSq: 0 };
  const histogram = new Map<string, number>();
  let inked = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = at(x, y);
      if (channelDistance(pixel, PAPER) <= THRESHOLD) continue;
      box.left = Math.min(box.left, x);
      box.right = Math.max(box.right, x);
      box.top = Math.min(box.top, y);
      box.bottom = Math.max(box.bottom, y);
      box.maxRadiusSq = Math.max(box.maxRadiusSq, (x - cx) ** 2 + (y - cy) ** 2);
      const key = hex(pixel);
      histogram.set(key, (histogram.get(key) ?? 0) + 1);
      inked += 1;
    }
  }

  if (box.right < 0) throw new Error(`${label}: no pixel differs from the paper ground — no ink`);

  const [dominant, dominantCount] = [...histogram.entries()].reduce((best, entry) =>
    entry[1] > best[1] ? entry : best,
  );

  return {
    left: box.left,
    top: box.top,
    width: box.right - box.left + 1,
    height: box.bottom - box.top + 1,
    maxRadius: Math.sqrt(box.maxRadiusSq),
    dominant,
    dominantShare: dominantCount / inked,
  };
}

const PAPER_HEX = hex([PAPER.r, PAPER.g, PAPER.b]);

describe("PWA icons — the shape of the files", () => {
  it.each([
    [WEB_ICONS.small, 192],
    [WEB_ICONS.large, 512],
    [WEB_ICONS.maskable, 512],
  ])("ships %s at exactly %ix%i, opaque, on paper", async (relative, side) => {
    const icon = await measure(relative);
    expect({ width: icon.width, height: icon.height }).toEqual({ width: side, height: side });

    // NO ALPHA CHANNEL, asserted the same way the phone's icon.png is: what
    // matters is whether the file DECLARES one, not whether every pixel in it
    // happens to be opaque. A maskable icon has no background layer behind it,
    // so a transparent knockout would be cropped over whatever the browser
    // felt like — usually white, sometimes the OS accent.
    expect(icon.hasAlpha).toBe(false);

    // The corner is the paper ground, which is also what makes the ink
    // measurement below mean anything: the bounding box is "everything that is
    // not this colour".
    expect(icon.topLeft).toBe(PAPER_HEX);
  });
});

describe("PWA icons — the geometry of the ink", () => {
  it("sizes the plaque at the launcher ratio and centres it", async () => {
    const icon = await measure(WEB_ICONS.large);

    // RATIO_LAUNCHER is IMPORTED from the generator, and the measurement is
    // read off the pixels — so this compares a decision against a file, not two
    // copies of the same number. Two digits: 0.68 admits a rounding pixel on
    // either edge and nothing more.
    expect(icon.ink.width / icon.width).toBeCloseTo(RATIO_LAUNCHER, 2);

    // Non-vacuity. Without it a blank cream square with one stray dark pixel in
    // the corner satisfies far too much of this file.
    expect(icon.ink.width / icon.width).toBeGreaterThan(0.4);

    // Centred, within a pixel. The generator composites with `gravity: centre`
    // on an even canvas, so an odd ink width lands one pixel off on one side
    // and that is the whole budget.
    expect(
      Math.abs(icon.ink.left - (icon.width - (icon.ink.left + icon.ink.width))),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(icon.ink.top - (icon.height - (icon.ink.top + icon.ink.height))),
    ).toBeLessThanOrEqual(1);
  });

  it("sizes the 192 icon at the same launcher ratio", async () => {
    const icon = await measure(WEB_ICONS.small);
    expect(icon.ink.width / icon.width).toBeCloseTo(RATIO_LAUNCHER, 2);
    expect(icon.ink.width / icon.width).toBeGreaterThan(0.4);
    expect(
      Math.abs(icon.ink.left - (icon.width - (icon.ink.left + icon.ink.width))),
    ).toBeLessThanOrEqual(1);
  });

  it("keeps the maskable icon inside the circle a browser may crop it to", async () => {
    const icon = await measure(WEB_ICONS.maskable);
    expect(icon.ink.width / icon.width).toBeCloseTo(RATIO_MASKABLE, 2);
    expect(icon.ink.width / icon.width).toBeGreaterThan(0.4);

    // THE ASSERTION A BOUNDING BOX CANNOT MAKE. A mask is a closed curve, so
    // what has to fit is a RADIUS: no inked pixel farther than 0.3056 × the
    // canvas from its centre. A box comfortably inside the keyline on both axes
    // can still poke out of the circle at its own corners — the retired
    // fingerprint mark's ink box was 294x215 of 512, comfortably inside the
    // keyline on both axes, with a box half-diagonal reaching a diameter of
    // 0.71. Measured with this file's own predicate, that mark's ink never
    // crossed the circle (max radius 0.2954 of the canvas, inside the 0.3056
    // keyline) — no test existed before this file to have passed or failed on
    // it either way.
    expect(icon.ink.maxRadius / icon.width).toBeLessThan(CONTENT_KEYLINE_RADIUS);

    // Non-vacuity for the radius too: a centred dot satisfies the line above.
    expect(icon.ink.maxRadius / icon.width).toBeGreaterThan(0.25);
  });
});

describe("PWA icons — one mark, two clients", () => {
  it("draws the web's 512 icon and the phone's 1024 icon from the same composition", async () => {
    const web = await measure(WEB_ICONS.large);
    const phone = await measure(PHONE_ICON);

    // SAME COLOUR, measured as the dominant inked colour rather than as one
    // sampled pixel — see the `dominant` doc on Measured for why the centre
    // pixel is the wrong instrument here. The plaque is one flat
    // `currentColor` fill at `#0E5A99`, so its interior survives any downscale
    // byte-for-byte, and this is what catches a recoloured or re-drawn mark on
    // one side only — the failure that shipped for months while the web served
    // the fingerprint and the phone the plaque.
    expect(web.ink.dominant).toBe(BRAND_BLUE);
    expect(phone.ink.dominant).toBe(BRAND_BLUE);

    // Non-vacuity for the mode: a file whose ink is a smear of near-blues has a
    // "most common colour" too, and it would be some arbitrary fringe value
    // holding a 2% plurality. Measured on these files: 0.885 (web 512) and
    // 0.942 (phone 1024) — the floor sits far enough below that resampling
    // cannot trip it and far enough above a plurality to mean "flat fill".
    expect(web.ink.dominantShare).toBeGreaterThan(0.6);
    expect(phone.ink.dominantShare).toBeGreaterThan(0.6);

    // And the CENTRE is ink rather than paper, which is what makes "the plaque
    // is a filled positive, not an outline" observable. Compared between the
    // two files with a tolerance rather than for equality, because the centre
    // of the viewBox sits on the paw pad's anti-aliased top edge: measured
    // (14,90,153) on the phone and (15,90,153) on the web.
    expect(channelDistance(web.centre, PAPER)).toBeGreaterThan(24);
    expect(channelDistance(phone.centre, PAPER)).toBeGreaterThan(24);
    expect(
      channelDistance(web.centre, { r: phone.centre[0], g: phone.centre[1], b: phone.centre[2] }),
    ).toBeLessThanOrEqual(4);

    // Same aspect: the plaque is square, so both inks are 1:1 and equal to each
    // other. A second, differently-drawn mark under the same filename is what
    // this sees and the dimension checks cannot.
    const webAspect = web.ink.width / web.ink.height;
    const phoneAspect = phone.ink.width / phone.ink.height;
    expect(webAspect).toBeCloseTo(1, 1);
    expect(phoneAspect).toBeCloseTo(1, 1);
    expect(webAspect).toBeCloseTo(phoneAspect, 2);

    // Same composition: scale the web icon's ink up to the phone's canvas and
    // the two ink widths coincide. Both are RATIO_LAUNCHER of their own canvas,
    // so this is the ratio identity restated where a drift on either side is
    // visible as pixels. Four pixels of budget covers the two independent
    // roundings (696 vs 348 × 2) and nothing larger.
    const webScaledToPhone = (web.ink.width * phone.width) / web.width;
    expect(Math.abs(webScaledToPhone - phone.ink.width)).toBeLessThanOrEqual(4);
  });
});

describe("PWA icons — the routes that serve them", () => {
  /** Every `/icons/*.png` path a source file names, in order of appearance. */
  function iconPathsIn(relative: string): string[] {
    const source = readFileSync(path.join(ROOT, relative), "utf8");
    return [...source.matchAll(/\/icons\/[A-Za-z0-9._-]+\.png/g)].map((match) => match[0]);
  }

  const DECLARED = ["/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-512-maskable.png"];

  it("declares exactly the three generated icons in app/manifest.ts", () => {
    // The manifest is the installable app's icon set. A file renamed in
    // build-mobile-app-icons.ts and not here produces a manifest pointing at a
    // 404 — which no browser reports and no build step notices, because a PWA
    // with a broken icon still installs, with a letter in a circle.
    const declared = iconPathsIn("app/manifest.ts");
    expect([...declared].sort()).toEqual([...DECLARED].sort());
  });

  it("points app/layout.tsx's icon and apple-touch-icon at a generated file", () => {
    // layout.tsx names ONE of the three (the 192), twice — as `icon` and as
    // `apple`. Asserted as "every path it names is one of the three, and it
    // names at least one" rather than as an exact list, so adding an
    // apple-touch-icon at another generated size stays a one-line change while
    // a path to a file this script does not write still fails.
    const referenced = iconPathsIn("app/layout.tsx");
    expect(referenced.length).toBeGreaterThan(0);
    for (const reference of referenced) {
      expect(DECLARED).toContain(reference);
    }
  });

  it("points the service worker's push notification icon and badge at a generated file", () => {
    // public/sw.js names the 192 twice more — as the push notification's
    // `icon` and its `badge`, each with a `?v=` cache-busting query the regex
    // stops at before the extension check, same as the two tests above. A
    // rename here ships a push notification with a broken icon: the
    // notification still shows, just blank.
    const referenced = iconPathsIn("public/sw.js");
    expect(referenced.length).toBeGreaterThan(0);
    for (const reference of referenced) {
      expect(DECLARED).toContain(reference);
    }
  });
});

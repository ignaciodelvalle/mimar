/**
 * Perceptual color distance (CIEDE2000) for the visualization tokens.
 *
 * WHY THIS EXISTS: the choropleth honesty invariants used to be asserted as
 * string inequality — `expect(COLOR_NO_DATA).not.toBe(SCALE_BLUE_SEQ[0])`.
 * That passes for `#e7eaed` vs `#eff3ff`, two fills a reader cannot tell apart
 * (ΔE00 4.62). A test that pins "these hex strings differ" does not pin what
 * the map promises, which is "these STATES are distinguishable". Distance has
 * to be computed, so it lives here and the tests assert against it.
 *
 * ΔE00 reference points on the operator canvas:
 *  - < 2   — indistinguishable side by side
 *  - 2–5   — visible only on a shared edge, unreliable across a map
 *  - ≥ 8   — reliably distinct for large flat areas (the floor this repo uses)
 *
 * sRGB → XYZ (D65) → CIELAB → ΔE00, per Sharma, Wu & Dalal (2005).
 */

/** Parsed `#rrggbb` into 0..1 channels. Throws on anything else. */
function parseHex(hex: string): [number, number, number] {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) throw new Error(`bad hex: ${hex}`);
  const n = Number.parseInt(m[1], 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

/** sRGB companding — the same curve WCAG uses for relative luminance. */
function linearize(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance (0..1) of an `#rrggbb` color. */
export function relLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map(linearize);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two `#rrggbb` colors (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** CIELAB (D65/2°) coordinates of an `#rrggbb` color. */
function toLab(hex: string): [number, number, number] {
  const [r, g, b] = parseHex(hex).map(linearize);
  const x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const z = r * 0.0193339 + g * 0.119192 + b * 0.9503041;
  // D65 white point
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const fx = f(x / 0.95047);
  const fy = f(y / 1.0);
  const fz = f(z / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

/**
 * CIEDE2000 color difference between two `#rrggbb` colors.
 *
 * Preferred over the naive CIE76 Euclidean distance because the blue-region
 * and near-neutral corrections are exactly where this repo's tokens live: the
 * land canvas, the no-data grey and the palest data class are all near-white,
 * and CIE76 badly overstates their separation.
 */
export function deltaE00(hexA: string, hexB: string): number {
  const [l1, a1, b1] = toLab(hexA);
  const [l2, a2, b2] = toLab(hexB);

  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const cBar = (c1 + c2) / 2;
  // Chroma-dependent a* scaling — pulls near-neutral colors off the a* axis so
  // grey-vs-grey differences are not overstated.
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
  const ap1 = (1 + g) * a1;
  const ap2 = (1 + g) * a2;
  const cp1 = Math.hypot(ap1, b1);
  const cp2 = Math.hypot(ap2, b2);

  const hue = (b: number, ap: number) => {
    if (b === 0 && ap === 0) return 0;
    const h = Math.atan2(b, ap) * DEG;
    return h >= 0 ? h : h + 360;
  };
  const hp1 = hue(b1, ap1);
  const hp2 = hue(b2, ap2);

  const dLp = l2 - l1;
  const dCp = cp2 - cp1;
  let dhp = 0;
  if (cp1 * cp2 !== 0) {
    dhp = hp2 - hp1;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(cp1 * cp2) * Math.sin((dhp / 2) * RAD);

  const lBar = (l1 + l2) / 2;
  const cBarP = (cp1 + cp2) / 2;
  let hBarP = hp1 + hp2;
  if (cp1 * cp2 !== 0) {
    if (Math.abs(hp1 - hp2) > 180) hBarP += hp1 + hp2 < 360 ? 360 : -360;
    hBarP /= 2;
  }

  const t =
    1 -
    0.17 * Math.cos((hBarP - 30) * RAD) +
    0.24 * Math.cos(2 * hBarP * RAD) +
    0.32 * Math.cos((3 * hBarP + 6) * RAD) -
    0.2 * Math.cos((4 * hBarP - 63) * RAD);

  const sL = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2);
  const sC = 1 + 0.045 * cBarP;
  const sH = 1 + 0.015 * cBarP * t;

  // Blue-region hue rotation (the term that matters for this palette).
  const dTheta = 30 * Math.exp(-(((hBarP - 275) / 25) ** 2));
  const rC = 2 * Math.sqrt(cBarP ** 7 / (cBarP ** 7 + 25 ** 7));
  const rT = -Math.sin(2 * dTheta * RAD) * rC;

  return Math.sqrt(
    (dLp / sL) ** 2 + (dCp / sC) ** 2 + (dHp / sH) ** 2 + rT * (dCp / sC) * (dHp / sH),
  );
}

/**
 * The ΔE00 floor two large flat map fills must clear to count as different
 * STATES to a reader (data vs no-data vs suppressed vs bare land).
 *
 * 8 is the working threshold for big adjacent areas — well above the ~2.3
 * "just noticeable difference", because a choropleth reader compares fills
 * across the map, not along a shared edge.
 */
export const MAP_FILL_DISTINCT_FLOOR = 8;

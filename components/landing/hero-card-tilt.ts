// Pointer-tilt and parallax math for the landing hero's "credencial viva" card.
//
// Pure on purpose: the component only records the pointer and paints, so the
// rules that must never drift — the HARD cap on how far the card leans and how
// far its inner layers may slide — live here where a unit test can pin them
// without a browser.

/** The furthest the card may lean toward the pointer, in degrees, on ANY axis
 *  combination. Corners are capped too: without the radial clamp below, a
 *  pointer in a corner would lean the card max * sqrt(2).
 *
 *  1.5° (PO 2026-10-02, v2): the card itself barely moves; the depth comes from
 *  the layers INSIDE it sliding at different rates (see heroParallax). v1 used
 *  10°, which read as the whole card swinging rather than a held object. */
export const HERO_TILT_MAX_DEG = 1.5;

/** Exponential smoothing time constant for the tilt, in milliseconds. A touch
 *  slower than a raw follow so the card answers the hand with some weight,
 *  without lag and without the jitter of a 1:1 map. */
export const HERO_TILT_SMOOTHING_MS = 120;

/** How far the pet photo slides inside its window at full lean, in px. It sits
 *  ABOVE the card's surface, so it moves TOWARD the pointer. */
export const HERO_PARALLAX_PHOTO_PX = 3;

/** How far the security hatch slides at full lean, in px. It sits UNDER the
 *  surface, so it moves AWAY from the pointer, at half the photo's rate. */
export const HERO_PARALLAX_PATTERN_PX = 1.5;

export type HeroTilt = {
  /** rotateX in degrees (CSS): positive brings the BOTTOM edge toward the viewer. */
  rx: number;
  /** rotateY in degrees (CSS): positive sends the RIGHT edge away from the viewer. */
  ry: number;
};

export type HeroOffset = { x: number; y: number };

export type HeroParallax = {
  /** Photo offset in px (toward the pointer). */
  photo: HeroOffset;
  /** Security-hatch offset in px (away from the pointer). */
  pattern: HeroOffset;
};

function clampUnit(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(-1, n));
}

/**
 * The tilt that turns the card's face TOWARD a pointer at (x, y), measured from
 * the top-left of a box of the given size: the card "looks at" the pointer, so
 * the edge under it recedes, the way a held card gives under a fingertip.
 *
 * Linear in the pointer position — no easing toward the edges and no snap
 * zones, so the card never "grabs" the cursor — and clamped twice: each axis
 * to [-1, 1] (a pointer outside the box cannot over-rotate) and the combined
 * lean to `max` degrees (a corner leans exactly as far as an edge midpoint).
 */
export function tiltTowardPointer(
  x: number,
  y: number,
  width: number,
  height: number,
  max: number = HERO_TILT_MAX_DEG,
): HeroTilt {
  if (!(width > 0) || !(height > 0)) return { rx: 0, ry: 0 };
  const nx = clampUnit((x / width) * 2 - 1);
  const ny = clampUnit((y / height) * 2 - 1);
  // Pointer on the right → the right edge recedes: a POSITIVE rotateY.
  // Pointer at the bottom → the bottom edge recedes: a NEGATIVE rotateX.
  let ry = nx * max;
  let rx = -ny * max;
  const magnitude = Math.hypot(rx, ry);
  if (magnitude > max) {
    const k = max / magnitude;
    rx *= k;
    ry *= k;
  }
  // Normalise -0 so callers (and tests) never see a signed zero.
  return { rx: rx + 0, ry: ry + 0 };
}

/**
 * One frame of exponential smoothing from `current` toward `target`, given the
 * frame's elapsed time. Frame-rate independent: two 8ms frames move exactly as
 * far as one 16ms frame.
 */
export function smoothTilt(
  current: HeroTilt,
  target: HeroTilt,
  dtMs: number,
  tauMs: number = HERO_TILT_SMOOTHING_MS,
): HeroTilt {
  const alpha = 1 - Math.exp(-Math.max(0, dtMs) / tauMs);
  return {
    rx: current.rx + (target.rx - current.rx) * alpha,
    ry: current.ry + (target.ry - current.ry) * alpha,
  };
}

/**
 * The inner layers' offsets for a given (smoothed) tilt — the parallax stack.
 *
 * Derived from the tilt rather than from the pointer, so the layers ride the
 * SAME smoothed value the card does and settle with it: one motion seen at
 * three depths, never three motions. The lean is normalised by `max` and
 * clamped to the unit disc, so no layer can slide further than its own
 * constant, whatever tilt it is handed.
 */
export function heroParallax(tilt: HeroTilt, max: number = HERO_TILT_MAX_DEG): HeroParallax {
  if (!(max > 0)) return { photo: { x: 0, y: 0 }, pattern: { x: 0, y: 0 } };
  // Back to the pointer's direction: +ry means the pointer is right (+x);
  // -rx means it is below (+y).
  let nx = Number.isFinite(tilt.ry) ? tilt.ry / max : 0;
  let ny = Number.isFinite(tilt.rx) ? -tilt.rx / max : 0;
  const magnitude = Math.hypot(nx, ny);
  if (magnitude > 1) {
    nx /= magnitude;
    ny /= magnitude;
  }
  // `+ 0` normalises -0, as in tiltTowardPointer.
  return {
    photo: { x: nx * HERO_PARALLAX_PHOTO_PX + 0, y: ny * HERO_PARALLAX_PHOTO_PX + 0 },
    pattern: { x: -nx * HERO_PARALLAX_PATTERN_PX + 0, y: -ny * HERO_PARALLAX_PATTERN_PX + 0 },
  };
}

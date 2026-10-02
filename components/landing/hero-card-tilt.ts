// Pointer-tilt math for the landing hero's "credencial viva" card.
//
// Pure on purpose: the component only records the pointer and paints, so the
// one rule that must never drift — the HARD cap on how far the card leans —
// lives here where a unit test can pin it without a browser.

/** The furthest the card may lean toward the pointer, in degrees, on ANY axis
 *  combination. Corners are capped too: without the radial clamp below, a
 *  pointer in a corner would lean the card max * sqrt(2) ≈ 14°. */
export const HERO_TILT_MAX_DEG = 10;

/** Exponential smoothing time constant for the tilt, in milliseconds. ~90ms
 *  follows the hand without lag and without the jitter of a raw 1:1 map. */
export const HERO_TILT_SMOOTHING_MS = 90;

export type HeroTilt = {
  /** rotateX in degrees (CSS): positive brings the BOTTOM edge toward the viewer. */
  rx: number;
  /** rotateY in degrees (CSS): positive sends the RIGHT edge away from the viewer. */
  ry: number;
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

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
 *  1.5° is the math default for callers that omit `max` (tests, helpers).
 *  The landing credential passes its fixed 8° cap explicitly. */
export const HERO_TILT_MAX_DEG = 1.5;

/** Exponential smoothing time constants, in milliseconds. rotateX (the
 *  head↔foot axis) is slower: the MRZ end is the heavier end of a carnet.
 *  rotateY answers first. Passing an explicit tau to `smoothTilt` still
 *  drives both axes (tests, and anything that wants a single spring). */
export const HERO_TILT_SMOOTHING_MS = 120;
export const HERO_TILT_SMOOTHING_RX_MS = 168;
export const HERO_TILT_SMOOTHING_RY_MS = 96;

/** How far the QR glyph slides at full lean, in px. Tiny: printed on the
 *  stock, not a sticker. */
export const HERO_PARALLAX_QR_PX = 3;

/** How far the band mark lattice slides at full lean, in px. It sits IN the
 *  blue band, under the issuer line, and moves AWAY from the pointer.
 *  18 is a trial: large enough to read while the card leans. */
export const HERO_PARALLAX_PATTERN_PX = 18;

/** How far the pivot slides toward the receding (pressed) edge, in percent.
 *  Modest: a 32% slide plus 16° of lean threw the far edge (the MRZ) off the
 *  carnet like a loose sheet. */
export const HERO_PIVOT_TRAVEL_PCT = 16;

/** Extra scale at full lean. Applied after the pivot, so the near edge grows
 *  more than the pressed edge. A carnet, not a poster. */
export const HERO_NEAR_SCALE_TRAVEL = 0.022;

/** Finger-give at full lean: the face sinks toward the table and squashes a
 *  hair. Net scale is near-travel minus this, so the far edge barely grows. */
export const HERO_PRESS_SINK_PX = 1.2;
export const HERO_PRESS_SQUASH = 0.012;

export type HeroTilt = {
  /** rotateX in degrees (CSS): positive brings the BOTTOM edge toward the viewer. */
  rx: number;
  /** rotateY in degrees (CSS): positive sends the RIGHT edge away from the viewer. */
  ry: number;
};

export type HeroOffset = { x: number; y: number };

export type HeroParallax = {
  /** QR offset in px (toward the pointer). */
  qr: HeroOffset;
  /** Holographic security-mark offset in px (away from the pointer). */
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
  tauMs?: number,
): HeroTilt {
  const dt = Math.max(0, dtMs);
  const tauX = tauMs ?? HERO_TILT_SMOOTHING_RX_MS;
  const tauY = tauMs ?? HERO_TILT_SMOOTHING_RY_MS;
  const alphaX = 1 - Math.exp(-dt / tauX);
  const alphaY = 1 - Math.exp(-dt / tauY);
  return {
    rx: current.rx + (target.rx - current.rx) * alphaX,
    ry: current.ry + (target.ry - current.ry) * alphaY,
  };
}

/**
 * The inner layers' offsets for a given (smoothed) tilt — the parallax stack.
 *
 * Derived from the tilt rather than from the pointer, so the layers ride the
 * SAME smoothed value the card does and settle with it. The lean is
 * normalised by `max` and clamped to the unit disc, so no layer can slide
 * further than its own constant, whatever tilt it is handed.
 */
function leanDirection(tilt: HeroTilt, max: number): HeroOffset {
  if (!(max > 0)) return { x: 0, y: 0 };
  // +ry means the pointer is right (+x); -rx means it is below (+y).
  let nx = Number.isFinite(tilt.ry) ? tilt.ry / max : 0;
  let ny = Number.isFinite(tilt.rx) ? -tilt.rx / max : 0;
  const magnitude = Math.hypot(nx, ny);
  if (magnitude > 1) {
    nx /= magnitude;
    ny /= magnitude;
  }
  return { x: nx + 0, y: ny + 0 };
}

const STILL_PARALLAX: HeroParallax = {
  qr: { x: 0, y: 0 },
  pattern: { x: 0, y: 0 },
};

export function heroParallax(tilt: HeroTilt, max: number = HERO_TILT_MAX_DEG): HeroParallax {
  if (!(max > 0)) return STILL_PARALLAX;
  const { x: nx, y: ny } = leanDirection(tilt, max);
  return {
    qr: { x: nx * HERO_PARALLAX_QR_PX + 0, y: ny * HERO_PARALLAX_QR_PX + 0 },
    pattern: { x: -nx * HERO_PARALLAX_PATTERN_PX + 0, y: -ny * HERO_PARALLAX_PATTERN_PX + 0 },
  };
}

/** Transform origin as percent: sits on the receding (pressed) edge so the
 *  opposite edge lifts toward the camera. */
export function heroPivot(tilt: HeroTilt, max: number = HERO_TILT_MAX_DEG): HeroOffset {
  const { x: nx, y: ny } = leanDirection(tilt, max);
  return {
    x: 50 + nx * HERO_PIVOT_TRAVEL_PCT + 0,
    y: 50 + ny * HERO_PIVOT_TRAVEL_PCT + 0,
  };
}

/** Uniform scale at this lean. With the pivot on the pressed edge, the near
 *  edge is the one that grows. The painted scale is `heroPress().scale`, which
 *  subtracts the finger-squash so the far edge barely grows. */
export function heroNearScale(tilt: HeroTilt, max: number = HERO_TILT_MAX_DEG): number {
  const mag = magOf(tilt, max);
  return 1 + mag * HERO_NEAR_SCALE_TRAVEL + 0;
}

function magOf(tilt: HeroTilt, max: number): number {
  const { x: nx, y: ny } = leanDirection(tilt, max);
  return Math.min(1, Math.hypot(nx, ny));
}

export type HeroPress = {
  mag: number;
  sinkPx: number;
  scale: number;
  rimX: number;
  rimY: number;
};

/** Finger-give + the rim highlight vector (px, for an inset box-shadow). */
export function heroPress(tilt: HeroTilt, max: number = HERO_TILT_MAX_DEG): HeroPress {
  const { x: nx, y: ny } = leanDirection(tilt, max);
  const mag = Math.min(1, Math.hypot(nx, ny));
  return {
    mag: mag + 0,
    sinkPx: mag * HERO_PRESS_SINK_PX + 0,
    scale: 1 + mag * (HERO_NEAR_SCALE_TRAVEL - HERO_PRESS_SQUASH) + 0,
    rimX: nx + 0,
    rimY: ny + 0,
  };
}

export const FLIP_EDGE_DEG = 90;

/** One card-width of horizontal drag turns the carnet 180° (front → back). */
export const YAW_PER_WIDTH_DEG = 180;

/** Vertical drag caps here, then springs home. 22° reads as a held card, not a table-flip. */
export const PITCH_MAX_DEG = 22;

/** Fraction of card height that reaches the pitch cap. */
export const PITCH_TRAVEL = 0.42;

export const DRAG_SPRING_STIFFNESS = 220;
export const DRAG_SPRING_DAMPING = 18;

/** Movement below this (px) on pointerup is a tap, not a drag. */
export const TAP_FLIP_PX = 8;

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function wrapDeg360(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  return ((deg % 360) + 360) % 360;
}

/** Signed yaw: drag right increases rotateY, drag left decreases it. */
export function yawFromDrag(startYaw: number, dxPx: number, widthPx: number): number {
  if (!(widthPx > 0) || !Number.isFinite(dxPx) || !Number.isFinite(startYaw)) return startYaw;
  return startYaw + (dxPx / widthPx) * YAW_PER_WIDTH_DEG;
}

/** Drag down brings the top toward the viewer (negative rotateX), clamped. */
export function pitchFromDrag(dyPx: number, heightPx: number): number {
  if (!(heightPx > 0) || !Number.isFinite(dyPx)) return 0;
  const raw = (-dyPx / heightPx) * (PITCH_MAX_DEG / PITCH_TRAVEL);
  return Math.max(-PITCH_MAX_DEG, Math.min(PITCH_MAX_DEG, raw)) + 0;
}

/**
 * Two-painted-face display angle: 0 and 180 sit flat, ±90 is edge-on.
 * Crossing 90° / 270° jumps so the arriving face comes from the far edge.
 */
export function displayRotateYFromYaw(yaw: number): number {
  const w = wrapDeg360(yaw);
  if (w < 90) return w;
  if (w < 270) return w - 180;
  return w - 360;
}

export function faceFromYaw(yaw: number): "front" | "back" {
  const w = wrapDeg360(yaw);
  return w >= 90 && w < 270 ? "back" : "front";
}

/** Degrees away from the nearer flat face (0° or 180°), in 0..90. */
export function yawOffFaceDeg(yaw: number): number {
  if (!Number.isFinite(yaw)) return 0;
  const w = wrapDeg360(yaw);
  return Math.min(w, 360 - w, Math.abs(w - 180));
}

/** How edge-on the carnet is, 0 on a face and 1 at ±90°. The paper
 *  shadow reads this so it shrinks with the turn instead of staying a puddle. */
export function groundEdgeFromYaw(yaw: number): number {
  return clamp01(yawOffFaceDeg(yaw) / FLIP_EDGE_DEG);
}

/**
 * How hard the portrait OVD and the band ghosts catch this pose.
 * 0 on a flat face. Pitch reaches 1 at the vertical stop. Yaw stays 0
 * until the card is well off flat, then climbs toward the edge.
 */
export function opticPressFromPose(yaw: number, pitch: number): number {
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return 0;
  const pitchMag = Math.min(1, Math.abs(pitch) / PITCH_MAX_DEG);
  const off = yawOffFaceDeg(yaw);
  const yawMag = off <= 50 ? 0 : Math.min(1, (off - 50) / 28);
  return Math.min(1, Math.max(pitchMag, yawMag)) + 0;
}

/** Snap to 0° / 180° / ±360°… without spinning the long way. */
export function nearestRestYaw(yaw: number): number {
  if (!Number.isFinite(yaw)) return 0;
  const w = wrapDeg360(yaw);
  const base = yaw - w;
  if (w < 90) return base;
  if (w < 270) return base + 180;
  return base + 360;
}

/**
 * Release: nearest rest, unless a flick already left the start face.
 * yawPerMs is signed deg/ms.
 */
export function yawReleaseTarget(yaw: number, yawPerMs = 0): number {
  const dest = nearestRestYaw(yaw);
  const flicked = Math.abs(yawPerMs) > 0.22;
  if (!flicked) return dest;
  const w = wrapDeg360(yaw);
  if (yawPerMs > 0) {
    if (w < 90) return yaw - w + 180;
    if (w < 270) return yaw - w + 360;
    return yaw - w + 360;
  }
  if (w > 270) return yaw - w + 180;
  if (w > 90) return yaw - w;
  return yaw - w;
}

export function springTick(
  pos: number,
  vel: number,
  dest: number,
  dtMs: number,
  stiffness = DRAG_SPRING_STIFFNESS,
  damping = DRAG_SPRING_DAMPING,
): { pos: number; vel: number } {
  const dt = Math.min(Math.max(dtMs, 0), 32) / 1000;
  const accel = (dest - pos) * stiffness - vel * damping;
  const nextVel = vel + accel * dt;
  return { pos: pos + nextVel * dt, vel: nextVel };
}

export function springSettled(pos: number, vel: number, dest: number): boolean {
  return Math.abs(pos - dest) < 0.2 && Math.abs(vel) < 8;
}

/**
 * Y rotation for a two-painted-face swap along 0…1 progress (flick path).
 * Crossing 0.5 jumps +90° → −90° so the arriving face comes from the far edge.
 */
export function slabRotateYDeg(progress: number): number {
  return displayRotateYFromYaw(clamp01(progress) * YAW_PER_WIDTH_DEG);
}

export function faceFromFlipProgress(progress: number): "front" | "back" {
  return faceFromYaw(clamp01(progress) * YAW_PER_WIDTH_DEG);
}

export function easeOutCubic(t: number): number {
  const u = clamp01(t);
  return 1 - (1 - u) ** 3;
}

export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

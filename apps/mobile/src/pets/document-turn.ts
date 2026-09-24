// The turn of the two-faced document, expressed as data: the four numbers and
// the order of the moves, with no React and no react-native anywhere in the
// file so the choreography can be asserted directly instead of inferred from a
// rendered tree.
//
// THE NUMBERS ARE THE WEB'S, AND THERE IS NOTHING SHARED TO IMPORT. The board
// quotes "~485ms"; that figure is not a token. `--motion-*` in app/globals.css
// tops out at a 600ms "deliberate" bucket and the turn is not one duration, it
// is four — components/pet-profile/FlipCard.tsx hardcodes 0.2s ease-in, a 205ms
// swap point, 0.26s ease-out and a 280ms settle, and 205 + 280 is the 485. They
// are copied here on purpose, named, and fenced by document-turn.test.ts —
// EACH AGAINST ITS OWN LITERAL. A hand transcription's characteristic failure is
// a wrong digit, and every relational assertion in that file (`SWAP > OUT`,
// `IN > OUT`, `|angle| < 90`) reads these same constants on both sides, so it
// holds for whole families of wrong copies: four of the five could be edited one
// at a time with the suite green until the literals were added.
// `@dim/contract/tokens` carries colour and radius, no motion; adding a motion
// section to the shared contract for one screen's four numbers was not worth
// widening the contract for, and is written down here rather than left implied.
//
// WHY 87° AND NOT 90°. Only ONE face is ever mounted on this sheet (the web
// mounts both and hides the inactive one; this app conditionally renders, which
// is stricter), and a lone face has no backface to hide behind. Past 90° the
// reader would be looking at the front of the credential from behind —
// mirrored, and legible as such. So the sheet stops one hair short of edge-on,
// swaps the face while it is effectively invisible, and returns from the OTHER
// edge. It never crosses 90°, so mirrored text is never on screen and exactly
// one face is ever painted.
//
// REDUCED MOTION IS NOT A DEGRADED PATH HERE, IT IS THE ORIGINAL ONE. The
// instant swap is what this document shipped with, and it stays the whole
// mechanic for a reader who asked for less motion — same wording as the web's
// FlipCard, which reads the preference at turn time rather than during render.

/** Phase 1: how long the sheet takes to turn edge-on. */
export const TURN_OUT_MS = 200;

/** When the face is swapped — a hair after phase 1 lands, so the swap happens
 *  behind an edge the reader cannot see into. */
export const TURN_SWAP_AT_MS = 205;

/** Phase 2: how long the new face takes to come back to flat. */
export const TURN_IN_MS = 260;

/** When control is handed back after phase 2 — again a hair long, so a queued
 *  second turn never starts on top of a still-moving sheet. */
export const TURN_SETTLE_AT_MS = 280;

/** The whole turn, end to end: the ~485ms the board quotes. */
export const TURN_TOTAL_MS = TURN_SWAP_AT_MS + TURN_SETTLE_AT_MS;

/** One hair short of edge-on. See the header for why it is not 90. */
export const TURN_EDGE_ON_DEG = 87;

/** The web's `.ln-doc-stage` perspective, in points. Without it the rotation
 *  reads as a horizontal squash instead of a sheet turning in space. */
export const TURN_PERSPECTIVE = 1700;

/** Named rather than an easing object so this module imports nothing. */
export type TurnEasing = "in" | "out";

export type TurnStep =
  /** Animate the sheet to `toDeg` over `durationMs`, then move on immediately —
   *  the wait that follows is what paces the phase, exactly as the web's
   *  `setTimeout` is set the moment the transform is assigned. */
  | {
      readonly kind: "rotate";
      readonly toDeg: number;
      readonly durationMs: number;
      readonly easing: TurnEasing;
    }
  /** Paint the requested face. Legal only while the sheet is edge-on. */
  | { readonly kind: "swap" }
  /** Put the sheet at `toDeg` with no animation — the jump across the edge. */
  | { readonly kind: "jump"; readonly toDeg: number }
  /** Hold for `ms`, counted from when the previous step was issued. */
  | { readonly kind: "wait"; readonly ms: number };

/** A reader who asked for less motion gets the instant swap, and nothing else:
 *  no rotation, no waiting, no sheet in flight to interrupt. */
const REDUCED_PLAN: readonly TurnStep[] = Object.freeze([{ kind: "swap" } as const]);

const ANIMATED_PLAN: readonly TurnStep[] = Object.freeze([
  { kind: "rotate", toDeg: TURN_EDGE_ON_DEG, durationMs: TURN_OUT_MS, easing: "in" } as const,
  { kind: "wait", ms: TURN_SWAP_AT_MS } as const,
  { kind: "swap" } as const,
  { kind: "jump", toDeg: -TURN_EDGE_ON_DEG } as const,
  { kind: "rotate", toDeg: 0, durationMs: TURN_IN_MS, easing: "out" } as const,
  { kind: "wait", ms: TURN_SETTLE_AT_MS } as const,
]);

/**
 * The moves that turn the sheet over, in order.
 *
 * The plan is DATA and the same array every call — a driver walks it, so the
 * fences in document-turn.test.ts are asserting the steps the app actually
 * runs, not a description of them kept alongside.
 */
export function turnPlan(reducedMotion: boolean): readonly TurnStep[] {
  return reducedMotion ? REDUCED_PLAN : ANIMATED_PLAN;
}

/** Every angle the plan puts the sheet at, in order — including the 0 it
 *  starts flat at. The geometry fences read this rather than re-walking the
 *  step union in each test. */
export function turnAngles(plan: readonly TurnStep[]): readonly number[] {
  const angles = [0];
  for (const step of plan) {
    if (step.kind === "rotate" || step.kind === "jump") angles.push(step.toDeg);
  }
  return angles;
}

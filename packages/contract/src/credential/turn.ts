// The turn of the two-faced DOCUMENT, expressed as data.
//
// Shared by the web FlipCard, the native DocumentTurn driver, and (as a
// separate named recipe) the landing carnet's CSS flick. One file so a third
// copy cannot appear. No React, no react-native — this rides `@dim/contract`
// and is OTA-safe JS.
//
// THE DOCUMENT PLAN is the owner's two-sided sheet: 87° (never 90: a single
// painted face would read mirrored past edge-on), 200/205/260/280 ms. Native
// used to transcribe these from FlipCard; FlipCard now imports them here.
//
// THE CARNET HOOK PLAN is the landing flick: CSS keyframes with a few degrees
// of overshoot past flat (`app/landing.css` lp-hcard-turn-*). That overshoot
// is the hook, not the document. Timers in LandingHero must match the CSS
// durations below — a setTimeout cannot read a custom property.

/** Phase 1: how long the sheet takes to turn edge-on. */
export const TURN_OUT_MS = 200;

/** When the face is swapped — a hair after phase 1 lands. */
export const TURN_SWAP_AT_MS = 205;

/** Phase 2: how long the new face takes to come back to flat. */
export const TURN_IN_MS = 260;

/** When control is handed back after phase 2. */
export const TURN_SETTLE_AT_MS = 280;

/** The whole document turn, end to end (~485ms). */
export const TURN_TOTAL_MS = TURN_SWAP_AT_MS + TURN_SETTLE_AT_MS;

/** One hair short of edge-on. Past 90° a single painted face is mirrored. */
export const TURN_EDGE_ON_DEG = 87;

/** `.ln-doc-stage` perspective, in px / points. */
export const TURN_PERSPECTIVE = 1700;

/**
 * Landing carnet flick — CSS `--lp-turn-out: 270ms` on `.lp-hcard-slab`.
 * Coupled to `app/landing.css` `.lp-hcard-slab[data-turn="out"]`.
 */
export const CARNET_HOOK_TURN_OUT_MS = 270;

/**
 * Landing carnet landing — CSS `--lp-turn-in: 450ms` on `.lp-hcard-slab`.
 * Coupled to `.lp-hcard-slab[data-turn="in"]`.
 */
export const CARNET_HOOK_TURN_IN_MS = 450;

export type TurnEasing = "in" | "out";

export type TurnStep =
  | {
      readonly kind: "rotate";
      readonly toDeg: number;
      readonly durationMs: number;
      readonly easing: TurnEasing;
    }
  | { readonly kind: "swap" }
  | { readonly kind: "jump"; readonly toDeg: number }
  | { readonly kind: "wait"; readonly ms: number };

const REDUCED_PLAN: readonly TurnStep[] = Object.freeze([{ kind: "swap" } as const]);

const ANIMATED_PLAN: readonly TurnStep[] = Object.freeze([
  { kind: "rotate", toDeg: TURN_EDGE_ON_DEG, durationMs: TURN_OUT_MS, easing: "in" } as const,
  { kind: "wait", ms: TURN_SWAP_AT_MS } as const,
  { kind: "swap" } as const,
  { kind: "jump", toDeg: -TURN_EDGE_ON_DEG } as const,
  { kind: "rotate", toDeg: 0, durationMs: TURN_IN_MS, easing: "out" } as const,
  { kind: "wait", ms: TURN_SETTLE_AT_MS } as const,
]);

export function turnPlan(reducedMotion: boolean): readonly TurnStep[] {
  return reducedMotion ? REDUCED_PLAN : ANIMATED_PLAN;
}

export function turnAngles(plan: readonly TurnStep[]): readonly number[] {
  const angles = [0];
  for (const step of plan) {
    if (step.kind === "rotate" || step.kind === "jump") angles.push(step.toDeg);
  }
  return angles;
}

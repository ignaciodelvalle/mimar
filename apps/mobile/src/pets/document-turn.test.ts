// The turn's geometry and timing, asserted on the plan the driver walks.
//
// These are not decoration. Two of the three requirements the animation exists
// to satisfy are geometric — never two faces at once, never a mirrored one —
// and both are properties of the ANGLES, which a rendered tree cannot show you:
// react-test-renderer hands back a style object, not a rasterised sheet. So the
// geometry is fenced here, on the data the hook executes, and the render tests
// in DocumentTurn.test.tsx fence the behaviour that data produces.

import { describe, expect, it } from "@jest/globals";

import {
  TURN_EDGE_ON_DEG,
  TURN_IN_MS,
  TURN_OUT_MS,
  TURN_PERSPECTIVE,
  TURN_SETTLE_AT_MS,
  TURN_SWAP_AT_MS,
  TURN_TOTAL_MS,
  type TurnStep,
  turnAngles,
  turnPlan,
} from "./document-turn";

const animated = turnPlan(false);
const reduced = turnPlan(true);

// THE COPY IS THE POINT, SO THE COPY IS WHAT IS FENCED. There is nothing to
// import from the web app and nothing in `@dim/contract/tokens` that carries
// motion, so these seven values were transcribed by hand from
// components/pet-profile/FlipCard.tsx and app/globals.css. The module's header
// says they are "copied here on purpose, named, and fenced"; every relational
// assertion below (`SWAP > OUT`, `IN > OUT`, `|angle| < 90`) reads the constants
// on BOTH sides and so survives any transcription error that keeps the ordering
// — four of the five numbers could be edited one at a time with the whole suite
// green. These are the only assertions in this file that name a literal, and
// they are the only ones that can catch a wrong copy.
describe("the numbers are the web's, transcribed", () => {
  it("carries FlipCard's four durations, not approximations of them", () => {
    // FlipCard.tsx:143 `transform 0.2s ease-in`, :164 `setTimeout(…, 205)`,
    // :155 `transform 0.26s ease-out`, :162 `setTimeout(…, 280)`.
    expect(TURN_OUT_MS).toBe(200);
    expect(TURN_SWAP_AT_MS).toBe(205);
    expect(TURN_IN_MS).toBe(260);
    expect(TURN_SETTLE_AT_MS).toBe(280);
    // Derived, but the board quotes it as a number of its own.
    expect(TURN_TOTAL_MS).toBe(485);
  });

  it("stops at the web's 87°, on the web's stage perspective", () => {
    // FlipCard.tsx:144 `rotateY(87deg)` and :151 `rotateY(-87deg)`;
    // globals.css `.ln-doc-stage { perspective: 1700px }`.
    //
    // 87 is a REQUIREMENT and not a rounding of 90 — see the module header —
    // and `|angle| < 90` passes at 45°, where the sheet never gets close to
    // edge-on and the swap happens in full view of the reader.
    expect(TURN_EDGE_ON_DEG).toBe(87);
    expect(TURN_PERSPECTIVE).toBe(1700);
  });
});

function kinds(plan: readonly TurnStep[]): string[] {
  return plan.map((step) => step.kind);
}

describe("turnPlan — the reader who asked for less motion", () => {
  it("gets the swap and nothing else: no rotation, no wait, no sheet in flight", () => {
    expect(kinds(reduced)).toEqual(["swap"]);
  });

  it("is the path the document shipped with — an instant swap, not a fast animation", () => {
    // A 1ms rotation would satisfy "reduced" to a stopwatch and fail the
    // person: vestibular triggers are about movement, not duration.
    expect(reduced.some((step) => step.kind === "rotate" || step.kind === "jump")).toBe(false);
    expect(turnAngles(reduced)).toEqual([0]);
  });
});

describe("turnPlan — one face painted at a time", () => {
  it("swaps exactly once, so two faces can never both be on the sheet", () => {
    expect(animated.filter((step) => step.kind === "swap")).toHaveLength(1);
  });

  it("swaps while the sheet is edge-on, and leaves by the OTHER edge", () => {
    const at = animated.findIndex((step) => step.kind === "swap");
    expect(at).toBeGreaterThan(0);

    // Whatever the step before the swap was, the sheet is standing at the edge.
    const before = animated.slice(0, at);
    const standingAt = turnAngles(before).at(-1);
    expect(standingAt).toBe(TURN_EDGE_ON_DEG);

    // And it resumes from the opposite edge — not by unwinding the way it came,
    // which would show the reader the face they just left.
    const after = animated[at + 1];
    expect(after).toEqual({ kind: "jump", toDeg: -TURN_EDGE_ON_DEG });
  });

  it("never takes the sheet past 90°, so no face is ever seen mirrored", () => {
    // The one requirement a lone mounted face cannot get for free: there is no
    // backface to hide behind, so the guard has to be the angle itself.
    for (const angle of turnAngles(animated)) {
      expect(Math.abs(angle)).toBeLessThan(90);
    }
  });

  it("ends flat, facing the reader", () => {
    expect(turnAngles(animated).at(-1)).toBe(0);
  });
});

describe("turnPlan — the ~485ms the board quotes", () => {
  it("spends 485ms in total, and it is the two waits that spend it", () => {
    const waited = animated.reduce((sum, step) => (step.kind === "wait" ? sum + step.ms : sum), 0);
    expect(waited).toBe(TURN_TOTAL_MS);
    expect(TURN_TOTAL_MS).toBe(485);
  });

  it("holds each phase a hair longer than the movement it paces", () => {
    // The swap must land AFTER the sheet has finished standing up, and control
    // must return AFTER the sheet has finished lying back down. Equal numbers
    // would make both a race against the frame clock.
    expect(TURN_SWAP_AT_MS).toBeGreaterThan(TURN_OUT_MS);
    expect(TURN_SETTLE_AT_MS).toBeGreaterThan(TURN_IN_MS);
  });

  it("comes back in slower than it went out, and eases the way the web eases", () => {
    const rotations = animated.filter((step) => step.kind === "rotate");
    expect(rotations).toEqual([
      { kind: "rotate", toDeg: TURN_EDGE_ON_DEG, durationMs: TURN_OUT_MS, easing: "in" },
      { kind: "rotate", toDeg: 0, durationMs: TURN_IN_MS, easing: "out" },
    ]);
    expect(TURN_IN_MS).toBeGreaterThan(TURN_OUT_MS);
  });
});

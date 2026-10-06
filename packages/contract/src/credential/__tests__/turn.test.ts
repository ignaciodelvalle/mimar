import { describe, expect, it } from "vitest";

import {
  CARNET_HOOK_TURN_IN_MS,
  CARNET_HOOK_TURN_OUT_MS,
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
} from "../turn.ts";

const animated = turnPlan(false);
const reduced = turnPlan(true);

describe("document turn numbers", () => {
  it("is the FlipCard / native sheet, not the landing flick", () => {
    expect(TURN_OUT_MS).toBe(200);
    expect(TURN_SWAP_AT_MS).toBe(205);
    expect(TURN_IN_MS).toBe(260);
    expect(TURN_SETTLE_AT_MS).toBe(280);
    expect(TURN_TOTAL_MS).toBe(485);
    expect(TURN_EDGE_ON_DEG).toBe(87);
    expect(TURN_PERSPECTIVE).toBe(1700);
  });

  it("keeps the carnet hook durations beside the document plan, named", () => {
    expect(CARNET_HOOK_TURN_OUT_MS).toBe(270);
    expect(CARNET_HOOK_TURN_IN_MS).toBe(450);
    expect(CARNET_HOOK_TURN_OUT_MS).not.toBe(TURN_OUT_MS);
  });
});

function kinds(plan: readonly TurnStep[]): string[] {
  return plan.map((step) => step.kind);
}

describe("turnPlan", () => {
  it("reduced motion is an instant swap", () => {
    expect(kinds(reduced)).toEqual(["swap"]);
    expect(turnAngles(reduced)).toEqual([0]);
  });

  it("animated plan never crosses 90°", () => {
    for (const angle of turnAngles(animated)) {
      expect(Math.abs(angle)).toBeLessThan(90);
    }
  });

  it("swaps once, at the edge", () => {
    expect(kinds(animated).filter((k) => k === "swap")).toEqual(["swap"]);
  });
});

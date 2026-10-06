import { describe, expect, it } from "vitest";

import {
  FLIP_EDGE_DEG,
  PITCH_MAX_DEG,
  TAP_FLIP_PX,
  YAW_PER_WIDTH_DEG,
  clamp01,
  displayRotateYFromYaw,
  easeOutCubic,
  faceFromFlipProgress,
  faceFromYaw,
  groundEdgeFromYaw,
  mix,
  nearestRestYaw,
  opticPressFromPose,
  pitchFromDrag,
  slabRotateYDeg,
  springSettled,
  springTick,
  wrapDeg360,
  yawFromDrag,
  yawOffFaceDeg,
  yawReleaseTarget,
} from "./landing-flip";

describe("slabRotateYDeg", () => {
  it("sits flat at both faces and hits the edge at the midpoint", () => {
    expect(slabRotateYDeg(0)).toBe(0);
    expect(slabRotateYDeg(0.25)).toBe(FLIP_EDGE_DEG / 2);
    expect(slabRotateYDeg(0.5)).toBe(-FLIP_EDGE_DEG);
    expect(slabRotateYDeg(0.75)).toBe(-FLIP_EDGE_DEG / 2);
    expect(slabRotateYDeg(1)).toBe(0);
  });
});

describe("faceFromFlipProgress", () => {
  it("swaps at the invisible edge", () => {
    expect(faceFromFlipProgress(0)).toBe("front");
    expect(faceFromFlipProgress(0.49)).toBe("front");
    expect(faceFromFlipProgress(0.5)).toBe("back");
    expect(faceFromFlipProgress(1)).toBe("back");
  });
});

describe("yawFromDrag", () => {
  it("maps signed travel: right and left turn opposite ways", () => {
    expect(yawFromDrag(0, 200, 400)).toBe(90);
    expect(yawFromDrag(0, -200, 400)).toBe(-90);
    expect(yawFromDrag(180, 200, 400)).toBe(270);
    expect(yawFromDrag(180, -200, 400)).toBe(90);
    expect(yawFromDrag(0, 400, 400)).toBe(YAW_PER_WIDTH_DEG);
  });
});

describe("pitchFromDrag", () => {
  it("clamps at the defined extreme", () => {
    expect(pitchFromDrag(0, 300)).toBe(0);
    expect(pitchFromDrag(400, 300)).toBe(-PITCH_MAX_DEG);
    expect(pitchFromDrag(-400, 300)).toBe(PITCH_MAX_DEG);
  });
});

describe("groundEdgeFromYaw", () => {
  it("is 0 on either face and 1 at the edge", () => {
    expect(groundEdgeFromYaw(0)).toBe(0);
    expect(groundEdgeFromYaw(180)).toBe(0);
    expect(groundEdgeFromYaw(90)).toBe(1);
    expect(groundEdgeFromYaw(-90)).toBe(1);
    expect(groundEdgeFromYaw(45)).toBeCloseTo(0.5, 9);
  });
});

describe("opticPressFromPose", () => {
  it("stays dark on a flat face and a light horizontal nudge", () => {
    expect(opticPressFromPose(0, 0)).toBe(0);
    expect(opticPressFromPose(180, 0)).toBe(0);
    expect(yawOffFaceDeg(20)).toBe(20);
    expect(opticPressFromPose(20, 0)).toBe(0);
  });

  it("reaches 1 at the pitch stop and near the edge", () => {
    expect(opticPressFromPose(0, PITCH_MAX_DEG)).toBe(1);
    expect(opticPressFromPose(0, -PITCH_MAX_DEG)).toBe(1);
    expect(opticPressFromPose(78, 0)).toBe(1);
    expect(opticPressFromPose(40, 0)).toBe(0);
  });
});

describe("displayRotateYFromYaw / faceFromYaw", () => {
  it("keeps both horizontal directions on the two-painted-face trick", () => {
    expect(displayRotateYFromYaw(0)).toBe(0);
    expect(displayRotateYFromYaw(90)).toBe(-90);
    expect(displayRotateYFromYaw(180)).toBe(0);
    expect(displayRotateYFromYaw(-90)).toBe(-90);
    expect(faceFromYaw(0)).toBe("front");
    expect(faceFromYaw(90)).toBe("back");
    expect(faceFromYaw(180)).toBe("back");
    expect(faceFromYaw(-91)).toBe("back");
    expect(faceFromYaw(270)).toBe("front");
    expect(wrapDeg360(-90)).toBe(270);
  });
});

describe("nearestRestYaw / yawReleaseTarget", () => {
  it("snaps to the nearer face without the long way around", () => {
    expect(nearestRestYaw(40)).toBe(0);
    expect(nearestRestYaw(100)).toBe(180);
    expect(nearestRestYaw(-40)).toBe(0);
    expect(nearestRestYaw(-100)).toBe(-180);
    expect(yawReleaseTarget(40, 0)).toBe(0);
    expect(yawReleaseTarget(100, 0)).toBe(180);
    expect(yawReleaseTarget(40, 0.3)).toBe(180);
    expect(yawReleaseTarget(-40, -0.3)).toBe(-180);
  });
});

describe("springTick", () => {
  it("moves toward the dest and eventually settles", () => {
    let pos = 22;
    let vel = 0;
    for (let i = 0; i < 120; i++) {
      const next = springTick(pos, vel, 0, 16);
      pos = next.pos;
      vel = next.vel;
    }
    expect(springSettled(pos, vel, 0)).toBe(true);
    expect(Math.abs(pos)).toBeLessThan(0.2);
  });
});

describe("TAP_FLIP_PX", () => {
  it("is a short tap, not a drag", () => {
    expect(TAP_FLIP_PX).toBe(8);
  });
});

describe("clamp01 / mix / easeOutCubic", () => {
  it("stays in range", () => {
    expect(clamp01(2)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
    expect(mix(0, 10, 0.5)).toBe(5);
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
  });
});

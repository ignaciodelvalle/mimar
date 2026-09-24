// `haptics` — the three verbs and the one rule.
//
// The mapping IS the contract: success and error ride the OS notification
// vocabulary (they answer a wait), confirm rides impact (it acknowledges a
// tap). And every one must swallow a rejection, because the first devices this
// runs on — emulators, and phones with no vibration engine — are exactly the
// ones that reject.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockNotification = jest.fn<(type: string) => Promise<void>>();
const mockImpact = jest.fn<(style: string) => Promise<void>>();

jest.mock("expo-haptics", () => ({
  notificationAsync: (type: string) => mockNotification(type),
  impactAsync: (style: string) => mockImpact(style),
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
  ImpactFeedbackStyle: { Light: "light", Medium: "medium", Heavy: "heavy" },
}));

import { hapticConfirm, hapticError, hapticSuccess } from "./haptics";

beforeEach(() => {
  mockNotification.mockReset().mockResolvedValue(undefined);
  mockImpact.mockReset().mockResolvedValue(undefined);
});

describe("the three verbs map onto the OS vocabularies", () => {
  it("success and error are NOTIFICATIONS — they answer a wait", () => {
    hapticSuccess();
    hapticError();
    expect(mockNotification.mock.calls.map((c) => c[0])).toEqual(["success", "error"]);
    expect(mockImpact).not.toHaveBeenCalled();
  });

  it("confirm is an IMPACT — it acknowledges a tap, not an outcome", () => {
    hapticConfirm();
    expect(mockImpact).toHaveBeenCalledWith("medium");
    expect(mockNotification).not.toHaveBeenCalled();
  });
});

describe("fire-and-forget", () => {
  it("swallows a device that cannot buzz instead of surfacing it", async () => {
    // An emulator or engine-less phone rejects; feedback about feedback is not
    // an error anybody can act on. An unhandled rejection here would crash the
    // exact success path the buzz was decorating.
    mockNotification.mockRejectedValue(new Error("no vibrator"));
    mockImpact.mockRejectedValue(new Error("no vibrator"));
    expect(() => {
      hapticSuccess();
      hapticError();
      hapticConfirm();
    }).not.toThrow();
    // Let the rejected promises settle: the .catch inside must absorb them.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

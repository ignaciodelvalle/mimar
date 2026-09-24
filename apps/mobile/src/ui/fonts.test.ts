// The tie between `LN_FONT_WEIGHTS` in the contract and what this app loads.
//
// Both halves are cheap to get wrong in the same silent way: a weight declared
// in the contract but never registered renders as the system font (React Native
// does not synthesize weights on Android — it just fails to find the family and
// falls back), and a face registered but never declared is bytes in every
// install that nothing points at. Neither shows up as an error anywhere.
//
// `expo-font` is mocked because it reaches for the native module; nothing here
// tests loading, only the two SETS agreeing.

import { LN_FONT_FAMILY, LN_FONT_WEIGHTS } from "@dim/contract/tokens";
import { describe, expect, it, jest } from "@jest/globals";

jest.mock("expo-font", () => ({ useFonts: () => [true, null] }));

import { FONTS, LN_FONT_ASSETS } from "./fonts";

/** `"IBM Plex Serif"` → `"IBMPlexSerif"` — how the font packages name a family. */
function compact(family: string): string {
  return family.replace(/\s+/g, "");
}

/** Every face the contract declares, as the key the packages export it under. */
function declaredFaceNames(): string[] {
  const suffix: Record<number, string> = {
    400: "400Regular",
    500: "500Medium",
    600: "600SemiBold",
    700: "700Bold",
  };
  const names: string[] = [];
  for (const [role, weights] of Object.entries(LN_FONT_WEIGHTS)) {
    const family = compact(LN_FONT_FAMILY[role as keyof typeof LN_FONT_FAMILY]);
    for (const weight of weights) names.push(`${family}_${suffix[weight]}`);
  }
  return names.sort();
}

describe("the font registry", () => {
  it("registers exactly the faces the contract declares", () => {
    expect(Object.keys(LN_FONT_ASSETS).sort()).toEqual(declaredFaceNames());
  });

  // The keys are written out rather than derived, so this is what stops them
  // drifting from the family the contract promises — a rename on the contract
  // side lands here rather than in a silently mislabelled asset.
  it("names every face after a contract family", () => {
    const families = Object.values(LN_FONT_FAMILY).map(compact);
    for (const key of Object.keys(LN_FONT_ASSETS)) {
      expect(families.some((family) => key.startsWith(`${family}_`))).toBe(true);
    }
  });

  it("resolves an asset for every family name a StyleSheet can ask for", () => {
    for (const name of Object.values(FONTS)) {
      expect(Object.keys(LN_FONT_ASSETS)).toContain(name);
    }
  });

  // WEIGHT LIVES IN THE FAMILY NAME, not in `fontWeight`. If a role were ever
  // pointed at a bare family the runtime would find nothing and fall back to
  // the system face — the exact failure this app spent its whole life in.
  it("points every role at a specific face, never a bare family", () => {
    for (const name of Object.values(FONTS)) {
      expect(name).toMatch(/_\d{3}[A-Za-z]+$/);
    }
  });
});

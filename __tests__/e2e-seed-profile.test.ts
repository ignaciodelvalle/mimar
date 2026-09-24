// Pins e2e/_seed-profile.ts — the environment gate that decides whether a
// missing e2e fixture is a documented skip or a red.
//
// It lives here for the reason _page-identity.ts states: logic inside a
// Playwright spec is logic nobody can unit-test, and the defect this gate
// replaces was precisely "a check that could not fail". The gate itself must
// not become one.

import { describe, expect, it } from "vitest";

import { resolveSeedProfile, seedFixtureVerdict } from "@/e2e/_seed-profile";

describe("resolveSeedProfile", () => {
  it("defaults to bootstrap — the conservative answer for a bare local/CI run", () => {
    expect(resolveSeedProfile({})).toBe("bootstrap");
  });

  it("reads STAGING_URL as the deployed, fully seeded origin signal", () => {
    expect(resolveSeedProfile({ STAGING_URL: "https://dim-staging.vercel.app" })).toBe("full");
    // Whitespace is not a signal.
    expect(resolveSeedProfile({ STAGING_URL: "   " })).toBe("bootstrap");
  });

  it("lets E2E_SEED_PROFILE override the inferred value in both directions", () => {
    expect(resolveSeedProfile({ E2E_SEED_PROFILE: "full" })).toBe("full");
    expect(
      resolveSeedProfile({ E2E_SEED_PROFILE: "bootstrap", STAGING_URL: "https://x.test" }),
    ).toBe("bootstrap");
    // An unrecognised value falls through to inference rather than silently
    // becoming "full" (a typo must never arm a gate).
    expect(resolveSeedProfile({ E2E_SEED_PROFILE: "staging" })).toBe("bootstrap");
  });
});

describe("seedFixtureVerdict", () => {
  it("runs whenever the fixture is present, whatever the profile", () => {
    expect(seedFixtureVerdict(1, "f", "u", "bootstrap")).toEqual({ verdict: "run" });
    expect(seedFixtureVerdict(3, "f", "u", "full")).toEqual({ verdict: "run" });
  });

  it("FAILS on a fully seeded origin — the whole point of the gate", () => {
    const outcome = seedFixtureVerdict(0, "lost-pet credential link on /perdidas", "the axe audit");
    expect(seedFixtureVerdict(0, "f", "u", "full").verdict).toBe("fail");
    // …and the reason names both the fixture and what went unmeasured, so the
    // failure is actionable without opening the spec.
    const full = seedFixtureVerdict(
      0,
      "lost-pet credential link on /perdidas",
      "the axe audit",
      "full",
    );
    expect(full.verdict === "fail" && full.reason).toContain("/perdidas");
    expect(full.verdict === "fail" && full.reason).toContain("the axe audit");
    // Default profile is resolved from the real environment; assert only that
    // it produced a decision, never a silent "run".
    expect(outcome.verdict).not.toBe("run");
  });

  it("skips under the bootstrap seed, where absence is documented", () => {
    const outcome = seedFixtureVerdict(
      0,
      "adoptable-pet link on /adoptar",
      "the axe audit",
      "bootstrap",
    );
    expect(outcome.verdict).toBe("skip");
    expect(outcome.verdict === "skip" && outcome.reason).toContain("NO COVERAGE");
  });
});

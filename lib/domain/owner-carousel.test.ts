// Tests for the owner credential-carousel pure helpers (owner-ia-redesign P4).
//
// The two load-bearing decisions live here and must be provable without React
// or the DB: the ranked/capped swipe set (rankOwnerCarousel) and the current
// pet's neighbor (computeCarouselNeighbors — CLAMP, NO WRAP). The gating
// predicate (shouldShowCarousel) proves owner-only chrome.

import { describe, expect, it } from "vitest";

import {
  type CarouselPetInput,
  OWNER_CAROUSEL_CAP,
  computeCarouselNeighbors,
  rankOwnerCarousel,
  resolveCarouselStatus,
  shouldShowCarousel,
} from "./owner-carousel";

function input(over: Partial<CarouselPetInput> & { token: string }): CarouselPetInput {
  return { status: "active", pregnancyStatus: null, ...over };
}

describe("resolveCarouselStatus — compliance wins, raw-status fallback", () => {
  it("uses the compliance status when present", () => {
    expect(resolveCarouselStatus(input({ token: "a", complianceStatus: "ok" }))).toBe("ok");
  });

  it("falls back to lost > pregnant > registered when compliance is absent", () => {
    expect(resolveCarouselStatus(input({ token: "a", status: "lost" }))).toBe("lost");
    expect(resolveCarouselStatus(input({ token: "b", pregnancyStatus: "in_progress" }))).toBe(
      "pregnant",
    );
    expect(resolveCarouselStatus(input({ token: "c" }))).toBe("registered");
  });

  it("compliance status overrides a lost/pregnant raw status", () => {
    expect(
      resolveCarouselStatus(input({ token: "a", status: "lost", complianceStatus: "ok" })),
    ).toBe("ok");
  });
});

describe("rankOwnerCarousel — urgent-first, capped, stable ties", () => {
  it("orders lost → pregnant → registered → ok (pet-urgency-rank)", () => {
    const ranked = rankOwnerCarousel([
      input({ token: "ok", complianceStatus: "ok" }),
      input({ token: "reg", complianceStatus: "registered" }),
      input({ token: "lost", complianceStatus: "lost" }),
      input({ token: "preg", complianceStatus: "pregnant" }),
    ]);
    expect(ranked.map((p) => p.token)).toEqual(["lost", "preg", "reg", "ok"]);
  });

  it("caps at OWNER_CAROUSEL_CAP", () => {
    const many = Array.from({ length: OWNER_CAROUSEL_CAP + 4 }, (_, i) =>
      input({ token: `p${i}`, complianceStatus: "ok" }),
    );
    expect(rankOwnerCarousel(many)).toHaveLength(OWNER_CAROUSEL_CAP);
  });

  it("keeps input order for equal-urgency pets (stable sort → createdAt-desc tiebreak)", () => {
    const ranked = rankOwnerCarousel([
      input({ token: "first", complianceStatus: "ok" }),
      input({ token: "second", complianceStatus: "ok" }),
      input({ token: "third", complianceStatus: "ok" }),
    ]);
    expect(ranked.map((p) => p.token)).toEqual(["first", "second", "third"]);
  });

  it("carries the resolved status onto each carousel pet", () => {
    const ranked = rankOwnerCarousel([input({ token: "a", status: "lost" })]);
    expect(ranked[0]).toEqual({ token: "a", status: "lost" });
  });

  it("drops deceased pets structurally — never in the swipe (decision 6)", () => {
    // The filter lives in rankOwnerCarousel itself, not only in the caller, so a
    // future caller that forgets to pre-filter cannot reintroduce a deceased pet
    // into the swipe (owner-carousel.ts M3 fresh-review minor 6).
    const ranked = rankOwnerCarousel([
      input({ token: "alive", complianceStatus: "ok" }),
      input({ token: "gone", status: "deceased" }),
      input({ token: "lost", status: "lost" }),
    ]);
    const tokens = ranked.map((p) => p.token);
    expect(tokens).not.toContain("gone");
    expect(tokens).toEqual(["lost", "alive"]);
  });
});

describe("computeCarouselNeighbors — clamp at ends, NO WRAP", () => {
  const tokens = ["a", "b", "c"];

  it("returns both neighbors in the middle", () => {
    expect(computeCarouselNeighbors(tokens, "b")).toEqual({
      index: 1,
      prevToken: "a",
      nextToken: "c",
    });
  });

  it("clamps at the first position — no previous, does NOT wrap to the last", () => {
    expect(computeCarouselNeighbors(tokens, "a")).toEqual({
      index: 0,
      prevToken: null,
      nextToken: "b",
    });
  });

  it("clamps at the last position — no next, does NOT wrap to the first", () => {
    expect(computeCarouselNeighbors(tokens, "c")).toEqual({
      index: 2,
      prevToken: "b",
      nextToken: null,
    });
  });

  it("returns index -1 and no neighbors when the current token is absent", () => {
    expect(computeCarouselNeighbors(tokens, "z")).toEqual({
      index: -1,
      prevToken: null,
      nextToken: null,
    });
  });

  it("a single-pet list has no neighbors either side", () => {
    expect(computeCarouselNeighbors(["only"], "only")).toEqual({
      index: 0,
      prevToken: null,
      nextToken: null,
    });
  });
});

describe("shouldShowCarousel — owner-only, needs >1 pet, current must be in set", () => {
  const tokens = ["a", "b"];

  it("shows for an owner with the current pet in a multi-pet set", () => {
    expect(shouldShowCarousel({ isOwner: true, tokens, currentToken: "a" })).toBe(true);
  });

  it("hides for a non-owner (org/admin/public/vet viewer) — no chrome", () => {
    expect(shouldShowCarousel({ isOwner: false, tokens, currentToken: "a" })).toBe(false);
  });

  it("hides for a single-pet owner", () => {
    expect(shouldShowCarousel({ isOwner: true, tokens: ["a"], currentToken: "a" })).toBe(false);
  });

  it("hides when the current pet is not in the ranked set (beyond the cap)", () => {
    expect(shouldShowCarousel({ isOwner: true, tokens, currentToken: "z" })).toBe(false);
  });
});

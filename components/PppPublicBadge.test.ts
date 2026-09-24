// Tests for PppPublicBadge logic helpers.
//
// @testing-library/react is not installed — tests cover the pure-logic
// module `lib/ppp-public-badge.ts` extracted from the component.
// Commit 2 of pet-profile-v2 Slice C.

import { describe, expect, it } from "vitest";

import { buildPppDisclaimerLine, buildPppHeadline } from "@/lib/domain/ppp-public-badge";

describe("buildPppDisclaimerLine", () => {
  it("interpolates petName and breed into the disclaimer copy", () => {
    const result = buildPppDisclaimerLine("Luna", "Pit Bull");
    expect(result).toContain("Luna");
    expect(result).toContain("Pit Bull");
    expect(result).toContain("Ley CABA 4078");
    expect(result).toContain("Ley Prov 14.107");
  });

  it("omits breed parenthetical when breed is null", () => {
    const result = buildPppDisclaimerLine("Coco", null);
    expect(result).toContain("Coco");
    expect(result).not.toContain("(");
    expect(result).toContain("Ley CABA 4078");
  });

  it("omits breed parenthetical when breed is empty string", () => {
    const result = buildPppDisclaimerLine("Rex", "");
    expect(result).not.toContain("(");
  });
});

describe("buildPppHeadline", () => {
  it("returns the PPP warning headline", () => {
    const headline = buildPppHeadline();
    expect(headline).toContain("Potencialmente Peligroso");
    expect(headline).toContain("PPP");
  });
});

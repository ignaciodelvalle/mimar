import { describe, expect, it } from "vitest";

import { type CasePetLinkRole, casePetLink } from "@/components/casos/case-pet-link";

describe("casePetLink — operators go to the public credential, owners to their surface", () => {
  const OPERATOR_ROLES: CasePetLinkRole[] = ["admin", "govt", "vet"];

  it("A3 regression: operators get /p/<token>, NOT the owner-only /mis-mascotas surface", () => {
    for (const role of OPERATOR_ROLES) {
      expect(casePetLink("PANO-045778", role)).toBe("/p/PANO-045778");
    }
  });

  it("the owner keeps the /mis-mascotas deep link (it IS their pet)", () => {
    expect(casePetLink("PANO-045778", "owner")).toBe("/mis-mascotas/PANO-045778");
  });

  it("returns null when the case has no linked pet", () => {
    expect(casePetLink(null, "admin")).toBeNull();
    expect(casePetLink(undefined, "owner")).toBeNull();
  });
});

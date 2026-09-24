// Who is OFFERED the RUPPPA export on the owner page (L-11). The use-case keeps
// its own checks; this pins what the page shows. Values are stated here, not
// derived from the module's constants, so a changed constant fails the test.

import { describe, expect, it } from "vitest";

import { pppExportAvailability } from "./ppp-export-eligibility";

describe("pppExportAvailability", () => {
  it("offers the export to the legal owner of a PPP dog in CABA", () => {
    expect(
      pppExportAvailability({
        isLegalOwner: true,
        potentiallyDangerousBreed: true,
        jurisdictionProvince: "CABA",
      }),
    ).toEqual({ kind: "available" });
  });

  it("outside CABA it says why not, instead of hiding the question", () => {
    const result = pppExportAvailability({
      isLegalOwner: true,
      potentiallyDangerousBreed: true,
      jurisdictionProvince: "Buenos Aires",
    });
    expect(result?.kind).toBe("unavailable");
    expect(result?.kind === "unavailable" && result.reason).toContain("Ciudad de Buenos Aires");
  });

  it("an unknown jurisdiction is not CABA", () => {
    expect(
      pppExportAvailability({
        isLegalOwner: true,
        potentiallyDangerousBreed: true,
        jurisdictionProvince: null,
      })?.kind,
    ).toBe("unavailable");
  });

  it("shows nothing to someone who is not the legal owner (foster, vet, shelter)", () => {
    expect(
      pppExportAvailability({
        isLegalOwner: false,
        potentiallyDangerousBreed: true,
        jurisdictionProvince: "CABA",
      }),
    ).toBeNull();
  });

  it("shows nothing for a dog that is not flagged potentially dangerous", () => {
    expect(
      pppExportAvailability({
        isLegalOwner: true,
        potentiallyDangerousBreed: false,
        jurisdictionProvince: "CABA",
      }),
    ).toBeNull();
    expect(
      pppExportAvailability({
        isLegalOwner: true,
        potentiallyDangerousBreed: null,
        jurisdictionProvince: "CABA",
      }),
    ).toBeNull();
  });
});

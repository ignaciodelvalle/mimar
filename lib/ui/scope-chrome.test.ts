// lib/ui/scope-chrome.test.ts — unit tests for describeMandate (C3, ONE
// VIEWSCOPE). Pure function, no DB — mirrors lib/metrics/context.test.ts's
// style for the sibling censusEligibleProvince tests.

import { describe, expect, it } from "vitest";

import { describeMandate } from "@/lib/ui/scope-chrome";

describe("describeMandate", () => {
  it("no assignments → honest empty-scope copy", () => {
    expect(describeMandate([])).toBe("Sin localidades asignadas");
  });

  it("one WHOLE-PROVINCE assignment (two-tier canonical form) → bare province name", () => {
    // CABA's whole-city entry — must read "CABA", never a locality-shaped
    // "Ciudad Autónoma de Buenos Aires, CABA" (the verified S3 example).
    expect(
      describeMandate([{ province: "CABA", locality: "Ciudad Autónoma de Buenos Aires" }]),
    ).toBe("CABA");
  });

  it("one WHOLE-PROVINCE assignment (generic locality === '' form) → bare province name", () => {
    expect(describeMandate([{ province: "Buenos Aires", locality: "" }])).toBe("Buenos Aires");
  });

  it("one SPECIFIC locality → 'locality, province'", () => {
    expect(describeMandate([{ province: "CABA", locality: "Palermo" }])).toBe("Palermo, CABA");
  });

  it("multiple localities, all one province → 'N localidades · province'", () => {
    const jurisdictions = [
      { province: "CABA", locality: "Palermo" },
      { province: "CABA", locality: "Recoleta" },
      { province: "CABA", locality: "Retiro" },
      { province: "CABA", locality: "San Nicolás" },
      { province: "CABA", locality: "Puerto Madero" },
    ];
    expect(describeMandate(jurisdictions)).toBe("5 localidades · CABA");
  });

  it("multiple localities across several provinces → 'N localidades · M provincias'", () => {
    const jurisdictions = [
      { province: "CABA", locality: "Palermo" },
      { province: "Córdoba", locality: "" },
    ];
    expect(describeMandate(jurisdictions)).toBe("2 localidades · 2 provincias");
  });

  it("exactly TWO localities in one province uses singular-safe pluralization", () => {
    const jurisdictions = [
      { province: "Santa Fe", locality: "Rosario" },
      { province: "Santa Fe", locality: "Santa Fe" },
    ];
    expect(describeMandate(jurisdictions)).toBe("2 localidades · Santa Fe");
  });
});

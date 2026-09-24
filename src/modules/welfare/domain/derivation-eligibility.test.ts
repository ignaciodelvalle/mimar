// #48 — sanitary_authority is a valid welfare-derivation recipient (PO-approved).
// A regulator is the natural fiscalización recipient alongside custody orgs.
// Both the derivation-target gate (deriveWelfareToOrgAction) and the
// intervention-access mirror (requireOrgInterventionAccess) read this rule, so
// this pins the eligibility set once for both.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { WELFARE_DERIVATION_ORG_TYPES, canReceiveDerivedWelfare } from "./derivation-eligibility";

describe("canReceiveDerivedWelfare — derivation-target eligibility (#48)", () => {
  it("accepts sanitary_authority (a regulator is the natural fiscalización recipient)", () => {
    expect(canReceiveDerivedWelfare("sanitary_authority")).toBe(true);
  });

  it("still accepts the custody orgs (shelter / rescue_network)", () => {
    expect(canReceiveDerivedWelfare("shelter")).toBe(true);
    expect(canReceiveDerivedWelfare("rescue_network")).toBe(true);
  });

  it("still REJECTS non-eligible org types (clinic / other / unknown)", () => {
    expect(canReceiveDerivedWelfare("clinic")).toBe(false);
    expect(canReceiveDerivedWelfare("other")).toBe(false);
    expect(canReceiveDerivedWelfare("")).toBe(false);
    expect(canReceiveDerivedWelfare("admin")).toBe(false);
  });

  it("the eligible set is exactly the three expected types (no accidental widening)", () => {
    expect([...WELFARE_DERIVATION_ORG_TYPES].sort()).toEqual(
      ["rescue_network", "sanitary_authority", "shelter"].sort(),
    );
  });
});

// Both coupled gates must route through the shared rule — the derivation-target
// check AND its intervention-access mirror — so widening the recipient set (#48)
// can never leave the two out of sync. They no longer live in the same file: the
// target check moved to infrastructure/derive-to-org-writer.ts with the rest of
// the derivation body, so each gate is pinned in ITS OWN file (stronger than the
// old ">= 2 hits in actions.ts" count, which one file could satisfy alone).
describe("welfare gates route through canReceiveDerivedWelfare", () => {
  const welfareFile = (...segments: string[]) =>
    readFileSync(join(process.cwd(), "src", "modules", "welfare", ...segments), "utf8");

  const actionsSrc = welfareFile("actions.ts");
  const writerSrc = welfareFile("infrastructure", "derive-to-org-writer.ts");

  it("the derivation-target gate uses the shared rule", () => {
    expect(writerSrc).toMatch(/canReceiveDerivedWelfare\(/);
  });

  it("the intervention-access mirror uses the shared rule", () => {
    expect(actionsSrc).toMatch(/canReceiveDerivedWelfare\(/);
  });

  it("neither hardcodes the old two-type check", () => {
    const hardcoded = 'orgType !== "shelter" && targetOrg.orgType !== "rescue_network"';
    expect(actionsSrc).not.toContain(hardcoded);
    expect(writerSrc).not.toContain(hardcoded);
  });
});

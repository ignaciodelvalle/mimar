// The bite gate, arm by arm — and specifically what each arm actually proves.
//
// WHY THIS FILE EXISTS (fresh-context review of 698e7ea3..40d64c41, 2026-08-22,
// finding U3): the CRITICAL the gate was written for IS closed — there is no
// self-service path to `organizations.verified`. But the reviewer walked the
// SECOND conjunct and found both of its arms mintable by the reporting org:
//
//   - the incident zone arrives from the attacker's own form
//     (surveillance/actions.ts, the LocalityPickerAcross / map-pin fields);
//   - `addCoverageZoneAction` let any admin/coordinator add ANY province
//     (locality null = province-wide) with NO check that the org works there —
//     `add-coverage-zone.ts` validates only that the province exists and that
//     the locality belongs to it.
//
// So `verified AND (petRelation OR incidentZone ⊆ orgCoverage)` reduced to
// `verified AND (self-asserted claim)`, and the module comment's own example —
// "a verified shelter in Ushuaia would still be able to open an observation on
// a pet in Salta it has never seen" — was FALSE as written: Ushuaia only had to
// add Salta to its own coverage list first.
//
// THE FIX, and why this field: `organizations.jurisdiction_province` is set ONCE
// at creation and is excluded from every update path BY TYPE, not by convention
// — `OrgRepository.updateOrgProfile` accepts a Pick<> that does not contain it
// (org-repository.ts) and `UpdateOrganizationFields` cannot express it
// (update-organization.ts). No admin write path touches it either. It is
// therefore the jurisdiction a government SAW when it verified the org, and the
// org cannot move it afterwards. Binding the coverage arm to it converts a
// self-asserted claim into one anchored to the verification.
//
// The relation arm is NOT tightened here, and the module comment now says what
// it really guarantees instead of implying more.

import { describe, expect, it } from "vitest";

import { assertOrgMayReportBite } from "../bite-authority";

const SALTA = { province: "Salta", locality: "Salta" };
const USHUAIA_ORG = "Tierra del Fuego";

/** The org declared province-wide coverage of Salta from its own console. */
const SELF_ASSERTED_SALTA = [{ jurisdictionProvince: "Salta", jurisdictionLocality: null }];

describe("assertOrgMayReportBite — the verification gate", () => {
  it("refuses an unverified org outright", () => {
    const result = assertOrgMayReportBite({
      orgVerified: false,
      orgJurisdictionProvince: "Salta",
      hasPetRelation: true,
      coverageAreas: SELF_ASSERTED_SALTA,
      incidentZone: SALTA,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("no está verificada");
  });
});

describe("assertOrgMayReportBite — the coverage arm is anchored to the verified jurisdiction", () => {
  it("REGRESSION: an Ushuaia org cannot reach Salta by adding Salta to its own coverage", () => {
    const result = assertOrgMayReportBite({
      orgVerified: true,
      orgJurisdictionProvince: USHUAIA_ORG,
      hasPetRelation: false,
      // Self-minted: addCoverageZoneAction accepts any province.
      coverageAreas: SELF_ASSERTED_SALTA,
      incidentZone: SALTA,
    });
    expect(result.ok).toBe(false);
  });

  it("keeps the org's authority INSIDE the province it was verified in", () => {
    const result = assertOrgMayReportBite({
      orgVerified: true,
      orgJurisdictionProvince: "Salta",
      hasPetRelation: false,
      coverageAreas: SELF_ASSERTED_SALTA,
      incidentZone: SALTA,
    });
    expect(result.ok).toBe(true);
  });

  it("still honours a narrower coverage row inside the verified province", () => {
    const covers = [{ jurisdictionProvince: "Salta", jurisdictionLocality: "Salta" }];
    expect(
      assertOrgMayReportBite({
        orgVerified: true,
        orgJurisdictionProvince: "Salta",
        hasPetRelation: false,
        coverageAreas: covers,
        incidentZone: SALTA,
      }).ok,
    ).toBe(true);
    // A different locality of the SAME province is still outside a locality row.
    expect(
      assertOrgMayReportBite({
        orgVerified: true,
        orgJurisdictionProvince: "Salta",
        hasPetRelation: false,
        coverageAreas: covers,
        incidentZone: { province: "Salta", locality: "Cafayate" },
      }).ok,
    ).toBe(false);
  });

  it("an org with NO verified jurisdiction has no coverage authority to anchor", () => {
    // Nullable column, and a reachable state. Without an anchor the coverage
    // list is pure self-assertion, which is the hole this closes — so the arm
    // denies rather than falling back to trusting the list.
    const result = assertOrgMayReportBite({
      orgVerified: true,
      orgJurisdictionProvince: null,
      hasPetRelation: false,
      coverageAreas: SELF_ASSERTED_SALTA,
      incidentZone: SALTA,
    });
    expect(result.ok).toBe(false);
  });

  it("an incident with no province cannot match anything", () => {
    const result = assertOrgMayReportBite({
      orgVerified: true,
      orgJurisdictionProvince: "Salta",
      hasPetRelation: false,
      coverageAreas: SELF_ASSERTED_SALTA,
      incidentZone: { province: null, locality: null },
    });
    expect(result.ok).toBe(false);
  });
});

describe("assertOrgMayReportBite — the relation arm is untouched", () => {
  it("a clinic that attended the animal may report wherever the bite happened", () => {
    // The REAL flow the disjunction exists for, and deliberately still open:
    // historical attendance, no coverage anywhere near the incident.
    const result = assertOrgMayReportBite({
      orgVerified: true,
      orgJurisdictionProvince: USHUAIA_ORG,
      hasPetRelation: true,
      coverageAreas: [],
      incidentZone: SALTA,
    });
    expect(result.ok).toBe(true);
  });

  it("the relation arm does not need a jurisdiction anchor either", () => {
    const result = assertOrgMayReportBite({
      orgVerified: true,
      orgJurisdictionProvince: null,
      hasPetRelation: true,
      coverageAreas: [],
      incidentZone: SALTA,
    });
    expect(result.ok).toBe(true);
  });
});

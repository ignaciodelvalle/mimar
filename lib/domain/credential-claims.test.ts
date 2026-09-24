// deriveCredentialRegistryClaim — ADR-7 credential claim tiering (spec CT1/CT2).
//
// CT1: the public credential must not imply state registration in a province
// with no registry rule backing the claim. CT2: mandatory + registry-backed
// preserves the existing full "Identidad registrada" language.

import { describe, expect, it } from "vitest";

import {
  IDENTITY_HEADING_NEUTRAL,
  IDENTITY_HEADING_REGISTRY_BACKED,
  deriveCredentialRegistryClaim,
} from "@/lib/domain/credential-claims";

const MATCHED = { id: "rule-1", country: "AR", province: "CABA", locality: null };

// Identification fixtures (M4). The rule half of the claim is what the older
// cases exercise, so they all pass a pet that IS identified — the claim's
// second half gets its own scenarios below.
const CHIPPED = { hasMicrochip: true, hasTattoo: false };
const UNIDENTIFIED = { hasMicrochip: false, hasTattoo: false };
const TATTOOED_ONLY = { hasMicrochip: false, hasTattoo: true };

describe("deriveCredentialRegistryClaim — CT scenario table", () => {
  it("no rule resolved (default path) → neutral, no state-registration claim (CT1)", () => {
    // Even a payload claiming required:true must never back the full claim
    // without a matched row — a default is not a law of the pet's province.
    // (The real default payload is {required: false}: no Argentine norm
    // mandates the chip, so silence in the cascade means not_regulated. The
    // harder shape is pinned here on purpose.)
    const claim = deriveCredentialRegistryClaim(
      { payload: { required: true }, matchedRow: null },
      CHIPPED,
    );
    expect(claim.registryBacked).toBe(false);
    expect(claim.identityHeading).toBe(IDENTITY_HEADING_NEUTRAL);
  });

  it("null rule (degraded caller) → neutral", () => {
    const claim = deriveCredentialRegistryClaim(null, CHIPPED);
    expect(claim.registryBacked).toBe(false);
    expect(claim.identityHeading).toBe(IDENTITY_HEADING_NEUTRAL);
  });

  it("mandatory + registry-backed → full existing claim preserved (CT2)", () => {
    const claim = deriveCredentialRegistryClaim(
      {
        requirementLevel: "mandatory",
        payload: { required: true },
        matchedRow: MATCHED,
      },
      CHIPPED,
    );
    expect(claim.registryBacked).toBe(true);
    expect(claim.identityHeading).toBe(IDENTITY_HEADING_REGISTRY_BACKED);
    expect(claim.identityHeading).toBe("Identidad registrada");
  });

  it("matched row with not_regulated tier → neutral", () => {
    const claim = deriveCredentialRegistryClaim(
      {
        requirementLevel: "not_regulated",
        payload: { required: true },
        matchedRow: MATCHED,
      },
      CHIPPED,
    );
    expect(claim.registryBacked).toBe(false);
    expect(claim.identityHeading).toBe(IDENTITY_HEADING_NEUTRAL);
  });

  it("matched row with recommended tier → neutral (only mandatory backs the claim)", () => {
    const claim = deriveCredentialRegistryClaim(
      {
        requirementLevel: "recommended",
        payload: { required: true },
        matchedRow: MATCHED,
      },
      CHIPPED,
    );
    expect(claim.registryBacked).toBe(false);
  });

  it("matched pre-tier row (NULL tier) follows the OR5 boolean gate", () => {
    expect(
      deriveCredentialRegistryClaim(
        {
          requirementLevel: null,
          payload: { required: true },
          matchedRow: MATCHED,
        },
        CHIPPED,
      ).registryBacked,
    ).toBe(true);
    expect(
      deriveCredentialRegistryClaim(
        {
          requirementLevel: null,
          payload: { required: false },
          matchedRow: MATCHED,
        },
        CHIPPED,
      ).registryBacked,
    ).toBe(false);
  });

  // T6 review M4 — the rule proves an obligation exists, not that THIS animal
  // is in any registry. Keyed on the rule alone, the claim was inverted.
  it("mandatory rule but NO identifier on record → neutral (the M4 inversion)", () => {
    const claim = deriveCredentialRegistryClaim(
      {
        requirementLevel: "mandatory",
        payload: { required: true },
        matchedRow: MATCHED,
      },
      UNIDENTIFIED,
    );
    expect(claim.registryBacked).toBe(false);
    // The public page renders "Microchip: No" right under this heading — the
    // unqualified claim would contradict the field directly below it.
    expect(claim.identityHeading).toBe(IDENTITY_HEADING_NEUTRAL);
  });

  it("a tattoo alone satisfies the identification half — the claim is about IDENTITY", () => {
    const claim = deriveCredentialRegistryClaim(
      {
        requirementLevel: "mandatory",
        payload: { required: true },
        matchedRow: MATCHED,
      },
      TATTOOED_ONLY,
    );
    expect(claim.registryBacked).toBe(true);
    expect(claim.identityHeading).toBe(IDENTITY_HEADING_REGISTRY_BACKED);
  });

  it("identified pet in a jurisdiction with NO rule stays neutral — both halves are required", () => {
    const claim = deriveCredentialRegistryClaim(
      { requirementLevel: null, payload: { required: true }, matchedRow: null },
      CHIPPED,
    );
    expect(claim.registryBacked).toBe(false);
    expect(claim.identityHeading).toBe(IDENTITY_HEADING_NEUTRAL);
  });

  it("the neutral heading scopes the claim to miMAR and never mentions the state", () => {
    expect(IDENTITY_HEADING_NEUTRAL).toBe("Identidad registrada en miMAR");
    expect(IDENTITY_HEADING_NEUTRAL).not.toMatch(/estado|oficial|nacional/i);
    expect(IDENTITY_HEADING_NEUTRAL).not.toBe(IDENTITY_HEADING_REGISTRY_BACKED);
  });
});

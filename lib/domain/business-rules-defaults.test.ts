// microchipObligationApplies — the OR5 consumer gate (jurisdiction-compliance
// WU1, migration 0183). Two contracts pinned here:
//
// 1. PARITY: while no tier is set (every pre-0183 row, and the hardcoded
//    default), the gate MUST behave exactly like the boolean expression it
//    replaced (`payload.required !== false`) at both call sites (pet-profile
//    resolution, owner-dashboard batch gate) — zero behavior diff per ROW.
// 2. SUPERSESSION: once a tier IS set, it wins over the boolean — only
//    `mandatory` gates the obligation on.
//
// RG2 (PO-ratified 2026-08-16): the DEFAULT payload flipped to
// {required: false} — when NO row resolves anywhere in the cascade the
// obligation is not claimed (not_regulated), instead of assumed-mandatory.
// This is a deliberate behavior change of the no-rule path ONLY; the per-row
// parity contract above is unchanged.

import { describe, expect, it } from "vitest";

import {
  BUSINESS_RULES_DEFAULTS,
  complianceRuleParams,
  microchipObligationApplies,
  microchipObligationRuleInfo,
  obligationRuleInfo,
} from "@/lib/domain/business-rules-defaults";

describe("microchipObligationApplies — parity with the pre-tier boolean gate", () => {
  it.each([
    [{ required: true }, true],
    [{ required: false }, false],
    [{} as { required?: boolean }, true], // absent boolean = legacy "applies"
  ])(
    "no tier set: payload %j gates exactly like `required !== false` (%s)",
    (payload, expected) => {
      const legacyGate = payload.required !== false;
      expect(legacyGate).toBe(expected);
      // undefined tier (default path — resolver matched no row)
      expect(microchipObligationApplies({ payload })).toBe(expected);
      // explicit null tier (a matched row that predates the backfill)
      expect(microchipObligationApplies({ requirementLevel: null, payload })).toBe(expected);
    },
  );

  it("the hardcoded default ({required: false}) gates OFF when nothing resolves — RG2 ratified 2026-08-16: no rule row means no claimed obligation", () => {
    expect(
      microchipObligationApplies({ payload: BUSINESS_RULES_DEFAULTS.microchip_required }),
    ).toBe(false);
  });

  it("the default maps to not_regulated through microchipObligationRuleInfo — the honest no-rule tier (RG2)", () => {
    expect(
      microchipObligationRuleInfo({ payload: BUSINESS_RULES_DEFAULTS.microchip_required })
        .requirementLevel,
    ).toBe("not_regulated");
  });
});

describe("microchipObligationApplies — a resolved tier supersedes the boolean", () => {
  it("mandatory gates ON even when the boolean says false (tier wins)", () => {
    expect(
      microchipObligationApplies({ requirementLevel: "mandatory", payload: { required: false } }),
    ).toBe(true);
  });

  it.each(["recommended", "not_regulated", "optional"] as const)(
    "%s gates OFF even when the boolean says true (only mandatory is an obligation)",
    (level) => {
      expect(
        microchipObligationApplies({ requirementLevel: level, payload: { required: true } }),
      ).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// Effective obligation info (WU3 — the CS1 threading mappers)
// ---------------------------------------------------------------------------

describe("obligationRuleInfo — effective tier + metadata mapping", () => {
  it("an explicit tier passes through, with legal metadata defaulted to null", () => {
    expect(obligationRuleInfo({ requirementLevel: "not_regulated" })).toEqual({
      requirementLevel: "not_regulated",
      legalBasis: null,
      authority: null,
      sourceUrl: null,
    });
  });

  it("NULL tier falls back to mandatory — the pre-tier surface behavior for rabies/sterilization", () => {
    expect(obligationRuleInfo({ requirementLevel: null }).requirementLevel).toBe("mandatory");
    expect(obligationRuleInfo({}).requirementLevel).toBe("mandatory");
  });

  it("carries the resolved row's legal provenance verbatim", () => {
    expect(
      obligationRuleInfo({
        requirementLevel: "mandatory",
        legalBasis: "Ley 22.953",
        authority: "GCBA",
        sourceUrl: "https://example.gob.ar",
      }),
    ).toEqual({
      requirementLevel: "mandatory",
      legalBasis: "Ley 22.953",
      authority: "GCBA",
      sourceUrl: "https://example.gob.ar",
    });
  });
});

describe("microchipObligationRuleInfo — OR5 parity with microchipObligationApplies", () => {
  // The obligation-gate parity theorem: for every rule shape, "effective tier
  // is mandatory" must coincide exactly with the boolean gate — otherwise the
  // panel and the (retired) boolean path could disagree mid-migration.
  it.each([
    [{ payload: { required: true } }],
    [{ payload: { required: false } }],
    [{ payload: {} as { required?: boolean } }],
    [{ requirementLevel: null, payload: { required: true } }],
    [{ requirementLevel: "mandatory", payload: { required: false } }],
    [{ requirementLevel: "recommended", payload: { required: true } }],
    [{ requirementLevel: "not_regulated", payload: { required: true } }],
    [{ requirementLevel: "optional", payload: { required: true } }],
  ] as const)("parity holds for %j", (rule) => {
    expect(microchipObligationRuleInfo(rule).requirementLevel === "mandatory").toBe(
      microchipObligationApplies(rule),
    );
  });

  it("an explicit non-mandatory tier passes through (recommended stays recommended, not not_regulated)", () => {
    expect(
      microchipObligationRuleInfo({ requirementLevel: "recommended", payload: { required: true } })
        .requirementLevel,
    ).toBe("recommended");
  });

  it("NULL tier + required:false maps to not_regulated (the boolean opt-out)", () => {
    expect(microchipObligationRuleInfo({ payload: { required: false } }).requirementLevel).toBe(
      "not_regulated",
    );
  });
});

// T1-G1 — the payload half of the rabies + sterilization rules reaches the
// compliance projection. Each field is mapped from ITS OWN key (distinct
// values, so a swapped key fails), and the empty defaults claim nothing.
describe("complianceRuleParams — payload fields the projection computes with", () => {
  it("maps each operational field from its own payload key", () => {
    expect(
      complianceRuleParams(
        {
          payload: {
            frequency_months: 12,
            min_age_months: 3,
            frequency_legal_basis: "  Norma de cadencia  ",
          },
        },
        { payload: { min_age_months: 5, mandatory_from_months: 7 } },
      ),
    ).toEqual({
      rabies: { frequencyMonths: 12, minAgeMonths: 3, frequencyLegalBasis: "Norma de cadencia" },
      sterilization: { minAgeMonths: 5, mandatoryFromMonths: 7 },
    });
  });

  it("the empty defaults map to nulls — nothing derived without a rule row", () => {
    expect(
      complianceRuleParams(
        { payload: BUSINESS_RULES_DEFAULTS.rabies_vaccination },
        { payload: BUSINESS_RULES_DEFAULTS.sterilization },
      ),
    ).toEqual({
      rabies: { frequencyMonths: null, minAgeMonths: null, frequencyLegalBasis: null },
      sterilization: { minAgeMonths: null, mandatoryFromMonths: null },
    });
  });
});

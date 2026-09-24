import { describe, expect, it } from "vitest";

import { GOVT_BUSINESS_RULE_TYPES } from "@/db";
import { BUSINESS_RULES_DEFAULTS } from "@/lib/domain/business-rules-defaults";
import {
  RULE_TYPE_REGISTRY,
  getRuleTypeDef,
  summarizeRulePayload,
} from "@/lib/domain/rule-types-registry";
import { BUSINESS_RULE_VALIDATORS } from "@/lib/infra/business-rules-validators";

describe("RULE_TYPE_REGISTRY (shape parity — zero behavior diff)", () => {
  it("has exactly one entry per currently-live GOVT_BUSINESS_RULE_TYPES value", () => {
    for (const ruleType of GOVT_BUSINESS_RULE_TYPES) {
      expect(RULE_TYPE_REGISTRY[ruleType]).toBeDefined();
      expect(RULE_TYPE_REGISTRY[ruleType].id).toBe(ruleType);
    }
  });

  it("enumerates 13 rule types after migration 0183 (10 pre-existing + rabies_vaccination + sterilization + compliance_targets)", () => {
    // NOTE: the DB CHECK is wider (14) — travel_corridor_requirements exists
    // in the constraint but not in the TS enum (migration-errata.md).
    expect(GOVT_BUSINESS_RULE_TYPES).toHaveLength(13);
    expect(Object.keys(RULE_TYPE_REGISTRY)).toHaveLength(13);
    expect(GOVT_BUSINESS_RULE_TYPES).toEqual(
      expect.arrayContaining(["rabies_vaccination", "sterilization", "compliance_targets"]),
    );
  });

  it("every registry schema is the SAME instance as BUSINESS_RULE_VALIDATORS (single source of truth)", () => {
    for (const ruleType of GOVT_BUSINESS_RULE_TYPES) {
      expect(RULE_TYPE_REGISTRY[ruleType].schema).toBe(BUSINESS_RULE_VALIDATORS[ruleType]);
    }
  });

  it("every registry default matches BUSINESS_RULES_DEFAULTS exactly", () => {
    for (const ruleType of GOVT_BUSINESS_RULE_TYPES) {
      expect(RULE_TYPE_REGISTRY[ruleType].default).toEqual(BUSINESS_RULES_DEFAULTS[ruleType]);
    }
  });

  it("getRuleTypeDef returns the same object as a direct lookup", () => {
    for (const ruleType of GOVT_BUSINESS_RULE_TYPES) {
      expect(getRuleTypeDef(ruleType)).toBe(RULE_TYPE_REGISTRY[ruleType]);
    }
  });
});

describe("parseFromForm (zero behavior diff vs pre-registry parseRulePayloadFromForm)", () => {
  it("ppp_breed_list: trims + drops empties, preserves order", () => {
    const fd = new FormData();
    fd.append("breeds", " Pit Bull Terrier ");
    fd.append("breeds", "");
    fd.append("breeds", "Rottweiler");
    expect(getRuleTypeDef("ppp_breed_list").parseFromForm(fd)).toEqual({
      breeds: ["Pit Bull Terrier", "Rottweiler"],
    });
  });

  it("ppp_weight_threshold: empty kg -> null, checkbox 'on' -> true", () => {
    const fd = new FormData();
    fd.append("kg", "");
    expect(getRuleTypeDef("ppp_weight_threshold").parseFromForm(fd)).toEqual({
      kg: null,
      appliesIfBreedNotPPP: false,
    });

    const fd2 = new FormData();
    fd2.append("kg", "25.5");
    fd2.append("appliesIfBreedNotPPP", "on");
    expect(getRuleTypeDef("ppp_weight_threshold").parseFromForm(fd2)).toEqual({
      kg: 25.5,
      appliesIfBreedNotPPP: true,
    });
  });

  it("ppp_attestation_required_registries: parses registriesJson, drops malformed entries", () => {
    const fd = new FormData();
    fd.append(
      "registriesJson",
      JSON.stringify([
        { id: "renapa", label: "RENAPA", required: true },
        { id: "", label: "dropped (no id)", required: false },
      ]),
    );
    expect(getRuleTypeDef("ppp_attestation_required_registries").parseFromForm(fd)).toEqual({
      registries: [{ id: "renapa", label: "RENAPA", required: true }],
    });
  });

  it("physical_credential_channels: parses printable_qr + per-channel provider fields", () => {
    const fd = new FormData();
    fd.append("printable_qr", "on");
    fd.append("enabled_engraved_plate", "on");
    fd.append("provider_name_engraved_plate", "Grabados SA");
    fd.append("provider_url_engraved_plate", "https://grabados.example");
    expect(getRuleTypeDef("physical_credential_channels").parseFromForm(fd)).toEqual({
      printable_qr: true,
      engraved_plate: {
        enabled: true,
        providerName: "Grabados SA",
        providerUrl: "https://grabados.example",
      },
      nfc_tag: { enabled: false },
    });
  });

  it.each([
    ["rabies_observation_window", "days"],
    ["due_soon_window", "days"],
    ["long_stay_days", "days"],
  ] as const)("%s: parses the %s field, NaN/empty -> 0", (ruleType, fieldName) => {
    const fd = new FormData();
    fd.append(fieldName, "21");
    expect(getRuleTypeDef(ruleType).parseFromForm(fd)).toEqual({ [fieldName]: 21 });

    const empty = new FormData();
    expect(getRuleTypeDef(ruleType).parseFromForm(empty)).toEqual({ [fieldName]: 0 });
  });

  it("reminder_windows: parses aheadDays", () => {
    const fd = new FormData();
    fd.append("aheadDays", "7");
    expect(getRuleTypeDef("reminder_windows").parseFromForm(fd)).toEqual({
      aheadDays: 7,
    });
  });
});

describe("promoted rule types — validator strictness (R4.1)", () => {
  it("rejects out-of-range days for each promoted day-count type", () => {
    for (const ruleType of [
      "rabies_observation_window",
      "due_soon_window",
      "long_stay_days",
    ] as const) {
      const tooLow = RULE_TYPE_REGISTRY[ruleType].schema.safeParse({ days: 0 });
      expect(tooLow.success).toBe(false);
      const ok = RULE_TYPE_REGISTRY[ruleType].schema.safeParse({ days: 15 });
      expect(ok.success).toBe(true);
    }
  });

  it("rejects unknown fields (strict mode) on reminder_windows", () => {
    const r = RULE_TYPE_REGISTRY.reminder_windows.schema.safeParse({
      aheadDays: 14,
      extra: true,
    });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Obligation rule types (jurisdiction-compliance WU1, migration 0183). The
// tier + legal provenance are table COLUMNS, not payload fields — so these
// payloads are thin and all-optional, and {} (the default) MUST round-trip.
// ---------------------------------------------------------------------------
describe("obligation rule types — Zod round-trips (migration 0183)", () => {
  it.each(["rabies_vaccination", "sterilization", "compliance_targets"] as const)(
    "%s: {} (the honest-by-default payload) round-trips",
    (ruleType) => {
      const r = RULE_TYPE_REGISTRY[ruleType].schema.safeParse({});
      expect(r.success).toBe(true);
      if (r.success) expect(r.data).toEqual({});
    },
  );

  it("rabies_vaccination: accepts populated payload, rejects extra fields and out-of-range values", () => {
    const schema = RULE_TYPE_REGISTRY.rabies_vaccination.schema;
    const ok = schema.safeParse({ frequency_months: 12, min_age_months: 3 });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data).toEqual({ frequency_months: 12, min_age_months: 3 });
    expect(schema.safeParse({ frequency_months: 0 }).success).toBe(false);
    expect(schema.safeParse({ frequency_months: 12, extra: true }).success).toBe(false);
    // D5: the cadence's own citation — trimmed, non-blank, bounded.
    const cited = schema.safeParse({ frequency_months: 12, frequency_legal_basis: " Norma " });
    expect(cited.success).toBe(true);
    if (cited.success)
      expect(cited.data).toEqual({ frequency_months: 12, frequency_legal_basis: "Norma" });
    expect(schema.safeParse({ frequency_legal_basis: "   " }).success).toBe(false);
    expect(schema.safeParse({ frequency_legal_basis: "x".repeat(301) }).success).toBe(false);
  });

  it("sterilization: accepts populated payload, rejects extra fields and out-of-range values", () => {
    const schema = RULE_TYPE_REGISTRY.sterilization.schema;
    const ok = schema.safeParse({ min_age_months: 6, mandatory_from_months: 8 });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data).toEqual({ min_age_months: 6, mandatory_from_months: 8 });
    expect(schema.safeParse({ mandatory_from_months: 121 }).success).toBe(false);
    expect(schema.safeParse({ min_age_months: 6, extra: true }).success).toBe(false);
  });

  it("compliance_targets: PARTIAL record, each value clamped 0..100, unknown keys rejected", () => {
    const schema = RULE_TYPE_REGISTRY.compliance_targets.schema;
    const ok = schema.safeParse({ rabies_coverage_pct: 85, microchip_penetration_pct: 40.5 });
    expect(ok.success).toBe(true);
    expect(schema.safeParse({ rabies_coverage_pct: 101 }).success).toBe(false);
    expect(schema.safeParse({ rabies_coverage_pct: -1 }).success).toBe(false);
    expect(schema.safeParse({ adoption_rate_pct: 50 }).success).toBe(false);
  });

  it("parseFromForm: empty form -> {} (optional fields omitted, never 0-filled)", () => {
    for (const ruleType of ["rabies_vaccination", "sterilization", "compliance_targets"] as const) {
      expect(getRuleTypeDef(ruleType).parseFromForm(new FormData())).toEqual({});
    }
  });

  it("parseFromForm: populated fields parse, NaN/empty entries are dropped", () => {
    const rabies = new FormData();
    rabies.append("frequency_months", "12");
    rabies.append("min_age_months", "");
    rabies.append("frequency_legal_basis", "  Norma de cadencia ");
    expect(getRuleTypeDef("rabies_vaccination").parseFromForm(rabies)).toEqual({
      frequency_months: 12,
      frequency_legal_basis: "Norma de cadencia",
    });
    const blankBasis = new FormData();
    blankBasis.append("frequency_legal_basis", "   ");
    expect(getRuleTypeDef("rabies_vaccination").parseFromForm(blankBasis)).toEqual({});

    const sterilization = new FormData();
    sterilization.append("min_age_months", "6");
    sterilization.append("mandatory_from_months", "no-es-numero");
    expect(getRuleTypeDef("sterilization").parseFromForm(sterilization)).toEqual({
      min_age_months: 6,
    });

    const targets = new FormData();
    targets.append("rabies_coverage_pct", "85.5");
    targets.append("ppp_attestation_pct", "");
    expect(getRuleTypeDef("compliance_targets").parseFromForm(targets)).toEqual({
      rabies_coverage_pct: 85.5,
    });
  });
});

describe("summarizeRulePayload — rabies cadence citation (D5, PO 2026-09-18)", () => {
  it("names the norm next to the cadence only when the payload cites one", () => {
    expect(summarizeRulePayload("rabies_vaccination", { frequency_months: 12 })).toBe(
      "refuerzo cada 12 meses",
    );
    expect(
      summarizeRulePayload("rabies_vaccination", {
        frequency_months: 12,
        frequency_legal_basis: "Norma de cadencia",
      }),
    ).toBe("refuerzo cada 12 meses (Norma de cadencia)");
  });
});

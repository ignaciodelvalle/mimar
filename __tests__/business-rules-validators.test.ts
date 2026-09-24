// Tests for Zod validators per rule_type.
// Spec 2026-05-19-govt-business-rules-poc-design §4.4.

import { describe, expect, it } from "vitest";

import { validateRulePayload } from "@/lib/infra/business-rules-validators";

describe("ppp_breed_list", () => {
  it("accepts a breed array", () => {
    const r = validateRulePayload("ppp_breed_list", { breeds: ["Boxer", "Doberman"] });
    expect(r.ok).toBe(true);
  });
  it("accepts an empty breed array (intent: no PPP breeds locally)", () => {
    const r = validateRulePayload("ppp_breed_list", { breeds: [] });
    expect(r.ok).toBe(true);
  });
  it("rejects breeds-not-array", () => {
    const r = validateRulePayload("ppp_breed_list", { breeds: "Boxer" });
    expect(r.ok).toBe(false);
  });
  it("rejects empty breed name", () => {
    const r = validateRulePayload("ppp_breed_list", { breeds: [""] });
    expect(r.ok).toBe(false);
  });
  it("rejects extra keys (strict)", () => {
    const r = validateRulePayload("ppp_breed_list", { breeds: ["Boxer"], extra: 1 });
    expect(r.ok).toBe(false);
  });
  it("rejects more than 100 breeds", () => {
    const r = validateRulePayload("ppp_breed_list", {
      breeds: Array(101).fill("Boxer"),
    });
    expect(r.ok).toBe(false);
  });
});

describe("ppp_weight_threshold", () => {
  it("accepts numeric kg + bool", () => {
    const r = validateRulePayload("ppp_weight_threshold", {
      kg: 25,
      appliesIfBreedNotPPP: true,
    });
    expect(r.ok).toBe(true);
  });
  it("accepts null kg (no weight rule)", () => {
    const r = validateRulePayload("ppp_weight_threshold", {
      kg: null,
      appliesIfBreedNotPPP: false,
    });
    expect(r.ok).toBe(true);
  });
  it("rejects negative kg", () => {
    const r = validateRulePayload("ppp_weight_threshold", {
      kg: -1,
      appliesIfBreedNotPPP: false,
    });
    expect(r.ok).toBe(false);
  });
  it("rejects missing appliesIfBreedNotPPP", () => {
    const r = validateRulePayload("ppp_weight_threshold", { kg: 25 });
    expect(r.ok).toBe(false);
  });
});

describe("ppp_attestation_required_registries", () => {
  it("accepts registries array", () => {
    const r = validateRulePayload("ppp_attestation_required_registries", {
      registries: [{ id: "caba_4078", label: "Registro CABA 4078", required: true }],
    });
    expect(r.ok).toBe(true);
  });
  it("rejects registry missing id", () => {
    const r = validateRulePayload("ppp_attestation_required_registries", {
      registries: [{ label: "X", required: true }],
    });
    expect(r.ok).toBe(false);
  });
  it("rejects more than 20 registries", () => {
    const r = validateRulePayload("ppp_attestation_required_registries", {
      registries: Array(21).fill({ id: "x_id", label: "X", required: true }),
    });
    expect(r.ok).toBe(false);
  });
});

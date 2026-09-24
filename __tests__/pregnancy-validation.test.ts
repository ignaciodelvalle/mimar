// Zod schema validation tests for the pregnancy sub_kind extension to
// clinical_info_logged (spec 2026-05-19-pregnancy-tracking-design §4.2).

import { describe, expect, it } from "vitest";

import { validateEventPayload } from "@/lib/events/event-schemas";

const baseStarted = {
  sub_kind: "pregnancy" as const,
  pregnancy_phase: "started" as const,
  title: "Embarazo en seguimiento",
  details: null,
  performed_by: null,
};
const baseEnded = {
  sub_kind: "pregnancy" as const,
  pregnancy_phase: "ended" as const,
  title: "Fin del embarazo",
  details: null,
  performed_by: null,
};

describe("clinical_info_logged — pregnancy sub_kind", () => {
  it("accepts a valid pregnancy_started payload", () => {
    expect(() =>
      validateEventPayload("clinical_info_logged", {
        ...baseStarted,
        weeks_at_diagnosis: 4,
        vet_consulted: "Dr. Test",
      }),
    ).not.toThrow();
  });

  it("rejects pregnancy without pregnancy_phase", () => {
    expect(() =>
      validateEventPayload("clinical_info_logged", {
        sub_kind: "pregnancy",
        title: "no phase",
        details: null,
        performed_by: null,
      }),
    ).toThrow(/pregnancy_phase required/);
  });

  it("rejects pregnancy_started with outcome populated", () => {
    expect(() =>
      validateEventPayload("clinical_info_logged", {
        ...baseStarted,
        outcome: "live_birth",
      }),
    ).toThrow(/outcome not allowed/);
  });

  it("rejects pregnancy_ended without outcome", () => {
    expect(() =>
      validateEventPayload("clinical_info_logged", {
        ...baseEnded,
      }),
    ).toThrow(/outcome required/);
  });

  it("rejects live_births_count when outcome != live_birth", () => {
    expect(() =>
      validateEventPayload("clinical_info_logged", {
        ...baseEnded,
        outcome: "miscarriage",
        live_births_count: 3,
      }),
    ).toThrow(/live_births_count only valid/);
  });

  it("accepts live_births_count when outcome=live_birth", () => {
    expect(() =>
      validateEventPayload("clinical_info_logged", {
        ...baseEnded,
        outcome: "live_birth",
        live_births_count: 5,
      }),
    ).not.toThrow();
  });

  it("rejects weeks_at_diagnosis out of range", () => {
    expect(() =>
      validateEventPayload("clinical_info_logged", {
        ...baseStarted,
        weeks_at_diagnosis: 99,
      }),
    ).toThrow();
  });

  it("rejects live_births_count > 20", () => {
    expect(() =>
      validateEventPayload("clinical_info_logged", {
        ...baseEnded,
        outcome: "live_birth",
        live_births_count: 25,
      }),
    ).toThrow();
  });
});

describe("clinical_info_logged — disease_diagnosis still passes (regression guard)", () => {
  it("disease_diagnosis with valid disease_code does not require pregnancy fields", () => {
    expect(() =>
      validateEventPayload("clinical_info_logged", {
        sub_kind: "disease_diagnosis",
        title: "Diagnóstico",
        details: null,
        performed_by: "Dr X",
        performed_by_user_id: "11111111-2222-4333-8444-555555555555",
        disease_code: "leptospirosis",
        confirmed_by_lab: false,
        lab_name: null,
        lab_report_reference: null,
        diagnosis_date: new Date().toISOString(),
      }),
    ).not.toThrow();
  });
});

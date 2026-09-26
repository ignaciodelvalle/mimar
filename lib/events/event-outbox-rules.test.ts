// Unit tests for lib/event-outbox-rules.ts
//
// Strict TDD mode: tests written before implementation.
// Test runner: pnpm vitest

import { describe, expect, it } from "vitest";

import { describeEnoNotification } from "@/lib/infra/outbox-list";
import { getEnoDisease } from "@/src/modules/surveillance/domain/eno-catalog";
import { OUTBOX_RULES } from "./event-outbox-rules";

// ---------------------------------------------------------------------------
// clinical_info_logged — disease_diagnosis sub_kind
// ---------------------------------------------------------------------------

describe("OUTBOX_RULES[clinical_info_logged]", () => {
  const rules = OUTBOX_RULES.clinical_info_logged ?? [];

  it("has exactly one rule (govt_webhook)", () => {
    expect(rules).toHaveLength(1);
    expect(rules[0].target_kind).toBe("govt_webhook");
  });

  it("rabies_confirmed diagnosis → returns notifyHours (24) via ENO catalog bridge", () => {
    const rule = rules[0];
    const slaHours = rule.slaHours({
      sub_kind: "disease_diagnosis",
      disease_code: "rabies_confirmed", // diseases.ts code → ENO 'rabies' (24h)
    });
    expect(slaHours).toBe(24);
  });

  it("leptospirosis diagnosis → notifyHours (24, CVPBA «inmediata») from ENO catalog (direct match)", () => {
    const rule = rules[0];
    const slaHours = rule.slaHours({
      sub_kind: "disease_diagnosis",
      disease_code: "leptospirosis",
    });
    expect(slaHours).toBe(24);
  });

  it("unknown_disease diagnosis → returns null (no rule fires)", () => {
    const rule = rules[0];
    const slaHours = rule.slaHours({
      sub_kind: "disease_diagnosis",
      disease_code: "unknown_disease_xyz",
    });
    expect(slaHours).toBeNull();
  });

  it("non-disease sub_kind → returns null", () => {
    const rule = rules[0];
    const slaHours = rule.slaHours({
      sub_kind: "lab_work",
      disease_code: "rabies",
    });
    expect(slaHours).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// outbreak_signal
// ---------------------------------------------------------------------------

describe("OUTBOX_RULES[outbreak_signal]", () => {
  const rules = OUTBOX_RULES.outbreak_signal ?? [];

  it("has exactly one rule (govt_webhook)", () => {
    expect(rules).toHaveLength(1);
    expect(rules[0].target_kind).toBe("govt_webhook");
  });

  // PO S1 (2026-09-26): a signal the MATCHER derived from an owner's (or a
  // witness's) free text is a suspicion, not a notification — it pages the
  // authority in-app and never mints a legal ENO row. Only the signal a vet's
  // diagnosis derives stays on the legal queue.
  it("a matcher signal (owner symptom) → null, whatever the disease", () => {
    const rule = rules[0];
    for (const disease_code of ["rabies_suspected", "leptospirosis", "tuberculosis"]) {
      expect(rule.slaHours({ triggered_by: "matcher", disease_code })).toBeNull();
    }
  });

  it("a legacy signal with no triggered_by is a matcher signal → null", () => {
    expect(rules[0].slaHours({ disease_code: "rabies_suspected" })).toBeNull();
  });

  it("a diagnosis-derived signal with rabies_suspected (ENO 'rabies') → 24 hours", () => {
    const slaHours = rules[0].slaHours({
      triggered_by: "direct_diagnosis",
      disease_code: "rabies_suspected", // diseases.ts code → ENO 'rabies'
    });
    expect(slaHours).toBe(24);
  });

  it("a diagnosis-derived signal with leptospirosis (direct ENO match) → 24 hours", () => {
    const slaHours = rules[0].slaHours({
      triggered_by: "direct_diagnosis",
      disease_code: "leptospirosis",
    });
    expect(slaHours).toBe(24);
  });

  it("a diagnosis-derived signal with an unknown disease_code → null (no outbox row)", () => {
    const slaHours = rules[0].slaHours({
      triggered_by: "direct_diagnosis",
      disease_code: "not_in_catalog",
    });
    expect(slaHours).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// rabies_observation_ended — a POSITIVE close is a notifiable rabies case
// ---------------------------------------------------------------------------

describe("OUTBOX_RULES[rabies_observation_ended]", () => {
  const rules = OUTBOX_RULES.rabies_observation_ended ?? [];

  const endedPayload = (outcome: string) => ({
    bite_event_id: null,
    observation_started_event_id: "00000000-0000-4000-8000-000000000001",
    outcome,
    closed_by_role: "vet",
    closure_notes:
      "Salivación y agresividad desde ayer; el dueño de Firulais pidió que no se lo lleve",
    death_event_id: null,
  });

  it("has exactly one rule (govt_webhook) — the same channel as a rabies disease_diagnosis", () => {
    expect(rules).toHaveLength(1);
    expect(rules[0].target_kind).toBe("govt_webhook");
  });

  it("positive_rabies → the ENO catalog's rabies window (24h), not a hardcoded number", () => {
    expect(rules[0].slaHours(endedPayload("positive_rabies"))).toBe(
      getEnoDisease("rabies")?.notifyHours,
    );
    expect(rules[0].slaHours(endedPayload("positive_rabies"))).toBe(24);
  });

  it.each(["negative", "dead", "lost_to_followup", "unknown_outcome"])(
    "%s → null (no notifiable case, no outbox row)",
    (outcome) => {
      expect(rules[0].slaHours(endedPayload(outcome))).toBeNull();
    },
  );

  it("snapshot names the disease so the Cola ENO shows 'Rabia' with its legal window", () => {
    const snapshot = rules[0].buildSnapshot?.(endedPayload("positive_rabies"));
    expect(describeEnoNotification(snapshot)).toEqual({ diseaseLabel: "Rabia", legalHours: 24 });
  });

  it("snapshot drops closure_notes — PA-gated clinical prose never leaves in an authority payload", () => {
    const snapshot = rules[0].buildSnapshot?.(endedPayload("positive_rabies")) ?? {};
    expect(snapshot).not.toHaveProperty("closure_notes");
    expect(JSON.stringify(snapshot)).not.toContain("Firulais");
    expect(snapshot).toMatchObject({
      outcome: "positive_rabies",
      closed_by_role: "vet",
      observation_started_event_id: "00000000-0000-4000-8000-000000000001",
    });
  });
});

// ---------------------------------------------------------------------------
// death_recorded — PO S4 (2026-09-26): a death FROM a notifiable disease is an
// ENO, with that disease's window, only when a vet recorded it or the
// diagnosis is lab-confirmed. Rabies joins the animal's rabies case.
// ---------------------------------------------------------------------------

describe("OUTBOX_RULES[death_recorded] (S4)", () => {
  const rules = OUTBOX_RULES.death_recorded ?? [];
  const VET = { authorRole: "vet", authorVerified: true };
  const OWNER = { authorRole: "owner", authorVerified: false };
  const death = (over: Record<string, unknown> = {}) => ({
    cause: "disease",
    cause_detail: "Cuadro neurológico de 3 días; la familia de Toby pidió reserva",
    confirmed_by_vet: null,
    vet_name: "Dra. Pérez",
    disposition_method: null,
    facility: null,
    death_at_clinic: null,
    clinic_name: "Clínica X",
    vet_contacted_owner: null,
    vet_decided_alone: null,
    owner_to_private_crematorium: null,
    disease_code: "leptospirosis",
    confirmed_by_lab: false,
    is_reportable: true,
    ...over,
  });

  it("has exactly one rule (govt_webhook)", () => {
    expect(rules).toHaveLength(1);
    expect(rules[0].target_kind).toBe("govt_webhook");
  });

  it("recorded by a matriculated vet → the disease's window", () => {
    expect(rules[0].slaHours(death(), VET)).toBe(getEnoDisease("leptospirosis")?.notifyHours);
  });

  it("recorded by the owner with a lab-confirmed diagnosis → the disease's window", () => {
    expect(rules[0].slaHours(death({ confirmed_by_lab: true }), OWNER)).toBe(24);
  });

  it("recorded by the owner, unconfirmed → no ENO row (a declaration, not a diagnosis)", () => {
    expect(rules[0].slaHours(death(), OWNER)).toBeNull();
    // An unverified "vet" (no matrícula) is not a vet for this purpose.
    expect(rules[0].slaHours(death(), { authorRole: "vet", authorVerified: false })).toBeNull();
    // Nor is the owner's own "confirmed by a vet" checkbox.
    expect(rules[0].slaHours(death({ confirmed_by_vet: true }), OWNER)).toBeNull();
  });

  it("no disease, or a disease outside the ENO list → null", () => {
    expect(rules[0].slaHours(death({ disease_code: null }), VET)).toBeNull();
    expect(rules[0].slaHours(death({ disease_code: "parvovirus" }), VET)).toBeNull();
  });

  it("rabies (confirmed or suspected) names the rabies case — it merges, earliest deadline wins", () => {
    expect(rules[0].caseFamily?.(death({ disease_code: "rabies_confirmed" }))).toBe("rabies");
    expect(rules[0].caseFamily?.(death({ disease_code: "leptospirosis" }))).toBeNull();
  });

  it("the snapshot names the disease and carries no free text or names", () => {
    const snapshot = rules[0].buildSnapshot?.(death()) ?? {};
    expect(describeEnoNotification(snapshot)).toMatchObject({ diseaseLabel: "Leptospirosis" });
    const text = JSON.stringify(snapshot);
    expect(text).not.toContain("Toby");
    expect(text).not.toContain("Pérez");
    expect(text).not.toContain("Clínica X");
  });
});

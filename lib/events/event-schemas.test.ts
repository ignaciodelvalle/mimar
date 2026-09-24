// Tests for the refactored symptomObserved schema and the new outbreakSignal schema.
// Added in surveillance Fase 2.

import { describe, expect, it } from "vitest";

import { validateEventPayload } from "@/lib/events/event-schemas";

describe("symptomObserved payload schema (refactored)", () => {
  it("accepts libreta-source payload with null welfare_report_id", () => {
    expect(() =>
      validateEventPayload("symptom_observed", {
        source: "libreta",
        welfare_report_id: null,
        reporter_role: "owner",
        free_text: "vomita y tiene fiebre",
        matched_symptom_codes: ["vomiting", "high_fever"],
        alerted_disease_codes: [],
        severity_self_assessed: "moderate",
        onset_at: null,
      }),
    ).not.toThrow();
  });

  it("rejects libreta-source payload with welfare_report_id set", () => {
    expect(() =>
      validateEventPayload("symptom_observed", {
        source: "libreta",
        welfare_report_id: "550e8400-e29b-41d4-a716-446655440000",
        reporter_role: "owner",
        free_text: "vomita",
        matched_symptom_codes: [],
        alerted_disease_codes: [],
        severity_self_assessed: null,
        onset_at: null,
      }),
    ).toThrow();
  });

  it("accepts welfare_report-source payload with welfare_report_id", () => {
    expect(() =>
      validateEventPayload("symptom_observed", {
        source: "welfare_report",
        welfare_report_id: "550e8400-e29b-41d4-a716-446655440000",
        reporter_role: "witness",
        free_text: "el perro está flaco",
        matched_symptom_codes: [],
        alerted_disease_codes: [],
        severity_self_assessed: null,
        onset_at: null,
      }),
    ).not.toThrow();
  });

  it("rejects welfare_report-source payload without welfare_report_id", () => {
    expect(() =>
      validateEventPayload("symptom_observed", {
        source: "welfare_report",
        welfare_report_id: null,
        reporter_role: "witness",
        free_text: "...",
        matched_symptom_codes: [],
        alerted_disease_codes: [],
        severity_self_assessed: null,
        onset_at: null,
      }),
    ).toThrow();
  });
});

describe("outbreakSignal payload schema", () => {
  it("accepts a complete payload", () => {
    expect(() =>
      validateEventPayload("outbreak_signal", {
        source_symptom_event_id: "550e8400-e29b-41d4-a716-446655440000",
        disease_code: "rabies_suspected",
        disease_label: "Sospecha de rabia",
        match_strength: {
          high_count: 2,
          medium_count: 0,
          low_count: 1,
          matched_symptom_codes: ["hypersalivation", "aggression_unusual", "lethargy"],
        },
        pet_jurisdiction_country: "AR",
        pet_jurisdiction_province: "AR-C",
        pet_jurisdiction_locality: "Belgrano",
        pet_species: "dog",
      }),
    ).not.toThrow();
  });

  it("rejects extra keys (strict mode)", () => {
    expect(() =>
      validateEventPayload("outbreak_signal", {
        source_symptom_event_id: "550e8400-e29b-41d4-a716-446655440000",
        disease_code: "rabies_suspected",
        disease_label: "Sospecha de rabia",
        match_strength: {
          high_count: 1,
          medium_count: 0,
          low_count: 0,
          matched_symptom_codes: ["hypersalivation"],
        },
        pet_jurisdiction_country: "AR",
        pet_jurisdiction_province: null,
        pet_jurisdiction_locality: null,
        pet_species: "dog",
        unknown_field: "this should fail",
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Phase-2 catalog cleanup (2026-05-19) — coverage for the new umbrella events.
// ---------------------------------------------------------------------------

describe("foster_proposal_resolved payload schema", () => {
  it("accepts outcome=accepted with response_notes", () => {
    expect(
      validateEventPayload("foster_proposal_resolved", {
        proposal_public_token: "FP-AAAA-BBBB",
        outcome: "accepted",
        response_notes: "Encantada, lo busco el domingo.",
      }),
    ).toBeTruthy();
  });

  it("accepts outcome=rejected with rejection_reason + notes", () => {
    expect(
      validateEventPayload("foster_proposal_resolved", {
        proposal_public_token: "FP-AAAA-BBBB",
        outcome: "rejected",
        rejection_reason: "capacity",
        response_notes: "No tengo lugar para uno más este mes.",
      }),
    ).toBeTruthy();
  });

  it("accepts outcome=cancelled with cancellation_reason and auto_cancelled", () => {
    expect(
      validateEventPayload("foster_proposal_resolved", {
        proposal_public_token: "FP-AAAA-BBBB",
        outcome: "cancelled",
        cancellation_reason: "volunteer_accepted_another",
        auto_cancelled: true,
      }),
    ).toBeTruthy();
  });

  it("accepts outcome=expired with only proposal_public_token", () => {
    expect(
      validateEventPayload("foster_proposal_resolved", {
        proposal_public_token: "FP-AAAA-BBBB",
        outcome: "expired",
      }),
    ).toBeTruthy();
  });

  it("rejects unknown outcome value", () => {
    expect(() =>
      validateEventPayload("foster_proposal_resolved", {
        proposal_public_token: "FP-AAAA-BBBB",
        outcome: "what",
      }),
    ).toThrow();
  });

  it("rejects extra keys (strict)", () => {
    expect(() =>
      validateEventPayload("foster_proposal_resolved", {
        proposal_public_token: "FP-AAAA-BBBB",
        outcome: "accepted",
        bogus_field: 1,
      }),
    ).toThrow();
  });
});

describe("adoption_application_resolved payload schema", () => {
  const APP_ID = "550e8400-e29b-41d4-a716-446655440000";
  const REVIEWER_ID = "550e8400-e29b-41d4-a716-446655440001";

  it("accepts outcome=approved with notes only", () => {
    expect(
      validateEventPayload("adoption_application_resolved", {
        application_event_id: APP_ID,
        reviewer_user_id: REVIEWER_ID,
        outcome: "approved",
        notes: "Buen match, avanzamos.",
      }),
    ).toBeTruthy();
  });

  it("accepts outcome=rejected with reason + auto_generated=true (F5.5 cascade shape)", () => {
    expect(
      validateEventPayload("adoption_application_resolved", {
        application_event_id: APP_ID,
        reviewer_user_id: REVIEWER_ID,
        outcome: "rejected",
        reason: "another_application_finalized",
        auto_generated: true,
        notes: null,
      }),
    ).toBeTruthy();
  });

  it("rejects unknown outcome value", () => {
    expect(() =>
      validateEventPayload("adoption_application_resolved", {
        application_event_id: APP_ID,
        reviewer_user_id: REVIEWER_ID,
        outcome: "maybe",
      }),
    ).toThrow();
  });
});

describe("adoption_reversed payload schema", () => {
  it.each(["shelter", "adopter", "court"] as const)("accepts actor=%s", (actor) => {
    expect(
      validateEventPayload("adoption_reversed", {
        actor,
        reason: "test",
      }),
    ).toBeTruthy();
  });

  it("allows reverted_finalization_event_id null (pre-event-sourcing data)", () => {
    expect(
      validateEventPayload("adoption_reversed", {
        actor: "shelter",
        reason: null,
        reverted_finalization_event_id: null,
      }),
    ).toBeTruthy();
  });

  it("rejects unknown actor", () => {
    expect(() =>
      validateEventPayload("adoption_reversed", {
        actor: "stranger",
        reason: null,
      }),
    ).toThrow();
  });
});

describe("microchip_replaced payload schema (merged with revoked)", () => {
  it("accepts new_chip_number string (replacement branch)", () => {
    expect(
      validateEventPayload("microchip_replaced", {
        previous_chip_number: "111111111111111",
        new_chip_number: "222222222222222",
        reason: "damaged",
        replaced_by: "Vet Petlovers",
        replaced_at: "2026-05-19",
      }),
    ).toBeTruthy();
  });

  it("accepts new_chip_number null (revocation branch) with institutional actor", () => {
    expect(
      validateEventPayload("microchip_replaced", {
        previous_chip_number: "111111111111111",
        new_chip_number: null,
        reason: "fraud_detected",
        replaced_by: null,
        replaced_at: "2026-05-19",
        actor_role: "admin",
        actor_user_id: "550e8400-e29b-41d4-a716-446655440099",
        notes: "Two pets claiming the same chip.",
      }),
    ).toBeTruthy();
  });

  it("accepts reason values from both legacy enums", () => {
    for (const reason of [
      "damaged",
      "unreadable",
      "duplicate_detected",
      "fraud_detected",
      "owner_request",
      "device_failure",
      "other",
    ]) {
      expect(
        validateEventPayload("microchip_replaced", {
          previous_chip_number: "111111111111111",
          new_chip_number: null,
          reason,
          replaced_by: null,
          replaced_at: "2026-05-19",
        }),
      ).toBeTruthy();
    }
  });

  it("rejects unknown reason", () => {
    expect(() =>
      validateEventPayload("microchip_replaced", {
        previous_chip_number: "111111111111111",
        new_chip_number: "222222222222222",
        reason: "vibes",
        replaced_by: null,
        replaced_at: "2026-05-19",
      }),
    ).toThrow();
  });
});

describe("custody_transferred payload schema (org + P2P union)", () => {
  const U1 = "11111111-1111-4111-8111-111111111111";
  const U2 = "22222222-2222-4222-8222-222222222222";
  const ORG1 = "33333333-3333-4333-8333-333333333333";
  const ORG2 = "44444444-4444-4444-8444-444444444444";

  // --- P2P owner→owner variant (the bug: this shape used to be rejected) ---

  it("accepts the owner→owner P2P payload (from/to user, owner roles, transfer_token)", () => {
    expect(() =>
      validateEventPayload("custody_transferred", {
        payload_version: 1,
        from_user_id: U1,
        to_user_id: U2,
        from_role: "owner",
        to_role: "owner",
        reason: "gift",
        transfer_token: "PTR-8M3K-2K43",
      }),
    ).not.toThrow();
  });

  it("accepts every P2P reason (sale/gift/inheritance/other)", () => {
    for (const reason of ["sale", "gift", "inheritance", "other"] as const) {
      expect(() =>
        validateEventPayload("custody_transferred", {
          payload_version: 1,
          from_user_id: U1,
          to_user_id: U2,
          from_role: "owner",
          to_role: "owner",
          reason,
          transfer_token: "PTR-XXXX-YYYY",
        }),
      ).not.toThrow();
    }
  });

  it("rejects a P2P payload missing the required owner roles", () => {
    expect(() =>
      validateEventPayload("custody_transferred", {
        payload_version: 1,
        from_user_id: U1,
        to_user_id: U2,
        reason: "gift",
        transfer_token: "PTR-8M3K-2K43",
      }),
    ).toThrow();
  });

  it("rejects a P2P payload whose reason is not a P2P reason", () => {
    expect(() =>
      validateEventPayload("custody_transferred", {
        payload_version: 1,
        from_user_id: U1,
        to_user_id: U2,
        from_role: "owner",
        to_role: "owner",
        reason: "org_to_org_handoff",
        transfer_token: "PTR-8M3K-2K43",
      }),
    ).toThrow();
  });

  // --- Org/custody variant still validates unchanged ---

  it("still accepts the org→org custody handoff payload", () => {
    expect(() =>
      validateEventPayload("custody_transferred", {
        payload_version: 1,
        from_user_id: null,
        from_organization_id: ORG1,
        to_user_id: null,
        to_organization_id: ORG2,
        from_role: "shelter_custody",
        to_role: "shelter_custody",
        reason: "org_to_org_handoff",
        matched_against_pet_id: null,
        foster_ended_event_id: null,
        notes: null,
      }),
    ).not.toThrow();
  });

  it("still accepts the org→owner return-to-owner payload", () => {
    expect(() =>
      validateEventPayload("custody_transferred", {
        payload_version: 1,
        from_user_id: null,
        from_organization_id: ORG1,
        to_user_id: U1,
        to_organization_id: null,
        from_role: "shelter_custody",
        to_role: "owner",
        reason: "return_to_original_owner",
        matched_against_pet_id: null,
        foster_ended_event_id: null,
        notes: null,
      }),
    ).not.toThrow();
  });

  it("rejects an org payload carrying a P2P-only transfer_token key (strict)", () => {
    expect(() =>
      validateEventPayload("custody_transferred", {
        payload_version: 1,
        from_user_id: null,
        from_organization_id: ORG1,
        to_user_id: null,
        to_organization_id: ORG2,
        from_role: "shelter_custody",
        to_role: "shelter_custody",
        reason: "org_to_org_handoff",
        matched_against_pet_id: null,
        foster_ended_event_id: null,
        notes: null,
        transfer_token: "PTR-should-not-be-here",
      }),
    ).toThrow();
  });
});

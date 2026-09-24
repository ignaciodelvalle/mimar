// Unit tests for UX Audit item 3.4 — localization / copy fixes.
//
// Covers:
//   1. Death-cause label map: deathCauseLabel() returns es-AR labels for every
//      DEATH_CAUSES enum value; underlying enum values are unchanged.
//   2. Notification-type label map: notificationTypeLabel() returns a human
//      Spanish label for the notification codes that actually reach the
//      notification surface; graceful fallback for unknown codes.
//   3. Province select: the PROVINCES array covers the expected 24 entries
//      (drives the <select> in /admin/outbox).
//
// Pure unit tests — no DB, no server, no DOM rendering.

import { describe, expect, it } from "vitest";

import { PROVINCES } from "@/lib/reference/ar-provincias";
import { deathCauseLabel, dispositionMethodLabel, notificationTypeLabel } from "@/lib/utils/format";
import { DEATH_CAUSES, DISPOSITION_METHODS } from "@/src/modules/events/domain/death-rules";

// ---------------------------------------------------------------------------
// 1. Death-cause label map
// ---------------------------------------------------------------------------

describe("deathCauseLabel — es-AR localization", () => {
  it("returns a non-empty Spanish label for every DEATH_CAUSES value", () => {
    for (const cause of DEATH_CAUSES) {
      const label = deathCauseLabel(cause);
      // Label must differ from the raw English key (i.e., it was translated).
      expect(label, `cause="${cause}" should have a translated label`).not.toBe(cause);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("maps known values to their correct es-AR label", () => {
    expect(deathCauseLabel("euthanasia")).toBe("Eutanasia");
    expect(deathCauseLabel("natural")).toBe("Muerte natural");
    expect(deathCauseLabel("disease")).toBe("Enfermedad");
    expect(deathCauseLabel("accident")).toBe("Accidente");
    expect(deathCauseLabel("unknown")).toBe("Causa desconocida");
    expect(deathCauseLabel("known")).toBe("Causa conocida");
    expect(deathCauseLabel("sudden")).toBe("Muerte súbita");
    expect(deathCauseLabel("violent")).toBe("Causa violenta");
    expect(deathCauseLabel("other")).toBe("Otra causa");
  });

  it("underlying DEATH_CAUSES values are unchanged (English keys)", () => {
    // Guard: if someone renames an enum value (data-breaking change) this test
    // will catch it.
    expect(DEATH_CAUSES).toContain("euthanasia");
    expect(DEATH_CAUSES).toContain("natural");
    expect(DEATH_CAUSES).toContain("disease");
    expect(DEATH_CAUSES).toContain("accident");
    expect(DEATH_CAUSES).toContain("unknown");
    expect(DEATH_CAUSES).toContain("known");
    expect(DEATH_CAUSES).toContain("sudden");
    expect(DEATH_CAUSES).toContain("violent");
    expect(DEATH_CAUSES).toContain("other");
    // The catalog should still have exactly 9 values.
    expect(DEATH_CAUSES).toHaveLength(9);
  });

  it("falls back to the raw value for an unrecognized cause", () => {
    expect(deathCauseLabel("some_future_cause" as unknown as string)).toBe("some_future_cause");
  });

  it("returns '—' for null/undefined", () => {
    expect(deathCauseLabel(null)).toBe("—");
    expect(deathCauseLabel(undefined)).toBe("—");
  });
});

// ---------------------------------------------------------------------------
// 2. Disposition-method label map
// ---------------------------------------------------------------------------

describe("dispositionMethodLabel — es-AR localization", () => {
  it("returns a non-empty Spanish label for every DISPOSITION_METHODS value", () => {
    for (const method of DISPOSITION_METHODS) {
      const label = dispositionMethodLabel(method);
      expect(label, `method="${method}" should have a translated label`).not.toBe(method);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("maps known values to correct es-AR labels", () => {
    expect(dispositionMethodLabel("cremation_collective")).toBe("Cremación colectiva");
    expect(dispositionMethodLabel("cremation_individual_ashes")).toBe(
      "Cremación individual con cenizas",
    );
    expect(dispositionMethodLabel("authorized_cemetery")).toBe("Cementerio habilitado");
    expect(dispositionMethodLabel("owner_burial")).toBe("Entierro en domicilio");
    expect(dispositionMethodLabel("household_waste")).toBe("Residuos domiciliarios");
    expect(dispositionMethodLabel("rendering")).toBe("Reciclaje sanitario");
    expect(dispositionMethodLabel("unknown")).toBe("Sin especificar");
  });

  it("underlying DISPOSITION_METHODS values are unchanged (English keys)", () => {
    expect(DISPOSITION_METHODS).toContain("cremation_collective");
    expect(DISPOSITION_METHODS).toContain("cremation_individual_ashes");
    expect(DISPOSITION_METHODS).toContain("authorized_cemetery");
    expect(DISPOSITION_METHODS).toContain("owner_burial");
    expect(DISPOSITION_METHODS).toContain("household_waste");
    expect(DISPOSITION_METHODS).toContain("rendering");
    expect(DISPOSITION_METHODS).toContain("unknown");
  });

  it("falls back for unrecognized method", () => {
    expect(dispositionMethodLabel("future_method")).toBe("future_method");
  });
});

// ---------------------------------------------------------------------------
// 3. Notification-type label map
// ---------------------------------------------------------------------------

// Codes verified against app/actions/*.ts and lib/business-rules-reeval.ts.
const REAL_NOTIFICATION_TYPES = [
  "adoption_application_approved",
  "adoption_application_closed",
  "adoption_application_received",
  "adoption_application_rejected",
  "adoption_application_withdrawn",
  "adoption_finalized",
  "adoption_info_requested",
  "admin_event_amended",
  "anonymous_reports_overflow",
  "appointment_attended",
  "appointment_cancelled_by_org",
  "appointment_cancelled_by_owner",
  "appointment_no_show",
  "approval_request_approved",
  "approval_request_auto_expired",
  "approval_request_pending_authority",
  "approval_request_proposed_authority",
  "approval_request_rejected",
  "approval_request_submitted_self",
  "bite_reported_authority",
  "bite_reported_by_org_owner",
  "capability_granted",
  "capability_request",
  "chip_match_notification_owner",
  "cross_org_transfer_accepted_receiver",
  "cross_org_transfer_accepted_sender",
  "cross_org_transfer_cancelled_receiver",
  "cross_org_transfer_proposed_receiver",
  "cross_org_transfer_proposed_sender",
  "cross_org_transfer_rejected_sender",
  "custody_dispute_party_added",
  "custody_dispute_raised_against_you",
  "custody_dispute_raised_by_you",
  "custody_dispute_resolved",
  "custody_dispute_stale",
  "custody_received",
  "custody_transfer_accepted_owner_side",
  "custody_transfer_auto_cancelled",
  "custody_transfer_proposal_owner",
  "decomiso_confirmed_admin",
  "decomiso_confirmed_govt",
  "decomiso_handoff_accepted_govt",
  "decomiso_handoff_accepted_receiver",
  "decomiso_handoff_proposed_receiver",
  "decomiso_handoff_rejected_govt",
  "decomiso_handoff_stale",
  "decomiso_owner_lost_custody",
  "eno_disease_diagnosis",
  "eno_pet_disease_diagnosis",
  "foster_assigned",
  "foster_converted_to_owner",
  "foster_ended",
  "foster_ended_by_adoption",
  "foster_ended_by_death",
  "foster_ended_by_transfer",
  "foster_proposal_accepted_org",
  "foster_proposal_auto_cancelled_org",
  "foster_proposal_cancelled_volunteer",
  "foster_proposal_expired",
  "foster_proposal_received",
  "foster_proposal_rejected_org",
  "foster_volunteer_reenroll_prompt",
  "free_pet_claimed",
  "admin_deactivated",
  "govt_deactivated",
  "govt_locality_assigned",
  "govt_locality_revoked",
  "govt_self_deactivated_admin_notice",
  "govt_self_deactivated_cascade_notice",
  "institutional_account_created",
  "lost_episode_resolved_broadcast",
  "lost_episode_resolved_owner",
  "lost_pet_broadcast",
  "microchip_duplicate_detected",
  "microchip_fraud_detected",
  "microchip_updated_by_institution",
  "operator_credentials_reset",
  "org_invitation_accepted",
  "org_invitation_created",
  "org_membership_removed",
  "org_verification_granted",
  "org_verification_revoked",
  "outbreak_signal_detected",
  "pet_found_report",
  "pet_in_possession",
  "pet_sighting",
  "pet_transfer_accepted",
  "pet_transfer_cancelled",
  "pet_transfer_expired",
  "pet_transfer_initiated",
  "pet_transfer_received",
  "pet_transfer_rejected",
  "post_adoption_checkin_due",
  "post_adoption_checkin_missed",
  "post_adoption_checkin_received",
  "ppp_breed_list_updated_now_applies",
  "ppp_registration_reminder",
  "pregnancy_ended_owner",
  "pregnancy_started_owner",
  "profile_self_updated",
  "rabies_observation_completed_dead_authority",
  "rabies_observation_completed_negative_owner",
  "rabies_observation_completed_professional_owner",
  "rabies_observation_escalation_owner",
  "rabies_observation_pending_review",
  "rabies_observation_started_owner",
  "rehome_request_accepted",
  "rehome_request_declined",
  "rehome_request_received",
  "rehome_request_withdrawn",
  "rehome_sponsorship_ended_by_death",
  "rehome_sponsorship_withdrawn",
  "revocation_executed_org",
  "revocation_executed_vet",
  "self_resignation_confirmed",
  "service_dog_credential_revoked",
  "service_offering_approved",
  "service_offering_pending_authority",
  "service_offering_rejected",
  "service_offering_submitted",
  "shelter_intake_confirmed",
  "stub_profile_claimed",
  "vaccine_due",
  "welfare_denuncia_stale_govt",
  "welfare_org_intervention_note",
  "welfare_org_intervention_returned",
  "welfare_org_intervention_taken",
  "welfare_org_side_confirmed_reporter",
  "welfare_org_side_critical_received",
  "welfare_report_derived_to_org",
  "welfare_report_rederived_away",
  "welfare_report_status_changed",
] as const;

describe("notificationTypeLabel — es-AR localization", () => {
  it("returns a human Spanish label (not the raw code) for every known notification type", () => {
    for (const code of REAL_NOTIFICATION_TYPES) {
      const label = notificationTypeLabel(code);
      // Label must differ from the raw snake_case code.
      expect(label, `code="${code}" should have a human Spanish label`).not.toBe(code);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("specifically maps the codes mentioned in the UX audit", () => {
    // Audit item 3.4 called out these two as appearing raw in the UI.
    expect(notificationTypeLabel("lost_episode_resolved_owner")).toBe("Mascota encontrada");
    expect(notificationTypeLabel("ppp_breed_list_updated_now_applies")).toBe(
      "Lista de razas PPP actualizada — aplica a tu mascota",
    );
  });

  it("falls back gracefully to the raw code for unknown types", () => {
    expect(notificationTypeLabel("future_notification_type_v99")).toBe(
      "future_notification_type_v99",
    );
  });

  it("returns '—' for null/undefined", () => {
    expect(notificationTypeLabel(null)).toBe("—");
    expect(notificationTypeLabel(undefined)).toBe("—");
  });
});

// ---------------------------------------------------------------------------
// 4. Province select — PROVINCES array drives the <select> in /admin/outbox
// ---------------------------------------------------------------------------

describe("PROVINCES array — province select coverage", () => {
  it("contains exactly 24 Argentine provinces + CABA", () => {
    expect(PROVINCES).toHaveLength(24);
  });

  it("includes the provinces likely to appear in ENO/govt outbox records", () => {
    const names = PROVINCES.map((p) => p.name);
    expect(names).toContain("Buenos Aires");
    expect(names).toContain("CABA");
    expect(names).toContain("Córdoba");
    expect(names).toContain("Santa Fe");
    expect(names).toContain("Mendoza");
  });

  it("every province has a non-empty code, name, and slug", () => {
    for (const p of PROVINCES) {
      expect(p.code.length).toBeGreaterThan(0);
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.slug.length).toBeGreaterThan(0);
    }
  });
});

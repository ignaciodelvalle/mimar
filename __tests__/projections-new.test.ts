// Unit tests for four previously-untested projection modules.
// Pure functions - no DB, no mocks, no flakiness.
//
// Covered:
//   - replayPetAdoptionEligibility (lib/projections/pet-adoption-eligibility.ts)
//   - replayPetPregnancy           (lib/projections/pet-pregnancy.ts)
//   - replayPetRabiesObservation   (lib/projections/pet-rabies-observation.ts)
//   - replayPetTattoo              (lib/projections/pet-tattoo.ts)
//
// Test style mirrors __tests__/projections.test.ts.

import { overlayAmendments } from "@/lib/infra/amendment";
import { describe, expect, it } from "vitest";

import { replayPetAdoptionEligibility } from "@/lib/projections/pet-adoption-eligibility";
import { replayPetPregnancy } from "@/lib/projections/pet-pregnancy";
import { replayPetRabiesObservation } from "@/lib/projections/pet-rabies-observation";
import { replayPetTattoo } from "@/lib/projections/pet-tattoo";
import type { ProjectionEvent } from "@/lib/projections/types";

// ---------------------------------------------------------------------------
// Helper - mirrors the ev() factory in projections.test.ts
// ---------------------------------------------------------------------------

function ev(
  i: number,
  eventType: string,
  payload: Record<string, unknown> = {},
  occurredAt?: Date | string,
): ProjectionEvent {
  return {
    id: `evt-${i}`,
    eventType,
    occurredAt: occurredAt ?? new Date(2026, 0, i + 1),
    recordedAt: new Date(2026, 0, i + 1),
    payload,
  };
}

// ---------------------------------------------------------------------------
// replayPetAdoptionEligibility
// ---------------------------------------------------------------------------

describe("replayPetAdoptionEligibility", () => {
  const EMPTY = {
    adoptionEligible: null,
    adoptionIneligibleReason: null,
    adoptionIneligibleReasonNotes: null,
    adoptionIneligibleUntil: null,
    adoptionEligibilitySetAt: null,
  };

  it("returns the null block for an empty event list", () => {
    expect(replayPetAdoptionEligibility([])).toEqual(EMPTY);
  });

  it("returns the null block when no adoption_eligibility_set event exists", () => {
    expect(
      replayPetAdoptionEligibility([ev(1, "pet_registered"), ev(2, "weight_recorded")]),
    ).toEqual(EMPTY);
  });

  it("returns eligible=true with null ineligible fields when eligible", () => {
    const recordedAt = new Date(2026, 2, 10);
    const e = { ...ev(1, "adoption_eligibility_set", { eligible: true }), recordedAt };
    const result = replayPetAdoptionEligibility([e]);
    expect(result.adoptionEligible).toBe(true);
    expect(result.adoptionIneligibleReason).toBeNull();
    expect(result.adoptionIneligibleReasonNotes).toBeNull();
    expect(result.adoptionIneligibleUntil).toBeNull();
    expect(result.adoptionEligibilitySetAt).toBe(recordedAt.toISOString());
  });

  it("returns eligible=false with ineligible reason fields populated", () => {
    const e = ev(1, "adoption_eligibility_set", {
      eligible: false,
      ineligible_reason: "health",
      ineligible_reason_notes: "recovering from surgery",
      ineligible_until: "2026-09-01T00:00:00.000Z",
    });
    const result = replayPetAdoptionEligibility([e]);
    expect(result.adoptionEligible).toBe(false);
    expect(result.adoptionIneligibleReason).toBe("health");
    expect(result.adoptionIneligibleReasonNotes).toBe("recovering from surgery");
    expect(result.adoptionIneligibleUntil).toBe("2026-09-01T00:00:00.000Z");
  });

  it("latest adoption_eligibility_set event wins (last in ascending list)", () => {
    const first = ev(1, "adoption_eligibility_set", {
      eligible: false,
      ineligible_reason: "health",
    });
    const second = ev(2, "adoption_eligibility_set", { eligible: true });
    const result = replayPetAdoptionEligibility([first, second]);
    expect(result.adoptionEligible).toBe(true);
    expect(result.adoptionIneligibleReason).toBeNull();
  });

  it("skips malformed events (eligible not boolean) and falls back to earlier valid event", () => {
    const valid = ev(1, "adoption_eligibility_set", { eligible: true });
    const malformed = ev(2, "adoption_eligibility_set", { eligible: "yes" });
    const result = replayPetAdoptionEligibility([valid, malformed]);
    expect(result.adoptionEligible).toBe(true);
  });

  it("returns the null block when all adoption_eligibility_set events are malformed", () => {
    const malformed = ev(1, "adoption_eligibility_set", { eligible: 1 });
    expect(replayPetAdoptionEligibility([malformed])).toEqual(EMPTY);
  });

  it("clears ineligible fields when eligible=true is set after an ineligible event", () => {
    const ineligible = ev(1, "adoption_eligibility_set", {
      eligible: false,
      ineligible_reason: "age",
      ineligible_until: "2026-12-01T00:00:00.000Z",
    });
    const eligible = ev(2, "adoption_eligibility_set", { eligible: true });
    const result = replayPetAdoptionEligibility([ineligible, eligible]);
    expect(result.adoptionEligible).toBe(true);
    expect(result.adoptionIneligibleReason).toBeNull();
    expect(result.adoptionIneligibleUntil).toBeNull();
  });

  it("adoptionEligibilitySetAt is derived from recordedAt, not occurredAt", () => {
    const occurredAt = new Date(2026, 0, 5);
    const recordedAt = new Date(2026, 0, 7);
    const e: ProjectionEvent = {
      id: "evt-1",
      eventType: "adoption_eligibility_set",
      occurredAt,
      recordedAt,
      payload: { eligible: true },
    };
    const result = replayPetAdoptionEligibility([e]);
    expect(result.adoptionEligibilitySetAt).toBe(recordedAt.toISOString());
  });
});

// ---------------------------------------------------------------------------
// replayPetPregnancy
// ---------------------------------------------------------------------------

describe("replayPetPregnancy", () => {
  it("returns null for an empty event list", () => {
    expect(replayPetPregnancy(overlayAmendments([]))).toEqual({ pregnancyStatus: null });
  });

  it("returns null when no clinical_info_logged pregnancy event exists", () => {
    expect(
      replayPetPregnancy(
        overlayAmendments([ev(1, "weight_recorded"), ev(2, "vaccination_administered")]),
      ),
    ).toEqual({ pregnancyStatus: null });
  });

  it("returns null when clinical_info_logged exists but sub_kind is not pregnancy", () => {
    const e = ev(1, "clinical_info_logged", { sub_kind: "medication", note: "antibiotics" });
    expect(replayPetPregnancy(overlayAmendments([e]))).toEqual({ pregnancyStatus: null });
  });

  it("returns in_progress for a pregnancy started event", () => {
    const e = ev(1, "clinical_info_logged", { sub_kind: "pregnancy", pregnancy_phase: "started" });
    expect(replayPetPregnancy(overlayAmendments([e]))).toEqual({ pregnancyStatus: "in_progress" });
  });

  it("returns completed_live_birth for outcome live_birth", () => {
    const e = ev(1, "clinical_info_logged", {
      sub_kind: "pregnancy",
      pregnancy_phase: "ended",
      outcome: "live_birth",
    });
    expect(replayPetPregnancy(overlayAmendments([e]))).toEqual({
      pregnancyStatus: "completed_live_birth",
    });
  });

  it("returns completed_stillbirth for outcome stillbirth", () => {
    const e = ev(1, "clinical_info_logged", {
      sub_kind: "pregnancy",
      pregnancy_phase: "ended",
      outcome: "stillbirth",
    });
    expect(replayPetPregnancy(overlayAmendments([e]))).toEqual({
      pregnancyStatus: "completed_stillbirth",
    });
  });

  it("returns completed_miscarriage for outcome miscarriage", () => {
    const e = ev(1, "clinical_info_logged", {
      sub_kind: "pregnancy",
      pregnancy_phase: "ended",
      outcome: "miscarriage",
    });
    expect(replayPetPregnancy(overlayAmendments([e]))).toEqual({
      pregnancyStatus: "completed_miscarriage",
    });
  });

  it("returns completed_termination for outcome termination", () => {
    const e = ev(1, "clinical_info_logged", {
      sub_kind: "pregnancy",
      pregnancy_phase: "ended",
      outcome: "termination",
    });
    expect(replayPetPregnancy(overlayAmendments([e]))).toEqual({
      pregnancyStatus: "completed_termination",
    });
  });

  it("latest pregnancy event wins: started then ended yields completed", () => {
    const started = ev(1, "clinical_info_logged", {
      sub_kind: "pregnancy",
      pregnancy_phase: "started",
    });
    const ended = ev(2, "clinical_info_logged", {
      sub_kind: "pregnancy",
      pregnancy_phase: "ended",
      outcome: "live_birth",
    });
    expect(replayPetPregnancy(overlayAmendments([started, ended]))).toEqual({
      pregnancyStatus: "completed_live_birth",
    });
  });

  it("a new pregnancy started after a completed one overrides the terminal status", () => {
    const firstEnded = ev(1, "clinical_info_logged", {
      sub_kind: "pregnancy",
      pregnancy_phase: "ended",
      outcome: "live_birth",
    });
    const secondStarted = ev(2, "clinical_info_logged", {
      sub_kind: "pregnancy",
      pregnancy_phase: "started",
    });
    expect(replayPetPregnancy(overlayAmendments([firstEnded, secondStarted]))).toEqual({
      pregnancyStatus: "in_progress",
    });
  });

  it("skips malformed ended event (missing outcome) and falls back to previous valid event", () => {
    const started = ev(1, "clinical_info_logged", {
      sub_kind: "pregnancy",
      pregnancy_phase: "started",
    });
    const malformedEnded = ev(2, "clinical_info_logged", {
      sub_kind: "pregnancy",
      pregnancy_phase: "ended",
    });
    expect(replayPetPregnancy(overlayAmendments([started, malformedEnded]))).toEqual({
      pregnancyStatus: "in_progress",
    });
  });

  it("skips event with unknown phase and continues scanning", () => {
    const started = ev(1, "clinical_info_logged", {
      sub_kind: "pregnancy",
      pregnancy_phase: "started",
    });
    const unknown = ev(2, "clinical_info_logged", {
      sub_kind: "pregnancy",
      pregnancy_phase: "unknown_phase",
    });
    expect(replayPetPregnancy(overlayAmendments([started, unknown]))).toEqual({
      pregnancyStatus: "in_progress",
    });
  });
});

// ---------------------------------------------------------------------------
// replayPetRabiesObservation
// ---------------------------------------------------------------------------

describe("replayPetRabiesObservation", () => {
  it("returns null for an empty event list", () => {
    expect(replayPetRabiesObservation([])).toEqual({ rabiesObservationStatus: null });
  });

  it("returns null when no observation event exists", () => {
    expect(
      replayPetRabiesObservation([ev(1, "pet_registered"), ev(2, "vaccination_administered")]),
    ).toEqual({ rabiesObservationStatus: null });
  });

  it("returns in_progress for a rabies_observation_started event", () => {
    const e = ev(1, "rabies_observation_started", { bite_date: "2026-01-10" });
    expect(replayPetRabiesObservation([e])).toEqual({ rabiesObservationStatus: "in_progress" });
  });

  it("returns completed_negative for outcome negative", () => {
    const e = ev(1, "rabies_observation_ended", { outcome: "negative" });
    expect(replayPetRabiesObservation([e])).toEqual({
      rabiesObservationStatus: "completed_negative",
    });
  });

  it("returns completed_positive_rabies for outcome positive_rabies", () => {
    const e = ev(1, "rabies_observation_ended", { outcome: "positive_rabies" });
    expect(replayPetRabiesObservation([e])).toEqual({
      rabiesObservationStatus: "completed_positive_rabies",
    });
  });

  it("returns completed_dead for outcome dead", () => {
    const e = ev(1, "rabies_observation_ended", { outcome: "dead" });
    expect(replayPetRabiesObservation([e])).toEqual({ rabiesObservationStatus: "completed_dead" });
  });

  it("returns completed_lost_to_followup for outcome lost_to_followup", () => {
    const e = ev(1, "rabies_observation_ended", { outcome: "lost_to_followup" });
    expect(replayPetRabiesObservation([e])).toEqual({
      rabiesObservationStatus: "completed_lost_to_followup",
    });
  });

  it("latest event wins: started then ended yields completed", () => {
    const started = ev(1, "rabies_observation_started");
    const ended = ev(2, "rabies_observation_ended", { outcome: "negative" });
    expect(replayPetRabiesObservation([started, ended])).toEqual({
      rabiesObservationStatus: "completed_negative",
    });
  });

  it("a new observation started after a completed one overrides the terminal status", () => {
    const firstEnded = ev(1, "rabies_observation_ended", { outcome: "negative" });
    const secondStarted = ev(2, "rabies_observation_started");
    expect(replayPetRabiesObservation([firstEnded, secondStarted])).toEqual({
      rabiesObservationStatus: "in_progress",
    });
  });

  it("skips ended event with invalid outcome and falls back to the previous started", () => {
    const started = ev(1, "rabies_observation_started");
    const badEnded = ev(2, "rabies_observation_ended", { outcome: "not_a_valid_outcome" });
    expect(replayPetRabiesObservation([started, badEnded])).toEqual({
      rabiesObservationStatus: "in_progress",
    });
  });

  it("skips ended event with no outcome field and falls back", () => {
    const started = ev(1, "rabies_observation_started");
    const noOutcome = ev(2, "rabies_observation_ended", {});
    expect(replayPetRabiesObservation([started, noOutcome])).toEqual({
      rabiesObservationStatus: "in_progress",
    });
  });

  it("returns null when only malformed ended events exist", () => {
    const bad = ev(1, "rabies_observation_ended", { outcome: "unknown" });
    expect(replayPetRabiesObservation([bad])).toEqual({ rabiesObservationStatus: null });
  });

  it("death_recorded CASCADE produces completed_dead via ended event", () => {
    // The writer emits rabies_observation_ended(outcome=dead) before death_recorded.
    const started = ev(1, "rabies_observation_started");
    const deathEnded = ev(2, "rabies_observation_ended", { outcome: "dead" });
    const deathRecorded = ev(3, "death_recorded");
    expect(replayPetRabiesObservation([started, deathEnded, deathRecorded])).toEqual({
      rabiesObservationStatus: "completed_dead",
    });
  });
});

// ---------------------------------------------------------------------------
// replayPetTattoo
// ---------------------------------------------------------------------------

describe("replayPetTattoo", () => {
  const EMPTY = {
    tattooCode: null,
    tattooLocation: null,
    tattooDescription: null,
    tattooRecordedAt: null,
    tattooRecordedBy: null,
  };

  it("returns the null block for an empty event list", () => {
    expect(replayPetTattoo([])).toEqual(EMPTY);
  });

  it("returns the null block when no tattoo_recorded event exists", () => {
    expect(replayPetTattoo([ev(1, "pet_registered"), ev(2, "weight_recorded")])).toEqual(EMPTY);
  });

  it("returns all fields for a complete tattoo_recorded event with known date", () => {
    const e = ev(1, "tattoo_recorded", {
      tattoo_code: "ABC-123",
      location_on_body: "left_ear",
      description: "blue ink triangle",
      tattoo_date_known: true,
      recorded_at: "2026-02-14",
      recorded_by: "Dr. Ruiz",
    });
    expect(replayPetTattoo([e])).toEqual({
      tattooCode: "ABC-123",
      tattooLocation: "left_ear",
      tattooDescription: "blue ink triangle",
      tattooRecordedAt: "2026-02-14",
      tattooRecordedBy: "Dr. Ruiz",
    });
  });

  it("returns tattooRecordedAt=null when tattoo_date_known is false", () => {
    const e = ev(1, "tattoo_recorded", {
      tattoo_code: "XY-7",
      tattoo_date_known: false,
      recorded_at: "2026-02-14",
    });
    const result = replayPetTattoo([e]);
    expect(result.tattooCode).toBe("XY-7");
    expect(result.tattooRecordedAt).toBeNull();
  });

  it("latest tattoo_recorded event wins (unlike microchip which is earliest-wins)", () => {
    const first = ev(1, "tattoo_recorded", { tattoo_code: "OLD-001", tattoo_date_known: false });
    const second = ev(2, "tattoo_recorded", {
      tattoo_code: "NEW-002",
      tattoo_date_known: true,
      recorded_at: "2026-03-01",
      recorded_by: "Dr. Martinez",
    });
    const result = replayPetTattoo([first, second]);
    expect(result.tattooCode).toBe("NEW-002");
    expect(result.tattooRecordedAt).toBe("2026-03-01");
    expect(result.tattooRecordedBy).toBe("Dr. Martinez");
  });

  it("skips malformed event (empty tattoo_code) and falls back to previous valid one", () => {
    const valid = ev(1, "tattoo_recorded", { tattoo_code: "GOOD-1", tattoo_date_known: false });
    const malformed = ev(2, "tattoo_recorded", { tattoo_code: "" });
    const result = replayPetTattoo([valid, malformed]);
    expect(result.tattooCode).toBe("GOOD-1");
  });

  it("skips malformed event (missing tattoo_code) and falls back", () => {
    const valid = ev(1, "tattoo_recorded", { tattoo_code: "GOOD-2", tattoo_date_known: false });
    const malformed = ev(2, "tattoo_recorded", { location_on_body: "neck" });
    expect(replayPetTattoo([valid, malformed])).toMatchObject({ tattooCode: "GOOD-2" });
  });

  it("returns the null block when all tattoo events are malformed", () => {
    const bad1 = ev(1, "tattoo_recorded", { tattoo_code: null });
    const bad2 = ev(2, "tattoo_recorded", {});
    expect(replayPetTattoo([bad1, bad2])).toEqual(EMPTY);
  });

  it("optional fields are null when absent from the payload", () => {
    const e = ev(1, "tattoo_recorded", { tattoo_code: "MIN-1", tattoo_date_known: false });
    const result = replayPetTattoo([e]);
    expect(result.tattooLocation).toBeNull();
    expect(result.tattooDescription).toBeNull();
    expect(result.tattooRecordedBy).toBeNull();
  });
});

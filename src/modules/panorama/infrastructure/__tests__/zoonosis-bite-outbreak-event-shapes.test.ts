// Pure (no-DB) contract test for the zoonosis + bite panorama surfaces. Guards
// the schema truths the loader fixes rely on:
//   - outbreak_signal is the ONE event type that legitimately snapshots the pet's
//     jurisdiction into pet_jurisdiction_province/locality (what petEventsScopeClause
//     + loadZoonosisByUnit now key on). It is `.strict()`, so the flat
//     'province'/'locality' keys the seed used to raw-insert are REJECTED.
//   - incident_reported (bite) does NOT — and cannot — carry pet_jurisdiction_*.
//     That is precisely why loadBiteEvents must scope via the pet, not the payload.
//
// If a writer or the seed drifts from these shapes, these assertions fail before
// any DB-backed test runs.

import { describe, expect, it } from "vitest";

import { validateEventPayload } from "@/lib/events/event-schemas";

const VALID_OUTBREAK = {
  triggered_by: "direct_diagnosis" as const,
  source_symptom_event_id: null,
  source_disease_diagnosis_event_id: "00000000-0000-0000-0000-000000000000",
  disease_code: "rabies_suspected",
  disease_label: "Rabia (sospechada)",
  match_strength: { high_count: 0, medium_count: 0, low_count: 0, matched_symptom_codes: [] },
  pet_jurisdiction_country: "AR",
  pet_jurisdiction_province: "Santa Fe",
  pet_jurisdiction_locality: "Rosario",
  pet_species: "dog",
};

describe("outbreak_signal legitimately carries the jurisdiction snapshot", () => {
  it("validates with pet_jurisdiction_province/locality and no flat province/locality", () => {
    expect(() => validateEventPayload("outbreak_signal", VALID_OUTBREAK)).not.toThrow();
  });

  it("is strict — the seed's old flat 'province'/'locality' demo keys are rejected", () => {
    expect(() =>
      validateEventPayload("outbreak_signal", {
        ...VALID_OUTBREAK,
        province: "Santa Fe",
        locality: "Rosario",
        status: "open",
      }),
    ).toThrow();
  });
});

describe("incident_reported (bite) cannot carry the payload keys petEventsScopeClause reads", () => {
  it("validates a real bite with NO jurisdiction in its payload", () => {
    expect(() =>
      validateEventPayload("incident_reported", {
        incident_type: "bite_inflicted",
        severity: "moderate",
        injuries_summary: "x",
        vet_involved: true,
      }),
    ).not.toThrow();
  });

  it("REJECTS pet_jurisdiction_* — so petEventsScope was provably invalid for bites (must scope via pets)", () => {
    expect(() =>
      validateEventPayload("incident_reported", {
        incident_type: "bite_inflicted",
        severity: "moderate",
        injuries_summary: "x",
        vet_involved: true,
        pet_jurisdiction_province: "Santa Fe",
        pet_jurisdiction_locality: "Rosario",
      }),
    ).toThrow();
  });
});

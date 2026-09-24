// Pure (no-DB) contract test: the event shapes the perdidas + mordeduras
// panorama loaders now key on are exactly the shapes the strict zod schemas
// accept — and the demo-only payload the seed used to raw-insert is REJECTED.
//
// This is the compile-time-adjacent guard for the schema-drift fix: if a writer
// or the seed ever drifts from the real shape, these assertions fail before any
// DB-backed test runs.

import { describe, expect, it } from "vitest";

import { validateEventPayload } from "@/lib/events/event-schemas";

describe("perdidas loader target shapes validate against the real zod schemas", () => {
  it("a pet marked lost is status_changed with to_status='lost' (no payload 'kind')", () => {
    expect(() =>
      validateEventPayload("status_changed", { from_status: "active", to_status: "lost" }),
    ).not.toThrow();
  });

  it("a sighting is note_added with kind='sighting' — the shape the seed now writes", () => {
    expect(() =>
      validateEventPayload("note_added", {
        category: "otro",
        text: "Avistaje reportado durante episodio de búsqueda (seed-panorama-history)",
        kind: "sighting",
      }),
    ).not.toThrow();
  });

  it("a bite is incident_reported with incident_type in the bite set", () => {
    for (const incident_type of ["bite_inflicted", "bite_suffered"] as const) {
      expect(() =>
        validateEventPayload("incident_reported", {
          incident_type,
          severity: "moderate",
          injuries_summary: "x",
          vet_involved: true,
        }),
      ).not.toThrow();
    }
  });
});

describe("the OLD demo payloads the seed raw-inserted are NOT schema-valid", () => {
  it("note_added has no 'pet_found_sighting' kind — the old sighting discriminator was never valid", () => {
    expect(() =>
      validateEventPayload("note_added", {
        category: "otro",
        text: "x",
        kind: "pet_found_sighting",
      }),
    ).toThrow();
  });

  it("status_changed is strict — the demo's extra 'kind'/'province' keys are rejected", () => {
    expect(() =>
      validateEventPayload("status_changed", {
        from_status: "active",
        to_status: "lost",
        kind: "pet_lost",
        province: "Santa Fe",
        locality: "Rosario",
      }),
    ).toThrow();
  });

  it("incident_reported is strict — flat payload 'province'/'locality' are rejected", () => {
    expect(() =>
      validateEventPayload("incident_reported", {
        incident_type: "bite_inflicted",
        severity: "moderate",
        injuries_summary: "x",
        vet_involved: true,
        province: "Santa Fe",
        locality: "Rosario",
      }),
    ).toThrow();
  });
});

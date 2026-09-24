// Unit tests: quick-capture matcher-to-atender-evento mapping (#5).

import { describe, expect, it } from "vitest";

import type { MatchResult } from "@/lib/events/event-capture-matcher";

import { toAtenderCaptureMatch } from "./atender-quick-capture-match";

function match(overrides: Partial<MatchResult>): MatchResult {
  return {
    eventType: "note_added",
    confidence: "high",
    slots: {},
    matchedPattern: "test",
    ...overrides,
  };
}

describe("toAtenderCaptureMatch", () => {
  it("returns null for a null match", () => {
    expect(toAtenderCaptureMatch(null)).toBeNull();
  });

  it.each([
    ["vaccination_administered", "vacuna"],
    ["deworming_administered", "desparasitacion"],
    ["clinical_info_logged", "cirugia"],
    ["medication_started", "medicacion"],
    // Fresh chip placement joined the grid on 2026-08-06 (PO decision, Cowork
    // QA v3 M3) — "le coloqué un microchip" must route, not read "No reconocido".
    ["microchip_implanted", "chip"],
    ["note_added", "nota"],
  ] as const)("maps matcher eventType %s to atender evento %s", (eventType, evento) => {
    const result = toAtenderCaptureMatch(match({ eventType, slots: { occurredAt: "2026-07-18" } }));
    expect(result).toEqual({
      evento,
      slots: { occurredAt: "2026-07-18" },
      confidence: "high",
    });
  });

  it.each([
    "weight_recorded",
    "sterilization_performed",
    "symptom_observed",
    "medication_stopped",
    "death_recorded",
    "vet_visit_logged",
    "status_changed",
    "post_adoption_checkin",
  ] as const)("rejects out-of-scope matcher eventType %s (not one of atender's 6)", (eventType) => {
    expect(toAtenderCaptureMatch(match({ eventType }))).toBeNull();
  });

  it("rejects a match carrying a routeOverride (owner-only sub-flow)", () => {
    const result = toAtenderCaptureMatch(
      match({ eventType: "vaccination_administered", routeOverride: "/vacunas/programar" }),
    );
    expect(result).toBeNull();
  });

  it("preserves confidence and slots through the mapping", () => {
    const result = toAtenderCaptureMatch(
      match({
        eventType: "vaccination_administered",
        confidence: "medium",
        slots: { vaccineName: "antirrabica", occurredAt: "2026-07-18" },
      }),
    );
    expect(result).toEqual({
      evento: "vacuna",
      slots: { vaccineName: "antirrabica", occurredAt: "2026-07-18" },
      confidence: "medium",
    });
  });
});

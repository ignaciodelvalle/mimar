// eventPayloadSummary fallback test for the status_changed payload key rename.
// New events write `location_description`; old events have `last_known_location`.
// Both should render the same secondary text.

import { describe, expect, it } from "vitest";

import { eventPayloadSummary } from "@/lib/events/events";

describe("eventPayloadSummary — status_changed location key fallback", () => {
  it("reads the new `location_description` key", () => {
    const summary = eventPayloadSummary("status_changed", {
      from_status: "active",
      to_status: "lost",
      location_description: "Parque Centenario, esquina Antezana",
      reason: null,
    });
    expect(summary.primary).toBe("Marcada como perdida");
    expect(summary.secondary).toBe("Parque Centenario, esquina Antezana");
  });

  it("falls back to the legacy `last_known_location` key when only that one is set", () => {
    const summary = eventPayloadSummary("status_changed", {
      from_status: "active",
      to_status: "lost",
      last_known_location: "Atrás de la plaza Almagro",
      reason: null,
    });
    expect(summary.primary).toBe("Marcada como perdida");
    expect(summary.secondary).toBe("Atrás de la plaza Almagro");
  });

  it("prefers the new key when both are present (defensive — should never happen)", () => {
    const summary = eventPayloadSummary("status_changed", {
      from_status: "active",
      to_status: "lost",
      location_description: "Nueva descripción",
      last_known_location: "Vieja descripción",
      reason: null,
    });
    expect(summary.secondary).toBe("Nueva descripción");
  });

  it("renders the reason as secondary when no location text is set", () => {
    const summary = eventPayloadSummary("status_changed", {
      from_status: "active",
      to_status: "lost",
      reason: "Se escapó por el portón",
    });
    expect(summary.secondary).toBe("Se escapó por el portón");
  });

  it("renders nothing as secondary when neither location nor reason is set", () => {
    const summary = eventPayloadSummary("status_changed", {
      from_status: "active",
      to_status: "lost",
    });
    expect(summary.secondary).toBeNull();
  });

  it("handles the active (found) direction", () => {
    const summary = eventPayloadSummary("status_changed", {
      from_status: "lost",
      to_status: "active",
    });
    expect(summary.primary).toBe("Marcada como encontrada");
  });
});

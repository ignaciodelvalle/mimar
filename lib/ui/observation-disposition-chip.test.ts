// Unit tests for observationDispositionChip — the /admin/observaciones
// disposal chip contract (surveillance-disposal slice, S3).

import { describe, expect, it } from "vitest";

import { observationDispositionChip } from "@/lib/ui/observation-disposition-chip";

const nonCompliantDeath = {
  dispositionMethod: "owner_burial",
  duringRabiesObservation: true,
};

describe("observationDispositionChip", () => {
  it("renders a danger chip for a non-recommended disposal during observation", () => {
    expect(observationDispositionChip("completed_dead", nonCompliantDeath)).toEqual({
      label: "Entierro en domicilio",
      tone: "danger",
    });
    expect(
      observationDispositionChip("completed_dead", {
        dispositionMethod: "household_waste",
        duringRabiesObservation: true,
      }),
    ).toEqual({ label: "Residuos domiciliarios", tone: "danger" });
  });

  it("stays neutral for a compliant channel even during observation", () => {
    expect(
      observationDispositionChip("completed_dead", {
        dispositionMethod: "cremation_collective",
        duringRabiesObservation: true,
      }),
    ).toEqual({ label: "Cremación colectiva", tone: "neutral" });
  });

  it("stays neutral when the death event does not carry during_rabies_observation", () => {
    // Older rows predate the flag (optional in the schema) — without it we
    // cannot honestly assert the death fell inside the observation window.
    expect(
      observationDispositionChip("completed_dead", {
        dispositionMethod: "owner_burial",
        duringRabiesObservation: false,
      }),
    ).toEqual({ label: "Entierro en domicilio", tone: "neutral" });
  });

  it("labels a missing method 'Sin especificar', neutral", () => {
    expect(
      observationDispositionChip("completed_dead", {
        dispositionMethod: null,
        duringRabiesObservation: true,
      }),
    ).toEqual({ label: "Sin especificar", tone: "neutral" });
  });

  it("renders nothing for rows that are not completed_dead", () => {
    expect(observationDispositionChip("in_progress", nonCompliantDeath)).toBeNull();
    expect(observationDispositionChip("completed_negative", nonCompliantDeath)).toBeNull();
  });

  it("renders nothing when no death event was found", () => {
    expect(observationDispositionChip("completed_dead", null)).toBeNull();
  });
});

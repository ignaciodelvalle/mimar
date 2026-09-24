// UI-7 Part C — gov welfare timeline merges case_events (reporter comments +
// org intervention notes). Unit test for the pure summary mapper.

import { describe, expect, it } from "vitest";

import { caseEventTimelineSummary } from "@/lib/analytics/govt-dashboards";

describe("caseEventTimelineSummary", () => {
  it("renders reporter comments with their text", () => {
    const s = caseEventTimelineSummary("reporter_comment", "El animal sigue ahí.", {
      source: "reporter",
    });
    expect(s).toBe("Comentario del denunciante: El animal sigue ahí.");
  });

  it("renders org intervention taken with the org name", () => {
    const s = caseEventTimelineSummary("org_intervention_taken", null, {
      orgDisplayName: "Refugio Sur",
    });
    expect(s).toContain("Refugio Sur");
    expect(s).toContain("tomó la denuncia");
  });

  it("renders org intervention notes with org name and text", () => {
    const s = caseEventTimelineSummary("org_intervention_note", "Rescate completado.", {
      orgDisplayName: "Refugio Sur",
    });
    expect(s).toContain("Refugio Sur");
    expect(s).toContain("Rescate completado.");
  });

  it("renders org returns with the reason", () => {
    const s = caseEventTimelineSummary("org_intervention_return", "Sin capacidad esta semana.", {
      orgDisplayName: "Refugio Sur",
    });
    expect(s).toContain("Refugio Sur");
    expect(s).toContain("Sin capacidad esta semana.");
  });

  it("returns null for unknown / internal entry types (hidden from gov timeline)", () => {
    expect(caseEventTimelineSummary("some_internal_event", "x", {})).toBeNull();
  });
});

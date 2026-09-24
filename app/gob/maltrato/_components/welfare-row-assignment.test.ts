// Unit tests for resolveAssignmentDisplay — the row's assignment-state pill
// (C6c workqueue grammar, plan-maestro-integridad.md §C6).

import { describe, expect, it } from "vitest";

import { resolveAssignmentDisplay } from "./welfare-row-assignment";

describe("resolveAssignmentDisplay", () => {
  it("no assignee → 'Sin asignar' with open (amber) tone", () => {
    const result = resolveAssignmentDisplay(null, null, "viewer-01");
    expect(result).toEqual({ tone: "open", label: "Sin asignar" });
  });

  it("assignee is the viewer → 'Mía' with triaged (blue) tone", () => {
    const result = resolveAssignmentDisplay("viewer-01", "Cualquier Nombre", "viewer-01");
    expect(result).toEqual({ tone: "triaged", label: "Mía" });
  });

  it("assignee is someone else with a resolved name → 'Asignada a {nombre}' with neutral tone", () => {
    const result = resolveAssignmentDisplay("agent-02", "Lucía Gómez", "viewer-01");
    expect(result).toEqual({ tone: "neutral", label: "Asignada a Lucía Gómez" });
  });

  it("assignee is someone else with NO resolved name → falls back to 'un agente'", () => {
    const result = resolveAssignmentDisplay("agent-02", null, "viewer-01");
    expect(result).toEqual({ tone: "neutral", label: "Asignada a un agente" });
  });

  it("never confuses 'Mía' with an unresolved-name 'other' case (distinct ids)", () => {
    const mine = resolveAssignmentDisplay("viewer-01", null, "viewer-01");
    const other = resolveAssignmentDisplay("agent-99", null, "viewer-01");
    expect(mine.label).toBe("Mía");
    expect(other.label).not.toBe("Mía");
  });
});

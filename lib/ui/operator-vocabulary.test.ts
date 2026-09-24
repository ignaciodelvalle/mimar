import { describe, expect, it } from "vitest";

import { OPERATOR_GLOSSARY, acronymPurpose, expandAcronym } from "./operator-vocabulary";

describe("OPERATOR_GLOSSARY", () => {
  it("catalogues RUPGA, PPP, ENO, AMR, SLA, MPF with a non-empty expansion + purpose + source", () => {
    for (const acronym of ["RUPGA", "PPP", "ENO", "AMR", "SLA", "MPF"]) {
      const entry = OPERATOR_GLOSSARY[acronym];
      expect(entry, `missing glossary entry for ${acronym}`).toBeDefined();
      expect(entry.expansion.length).toBeGreaterThan(0);
      expect(entry.purpose.length).toBeGreaterThan(0);
      expect(entry.source.length).toBeGreaterThan(0);
      // Never a placeholder — the sourcing rule forbids inventing an expansion.
      expect(entry.expansion.toUpperCase()).not.toContain("TODO");
    }
  });
});

describe("expandAcronym", () => {
  it("returns 'Expansión (SIGLA)' for a catalogued acronym", () => {
    expect(expandAcronym("RUPGA")).toBe(
      "Registro de Usuarias y Usuarios de Perros de Guía o de Asistencia (RUPGA)",
    );
    expect(expandAcronym("ENO")).toBe("Enfermedades de Notificación Obligatoria (ENO)");
  });

  it("returns the acronym unexpanded (never invented) for an uncatalogued term", () => {
    expect(expandAcronym("XYZ")).toBe("XYZ");
  });
});

describe("acronymPurpose", () => {
  it("returns the one-line purpose for a catalogued acronym", () => {
    expect(acronymPurpose("SLA")).toMatch(/plazo/i);
  });

  it("returns null for an uncatalogued acronym", () => {
    expect(acronymPurpose("XYZ")).toBeNull();
  });
});

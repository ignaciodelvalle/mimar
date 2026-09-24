// Tests for <TravelSemaforo> (movilidad-jurisdiccional Fase 1, R4.1/S9 + R3.5/S13).
// Pattern: renderToStaticMarkup (LnEmptyState precedent).

import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TravelSemaforo } from "./TravelSemaforo";

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

const CORRIDOR = {
  id: "chile" as const,
  label: "Chile",
  version: "2026.0",
  effectiveFrom: "2026-07-04",
  sourceUrl: "https://www.sag.gob.cl",
};

describe("<TravelSemaforo>", () => {
  it("rojo: renders the blocker state label", () => {
    const html = render(<TravelSemaforo semaforo="rojo" corridors={[CORRIDOR]} />);
    expect(html).toContain("No viajar todavía");
  });

  it("amarillo: renders the warning state label", () => {
    const html = render(<TravelSemaforo semaforo="amarillo" corridors={[CORRIDOR]} />);
    expect(html).toContain("Revisar pendientes");
  });

  it("verde: renders the all-clear state label", () => {
    const html = render(<TravelSemaforo semaforo="verde" corridors={[CORRIDOR]} />);
    expect(html).toContain("Requisitos en orden");
  });

  // QA histórico 2026-07-08 item 3: a foreign destination with no resolved
  // corridor previously fell through to "verde" — a green that verifies
  // nothing. sin_datos must render honest copy, never the all-clear label.
  it("sin_datos: renders the honest no-verification label, not a false verde", () => {
    const html = render(<TravelSemaforo semaforo="sin_datos" corridors={[]} />);
    expect(html).toContain("Verificación no disponible");
    expect(html).not.toContain("Requisitos en orden");
  });

  it("S13: always renders the staleness disclaimer", () => {
    const html = render(<TravelSemaforo semaforo="verde" corridors={[CORRIDOR]} />);
    expect(html).toContain("Verificá con SENASA");
  });

  it("S13: renders each corridor's version and effectiveFrom", () => {
    const html = render(<TravelSemaforo semaforo="amarillo" corridors={[CORRIDOR]} />);
    expect(html).toContain("2026.0");
    expect(html).toContain("2026-07-04");
    expect(html).toContain("Chile");
  });

  it("is announced as a status region for assistive tech (semantic <output>)", () => {
    const html = render(<TravelSemaforo semaforo="rojo" corridors={[CORRIDOR]} />);
    expect(html).toMatch(/<output[\s>]/);
  });
});

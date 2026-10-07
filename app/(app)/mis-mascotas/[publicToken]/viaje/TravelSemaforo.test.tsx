// Tests for <TravelSemaforo> (movilidad-jurisdiccional Fase 1, R4.1/S9 + R3.5/S13;
// viajes-fase-2 task 5.2: the labels come from lib/domain/travel-copy.ts).
// Pattern: renderToStaticMarkup (LnEmptyState precedent).

import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  TRAVEL_FORBIDDEN_COPY,
  TRAVEL_SEMAFORO_LABELS,
  type TravelSemaforoState,
} from "@/lib/domain/travel-copy";
import type { TravelSemaforo as ProjectionSemaforo } from "@/lib/projections/travel-compliance";

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
  // PO 2026-10-01: red says what is pending, never that the trip is blocked —
  // the authority and the airline decide that, not miMAR.
  it("rojo: renders the pending-requirements label", () => {
    const html = render(<TravelSemaforo semaforo="rojo" corridors={[CORRIDOR]} />);
    expect(html).toContain("Hay requisitos pendientes");
    expect(html).not.toContain("bloquean");
  });

  it("amarillo: renders the warning state label", () => {
    const html = render(<TravelSemaforo semaforo="amarillo" corridors={[CORRIDOR]} />);
    expect(html).toContain("Revisar pendientes");
  });

  it("verde: says what was checked, never that the animal may travel", () => {
    const html = render(<TravelSemaforo semaforo="verde" corridors={[CORRIDOR]} />);
    expect(html).toContain("Sin pendientes detectados");
    expect(html).not.toContain("Requisitos en orden");
  });

  // QA histórico 2026-07-08 item 3: a foreign destination with no resolved
  // corridor previously fell through to "verde" — a green that verifies
  // nothing. sin_datos must render honest copy, never the all-clear label.
  it("sin_datos: renders the honest no-verification label, not a false verde", () => {
    const html = render(<TravelSemaforo semaforo="sin_datos" corridors={[]} />);
    expect(html).toContain("Verificación no disponible");
    expect(html).not.toContain("Sin pendientes detectados");
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

  it("renders the trip it reads, when given one", () => {
    const html = render(
      <TravelSemaforo semaforo="amarillo" corridors={[CORRIDOR]} tripSummary="Chile, 12/11/2026" />,
    );
    expect(html).toContain("Chile, 12/11/2026");
  });
});

describe("travel-copy semáforo labels", () => {
  it("covers exactly the projection's four states", () => {
    const states: ProjectionSemaforo[] = ["rojo", "amarillo", "verde", "sin_datos"];
    const sameSet: TravelSemaforoState[] = states;
    expect(Object.keys(TRAVEL_SEMAFORO_LABELS).sort()).toEqual([...sameSet].sort());
  });

  it("no label promises: no 'apto', 'cumple', 'en orden' or 'listo para viajar'", () => {
    for (const label of Object.values(TRAVEL_SEMAFORO_LABELS)) {
      expect(label).not.toMatch(TRAVEL_FORBIDDEN_COPY);
    }
    expect(TRAVEL_SEMAFORO_LABELS.verde).toBe("Sin pendientes detectados");
  });
});

describe("<TravelSemaforo> — the pase (v14)", () => {
  const pass = {
    destination: "Chile",
    countdown: "faltan 39 días",
    meta: "Domingo 15/11/2026 · LATAM, en cabina",
    tally: "3 cosas por resolver · 2 ya están",
    past: false,
  };

  it("draws the destination, the countdown, the day and the tally over the server's label", () => {
    const html = render(<TravelSemaforo semaforo="amarillo" corridors={[CORRIDOR]} pass={pass} />);
    for (const text of [
      "Chile",
      "faltan 39 días",
      "Domingo 15/11/2026 · LATAM, en cabina",
      "3 cosas por resolver · 2 ya están",
      "Revisar pendientes",
    ]) {
      expect(html).toContain(text);
    }
  });

  it("says the disclaimer exactly once, and the airline notice only when given", () => {
    const html = render(<TravelSemaforo semaforo="verde" corridors={[CORRIDOR]} pass={pass} />);
    expect(html.split("Verificá con SENASA").length - 1).toBe(1);
    expect(html).not.toContain("Verificá con tu aerolínea");
    const withAirline = render(
      <TravelSemaforo
        semaforo="verde"
        corridors={[CORRIDOR]}
        pass={pass}
        airlineNotice="Verificá con tu aerolínea: LATAM"
      />,
    );
    expect(withAirline).toContain("Verificá con tu aerolínea: LATAM");
  });
});

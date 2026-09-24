// The two rabies counters on /gob/vigilancia must never read as one number
// contradicting itself (demo review 2026-08-01, finding #5).

import { describe, expect, it } from "vitest";

import {
  RABIES_CASES_KPI_CAVEAT,
  RABIES_CASES_KPI_LABEL,
  biteEscalationSub,
} from "@/app/gob/vigilancia/_components/rabies-counter-labels";
import { KPI_CATALOG } from "@/lib/metrics/kpi-catalog";

describe("rabies counter labels", () => {
  it("the case counter names its unit instead of the old vague 'Rábicas activas'", () => {
    // The screen hard-coded "Rábicas activas" — which names neither the unit
    // (an expediente) nor the fact that it is a stock of open files — while the
    // catalog entry it points at already had the precise label.
    expect(RABIES_CASES_KPI_LABEL).toBe(KPI_CATALOG.rabies_observation_cases_open.label);
    expect(RABIES_CASES_KPI_LABEL).toMatch(/casos/i);
    expect(RABIES_CASES_KPI_LABEL).not.toBe("Rábicas activas");
  });

  it("the escalation sub names MASCOTAS, so it cannot be read as the case count", () => {
    // THE FINDING: this line read "vs 1 observaciones rábicas abiertas" beside a
    // tile reading "RÁBICAS ACTIVAS 12". Same subject, near-identical wording,
    // two numbers, no text anywhere saying they were different counters.
    expect(biteEscalationSub(1)).toBe(
      "vs 1 mascota en observación rábica hoy — la ausencia de escalamiento no implica ausencia de riesgo",
    );
    expect(biteEscalationSub(12)).toBe(
      "vs 12 mascotas en observación rábica hoy — la ausencia de escalamiento no implica ausencia de riesgo",
    );
    expect(biteEscalationSub(0)).toContain("0 mascotas");
  });

  it("no rabies figure on the screen shares a unit noun with another", () => {
    // The distinction has to survive a reader who only skims the nouns: one
    // counter says "casos", the other says "mascotas". If either ever borrows
    // the other's noun the screen is back to publishing two contradictory
    // answers to what looks like one question.
    const caseNouns = RABIES_CASES_KPI_LABEL.toLocaleLowerCase("es-AR");
    const petNouns = biteEscalationSub(3).toLocaleLowerCase("es-AR");
    expect(caseNouns).toContain("casos");
    expect(caseNouns).not.toContain("mascota");
    expect(petNouns).toContain("mascotas");
    expect(petNouns).not.toContain("caso");
  });

  it("the escalation sub keeps the red-team #6 clause about unescalated reports", () => {
    // An empty observation queue reads as "controlado" when it may mean "sin
    // escalar" — naming the unit must not cost the epistemic warning.
    expect(biteEscalationSub(0)).toContain(
      "la ausencia de escalamiento no implica ausencia de riesgo",
    );
  });

  it("the case tile's caveat points the reader at BOTH of the other rabies figures", () => {
    // A reader who spots two rabies numbers needs the page itself to explain
    // the difference — and to say which one is the legal-deadline verdict.
    expect(RABIES_CASES_KPI_CAVEAT).toMatch(/expedientes/i);
    expect(RABIES_CASES_KPI_CAVEAT).toMatch(/mascotas/i);
    expect(RABIES_CASES_KPI_CAVEAT).toContain("Brecha de escalamiento");
    expect(RABIES_CASES_KPI_CAVEAT).toContain("Cumplimiento del plazo de observación");
    // It must not promise the two counts agree — on live data they do not.
    expect(RABIES_CASES_KPI_CAVEAT).toContain("pueden no coincidir");
  });
});

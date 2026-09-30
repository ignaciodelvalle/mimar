// Tests for <TravelObligationsPanel> (movilidad-jurisdiccional Fase 1, R4.1/R2.5).
// New thin panel (design D5) — does NOT widen ObligationKey/ComplianceObligationsPanel.

import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { TravelObligation } from "@/lib/projections/travel-compliance";
import { TravelObligationsPanel } from "./TravelObligationsPanel";

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

const BLOCKER: TravelObligation = {
  id: "rabies_vaccination_to_travel_wait_days",
  key: "rabies_vaccination_to_travel_wait_days",
  group: "libreta",
  sources: [],
  freshnessNotice: null,
  label: "Vacuna antirrábica · espera previa al viaje",
  state: "Plazo vencido",
  tone: "due",
  detail: "Mínimo 21 días entre la vacuna antirrábica y el viaje",
  legalFootnote: "Regla del corredor de viaje · Chile",
  requirementLevel: "blocker",
  contributingJurisdictions: ["Chile"],
};

const INFO: TravelObligation = {
  id: "required_documents",
  key: "required_documents",
  group: "destino",
  sources: [],
  freshnessNotice: "Verificá — dato sin confirmar con la fuente",
  label: "Documentación a presentar",
  state: "A presentar",
  tone: "neutral",
  detail: "health_certificate · rabies_certificate",
  legalFootnote: "Regla del corredor de viaje · Chile · Uruguay",
  requirementLevel: "info",
  contributingJurisdictions: ["Chile", "Uruguay"],
};

describe("<TravelObligationsPanel>", () => {
  it("renders each obligation's label, state and detail", () => {
    const html = render(<TravelObligationsPanel obligations={[BLOCKER, INFO]} />);
    expect(html).toContain("Vacuna antirrábica · espera previa al viaje");
    expect(html).toContain("Plazo vencido");
    expect(html).toContain("Mínimo 21 días entre la vacuna antirrábica y el viaje");
    expect(html).toContain("Documentación a presentar");
  });

  it("renders the legal footnote per obligation", () => {
    const html = render(<TravelObligationsPanel obligations={[BLOCKER]} />);
    expect(html).toContain("Regla del corredor de viaje · Chile");
  });

  it("discloses contributing jurisdictions (why is this the requirement)", () => {
    const html = render(<TravelObligationsPanel obligations={[INFO]} />);
    expect(html).toContain("Chile");
    expect(html).toContain("Uruguay");
  });

  it("maps requirementLevel to a distinct es-AR badge", () => {
    const html = render(<TravelObligationsPanel obligations={[BLOCKER, INFO]} />);
    expect(html).toContain("Bloqueante");
    expect(html).toContain("Informativo");
  });

  it("renders the freshness notice of an obligation whose source is not fresh", () => {
    const html = render(<TravelObligationsPanel obligations={[BLOCKER, INFO]} />);
    expect(html).toContain("Verificá — dato sin confirmar con la fuente");
  });

  it("shows each source with the day it was last checked (design D5)", () => {
    const withSource: TravelObligation = {
      ...BLOCKER,
      sources: [
        {
          kind: "corridor",
          id: "chile",
          label: "Chile",
          sourceUrl: "https://www.sag.gob.cl",
          lastVerifiedAt: "2026-09-30",
          reviewBy: "2027-03-29",
          verification: "verified",
          note: null,
          freshness: "fresh",
        },
      ],
    };
    const html = render(<TravelObligationsPanel obligations={[withSource]} />);
    expect(html).toContain("Fuente: Chile");
    expect(html).toContain("revisada el 30/09/2026");
    expect(html).toContain('href="https://www.sag.gob.cl"');
  });

  it("renders an empty-list message when there are no obligations", () => {
    const html = render(<TravelObligationsPanel obligations={[]} />);
    expect(html).toContain("Sin requisitos");
  });
});

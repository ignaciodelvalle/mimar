// Structure tests for <SoloVetAgendaLanding> — the solo-clinic first-run gap
// (task #17). The solo path used to skip the onboarding checklist entirely,
// dropping a freshly-created solo vet into a dead empty agenda. These pin that
// an incomplete-setup solo org now renders "Primeros pasos" above the agenda,
// and that a complete setup (null steps) shows only the agenda.

import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SetupStep } from "@/lib/infra/org-setup-checklist";
import { SoloVetAgendaLanding } from "./SoloVetAgendaLanding";

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

const INCOMPLETE_STEPS: SetupStep[] = [
  {
    key: "coverage",
    label: "Zonas de cobertura",
    hint: "Definí las zonas donde trabajás.",
    href: "cobertura",
    cta: "Definir zonas",
    done: false,
    waitingOn: "org",
  },
  {
    key: "services",
    label: "Servicios",
    hint: "Cargá los servicios que ofrecés.",
    href: "servicios/nuevo",
    cta: "Cargar servicios",
    done: false,
    waitingOn: "org",
  },
];

describe("<SoloVetAgendaLanding> first-run checklist", () => {
  it("renders the setup checklist above the agenda when setup is incomplete", () => {
    const html = render(
      <SoloVetAgendaLanding
        orgToken="DIM-TEST-0001"
        orgName="Consultorio Test"
        appointments={[]}
        checklistSteps={INCOMPLETE_STEPS}
      />,
    );
    // "Primeros pasos" is the checklist heading — its presence proves the solo
    // path no longer skips onboarding.
    expect(html).toContain("Primeros pasos");
    expect(html).toContain("Zonas de cobertura");
    // The first pending step's CTA links into the org-relative route.
    expect(html).toContain("/org/DIM-TEST-0001/cobertura");
  });

  it("does not render the checklist when setup is complete (null steps)", () => {
    const html = render(
      <SoloVetAgendaLanding
        orgToken="DIM-TEST-0001"
        orgName="Consultorio Test"
        appointments={[]}
        checklistSteps={null}
      />,
    );
    expect(html).not.toContain("Primeros pasos");
    // The agenda itself still renders.
    expect(html).toContain("Agenda de hoy");
  });

  it("does not render the checklist when steps is an empty array", () => {
    const html = render(
      <SoloVetAgendaLanding
        orgToken="DIM-TEST-0001"
        orgName="Consultorio Test"
        appointments={[]}
        checklistSteps={[]}
      />,
    );
    expect(html).not.toContain("Primeros pasos");
  });
});

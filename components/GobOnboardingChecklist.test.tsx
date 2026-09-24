// Render tests for <GobOnboardingChecklist> — T4-O3, the /gob first-run
// onboarding checklist. Mirrors components/OrgSetupChecklist.test.tsx: the
// domain half is pinned in lib/infra/gob-onboarding-checklist.test.ts, this
// file pins what that produces ON SCREEN.

import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GobOnboardingChecklist } from "@/components/GobOnboardingChecklist";
import {
  type GobOnboardingInput,
  deriveOnboardingSteps,
} from "@/lib/infra/gob-onboarding-checklist";

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

const ALL_FALSE: GobOnboardingInput = {
  hasSeenGobHomeBefore: false,
  hasVisitedCola: false,
  hasVisitedPanorama: false,
  hasCampaignsInScope: false,
  hasVisitedCasos: false,
  hasExportActivity: false,
};

describe("<GobOnboardingChecklist> — progress counter", () => {
  it("counts all six steps in the denominator, none excluded", () => {
    const html = render(<GobOnboardingChecklist steps={deriveOnboardingSteps(ALL_FALSE)} />);
    expect(html).toContain("0");
    expect(html).toContain("6");
    expect(html).toContain("Progreso de configuración: 0 de 6 pasos completados");
  });

  it("advances the counter as steps flip done", () => {
    const steps = deriveOnboardingSteps({ ...ALL_FALSE, hasVisitedPanorama: true });
    const html = render(<GobOnboardingChecklist steps={steps} />);
    expect(html).toContain("Progreso de configuración: 1 de 6 pasos completados");
  });
});

describe("<GobOnboardingChecklist> — G1 (scope) has no CTA of its own", () => {
  it("renders the pending scope step with no anchor when it is the only pending step", () => {
    const steps = deriveOnboardingSteps({
      hasSeenGobHomeBefore: false,
      hasVisitedCola: true,
      hasVisitedPanorama: true,
      hasCampaignsInScope: true,
      hasVisitedCasos: true,
      hasExportActivity: true,
    });
    expect(steps.filter((s) => !s.done).map((s) => s.key)).toEqual(["scope"]);

    const html = render(<GobOnboardingChecklist steps={steps} />);
    expect(html).toContain("Conocé tu alcance");
    // Mutation guard (mirrors OrgSetupChecklist's "no anchor" test): dropping
    // the `step.href !== null` check on the CTA would still pass a bare
    // string-copy assertion — this counts anchors instead, so an
    // `<a href="null">` slipping through fails here even though the visible
    // text elsewhere looks identical.
    expect(html).not.toContain("<a ");
  });

  it("a pending step WITH a destination still renders its CTA link", () => {
    const steps = deriveOnboardingSteps(ALL_FALSE);
    const html = render(<GobOnboardingChecklist steps={steps} />);
    expect(html).toContain('href="/gob/panorama"');
    expect(html).toContain("Abrir panorama");
  });
});

describe("<GobOnboardingChecklist> — a done step never renders a CTA", () => {
  it("strikes through a done step's label and shows no button for it", () => {
    const steps = deriveOnboardingSteps({ ...ALL_FALSE, hasVisitedPanorama: true });
    const html = render(<GobOnboardingChecklist steps={steps} />);
    // The panorama CTA must not render once done — only the other four
    // pending steps' CTAs should be present.
    expect(html).not.toContain(">Abrir panorama<");
    expect(html).toContain("line-through");
  });
});

describe("<GobOnboardingChecklist> — the 'approvals' step points at /gob/cola", () => {
  it("renders the CTA for pending vet/organization approvals", () => {
    const steps = deriveOnboardingSteps(ALL_FALSE);
    const html = render(<GobOnboardingChecklist steps={steps} />);
    expect(html).toContain("Aprobá veterinarios y organizaciones");
    expect(html).toContain('href="/gob/cola"');
    expect(html).toContain("Ver aprobaciones");
  });

  it("stops rendering its CTA once the operator has visited /gob/cola", () => {
    const steps = deriveOnboardingSteps({ ...ALL_FALSE, hasVisitedCola: true });
    const html = render(<GobOnboardingChecklist steps={steps} />);
    expect(html).not.toContain(">Ver aprobaciones<");
  });
});

describe("<GobOnboardingChecklist> — G3 never links to a campaign-creation route", () => {
  it("points 'Ver campañas' at the read-only campaigns dashboard, not a create form", () => {
    const steps = deriveOnboardingSteps(ALL_FALSE);
    const html = render(<GobOnboardingChecklist steps={steps} />);
    // Guards against the doc's literal (but non-existent, for a govt
    // operator) "Nueva campaña" CTA reappearing — see the header note in
    // lib/infra/gob-onboarding-checklist.ts for why.
    expect(html).toContain('href="/gob/operativos?vista=campanas"');
    expect(html).not.toContain("Nueva campaña");
  });
});

describe("<GobOnboardingChecklist> — hides entirely only via the parent's isOnboardingComplete gate", () => {
  it("still renders a card (0-pending) when every step is done — hiding is the caller's job", () => {
    const steps = deriveOnboardingSteps({
      hasSeenGobHomeBefore: true,
      hasVisitedCola: true,
      hasVisitedPanorama: true,
      hasCampaignsInScope: true,
      hasVisitedCasos: true,
      hasExportActivity: true,
    });
    const html = render(<GobOnboardingChecklist steps={steps} />);
    expect(html).toContain("Progreso de configuración: 6 de 6 pasos completados");
    expect(html).not.toContain("<a ");
  });
});

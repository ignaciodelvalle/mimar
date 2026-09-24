// Smoke test for <LnWizardShell> markup.
//
// LnWizardShell uses "use client" but has no hooks or browser APIs — it is
// purely props-driven, so renderToStaticMarkup produces deterministic markup.
// Assertions:
//  - renders children (step content)
//  - ln-* token present in markup
//  - zero occurrences of gob-* classes

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LnWizardShell } from "./WizardShell";

function render(props: Parameters<typeof LnWizardShell>[0]): string {
  return renderToStaticMarkup(<LnWizardShell {...props} />);
}

describe("<LnWizardShell>", () => {
  it("renders without throwing", () => {
    expect(() =>
      render({ currentStep: 1, totalSteps: 3, children: <p>step content</p> }),
    ).not.toThrow();
  });

  it("renders children (step content)", () => {
    const html = render({ currentStep: 2, totalSteps: 3, children: <p>hello wizard</p> });
    expect(html).toContain("hello wizard");
  });

  it("contains ln-* token classes and zero gob-* classes", () => {
    const html = render({ currentStep: 1, totalSteps: 4, children: <span>content</span> });
    expect(html).toContain("ln-");
    expect(html).not.toContain("gob-");
  });

  it("renders step counter text", () => {
    const html = render({ currentStep: 2, totalSteps: 5, children: null });
    expect(html).toContain("Paso 2 de 5");
  });

  it("renders step label when provided", () => {
    const html = render({
      currentStep: 1,
      totalSteps: 2,
      stepLabels: ["Datos básicos", "Confirmación"],
      children: null,
    });
    expect(html).toContain("Datos básicos");
  });

  it("renders cancel button when onCancel is provided", () => {
    const html = render({
      currentStep: 1,
      totalSteps: 3,
      onCancel: () => {},
      children: null,
    });
    expect(html).toContain("Cancelar y volver");
  });

  it("renders progress bar with role=progressbar", () => {
    const html = render({ currentStep: 2, totalSteps: 4, children: null });
    expect(html).toContain('role="progressbar"');
  });
});

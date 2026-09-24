// Smoke tests for <LnMaintenanceScreen>.
// Pattern: renderToStaticMarkup (see components/ErrorBoundary.test.tsx, the
// structural precedent this component mirrors — icon circle + h1 + body).

import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LnMaintenanceScreen } from "./MaintenanceScreen";

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

describe("<LnMaintenanceScreen>", () => {
  it("renders without crashing", () => {
    const html = render(<LnMaintenanceScreen />);
    expect(html.length).toBeGreaterThan(0);
  });

  it("renders the exact copy — heading + body (split at the natural em-dash break)", () => {
    const html = render(<LnMaintenanceScreen />);
    expect(html).toContain("En mantenimiento");
    expect(html).toContain(
      "Volvé en unos minutos. Estamos actualizando miMAR; tu información está segura.",
    );
  });

  it('renders an <output> card (implicit "status" role — passive informational state, not an alert)', () => {
    const html = render(<LnMaintenanceScreen />);
    // <output>'s implicit ARIA role is "status" — biome's
    // lint/a11y/useSemanticElements forbids an explicit role="status" on any
    // element in favor of this semantic tag itself.
    expect(html).toContain("<output");
    expect(html).not.toContain('role="alert"');
  });

  it("renders no action button (nothing to retry)", () => {
    const html = render(<LnMaintenanceScreen />);
    expect(html).not.toContain("<button");
  });

  it("contains --color-ln-* token classes and zero --color-ln-op-*", () => {
    const html = render(<LnMaintenanceScreen />);
    expect(html).toMatch(/--color-ln-/);
    expect(html).not.toMatch(/--color-ln-op-/);
  });
});

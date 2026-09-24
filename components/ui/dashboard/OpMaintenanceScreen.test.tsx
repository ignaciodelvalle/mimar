// Smoke tests for <OpMaintenanceScreen>.
// Pattern: renderToStaticMarkup (see components/ui/MaintenanceScreen.test.tsx —
// the Ln sibling this mirrors).

import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OpMaintenanceScreen } from "./OpMaintenanceScreen";

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

describe("<OpMaintenanceScreen>", () => {
  it("renders without crashing", () => {
    const html = render(<OpMaintenanceScreen />);
    expect(html.length).toBeGreaterThan(0);
  });

  it("renders the exact copy — heading + body (split at the natural em-dash break)", () => {
    const html = render(<OpMaintenanceScreen />);
    expect(html).toContain("En mantenimiento");
    expect(html).toContain(
      "Volvé en unos minutos. Estamos actualizando miMAR; tu información está segura.",
    );
  });

  it('renders an <output> card (implicit "status" role — passive informational state, not an alert)', () => {
    const html = render(<OpMaintenanceScreen />);
    // <output>'s implicit ARIA role is "status" — biome's
    // lint/a11y/useSemanticElements forbids an explicit role="status" on any
    // element in favor of this semantic tag itself.
    expect(html).toContain("<output");
    expect(html).not.toContain('role="alert"');
  });

  it("renders no action link (nothing to navigate to during maintenance)", () => {
    const html = render(<OpMaintenanceScreen />);
    expect(html).not.toContain("<a ");
  });

  it("contains --color-ln-op-* token classes (operator skin)", () => {
    const html = render(<OpMaintenanceScreen />);
    expect(html).toMatch(/--color-ln-op-/);
  });
});

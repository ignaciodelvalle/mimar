// Structural smoke tests for <CopyButton> (UX 3.6 c).
//
// Render via react-dom/server → HTML string (same pattern as the form smoke
// tests). useState renders its initial state; onClick is not part of static
// markup, so we assert the resting label + the accessible aria-label that
// exposes the value being copied.

import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CopyButton } from "@/components/ui/CopyButton";

function render(node: ReactElement): string {
  return renderToStaticMarkup(node);
}

describe("<CopyButton>", () => {
  it("renders the default label and an aria-label that includes the text", () => {
    const html = render(<CopyButton text="DIM-4AZ2-4GN6" />);
    expect(html).toContain("Copiar");
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-label="Copiar: DIM-4AZ2-4GN6"');
  });

  it("supports a custom label", () => {
    const html = render(<CopyButton text="ABC123" label="Copiar token" />);
    expect(html).toContain("Copiar token");
    expect(html).toContain('aria-label="Copiar token: ABC123"');
  });
});

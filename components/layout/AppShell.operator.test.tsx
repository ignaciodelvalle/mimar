// PR-1 V1 — the operator shell keeps the demo banner INSIDE the viewport-locked
// column so the document never exceeds the viewport (no external scroll, no
// clipped rail footer). The column is pinned with `fixed inset-0` (taken out of
// document flow) so the document itself can never scroll — the inner area
// scrolls instead. Pattern: renderToStaticMarkup (AppShell is a server component).

import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AppShell } from "./AppShell";

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

describe("AppShell variant=operator — banner inside the viewport-locked shell (PR-1 V1)", () => {
  it("renders the banner inside a fixed inset-0 flex-col column, above the rail", () => {
    const html = render(
      <AppShell
        variant="operator"
        banner={<div data-testid="demo-banner">Datos de demostración</div>}
        rail={<div data-testid="rail">rail</div>}
        topbar={<div data-testid="topbar">topbar</div>}
      >
        <div data-testid="page-body">contenido</div>
      </AppShell>,
    );
    expect(html).toContain("demo-banner");
    expect(html).toContain('data-testid="rail"');
    expect(html).toContain("page-body");
    // The shell is a single viewport-locked column (`fixed inset-0`): banner
    // stacks above the rail+main row, and the document itself never scrolls.
    expect(html).toContain("fixed inset-0");
    expect(html).toContain("flex-col");
    // Banner precedes the rail in document order (it is the top of the column).
    expect(html.indexOf("demo-banner")).toBeLessThan(html.indexOf('data-testid="rail"'));
    // Exactly one main landmark (no duplicate <main>).
    expect((html.match(/id="main-content"/g) ?? []).length).toBe(1);
  });

  it("omits the banner when none is passed (e.g. /gob) and stays a viewport-locked shell", () => {
    const html = render(
      <AppShell variant="operator" rail={<div data-testid="rail">rail</div>} topbar={<div>tb</div>}>
        <div>x</div>
      </AppShell>,
    );
    expect(html).not.toContain("demo-banner");
    expect(html).toContain("fixed inset-0");
    expect((html.match(/id="main-content"/g) ?? []).length).toBe(1);
  });
});

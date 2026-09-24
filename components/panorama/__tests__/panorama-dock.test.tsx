// PanoramaDock — the floating data dock's tab bar.
//
// T4.4 (2026-08-01): the Registros tab's bare count pill reads as an event
// count, but it is `mapTableRows.length` — TABLE ROWS (units × layers, a
// deliberate P4-U1 choice), not events. A funcionario comparing this number
// to "Eventos en el período" a few pixels away in the Registros pane sees two
// different numbers with no label explaining why. Pin the disclosure so a
// regression that drops the title/aria-label fails here.
//
// Pattern: renderToStaticMarkup — the dock is pure props → DOM (see
// panorama-dock-registros.test.tsx for the sibling pane's own suite).

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PanoramaDock } from "../PanoramaDock";

function render(recordCount = 42): string {
  return renderToStaticMarkup(
    <PanoramaDock
      open={false}
      onOpenChange={() => {}}
      tab="registros"
      onTabChange={() => {}}
      recordCount={recordCount}
      meta="Córdoba · últimos 90 días · 2 capas"
      registros={<div />}
      stats={<div />}
      referencias={<div />}
      timeline={<div />}
    />,
  );
}

describe("PanoramaDock — the Registros badge names what it counts", () => {
  it("carries a title disclosing rows, not events", () => {
    expect(render()).toContain('title="Filas en la tabla (unidades × capas), no eventos."');
  });

  it("carries an aria-label with the same disclosure and the live count", () => {
    const html = render(42);
    expect(html).toContain("42 filas en la tabla (unidades × capas), no eventos");
  });

  it("still renders the raw count as the pill's visible text", () => {
    expect(render(1234)).toContain("1.234");
  });
});

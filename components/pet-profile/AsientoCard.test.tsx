// AsientoCard — the action slot is additive, never either/or.
//
// "Pedir verificación" used to REPLACE "Ver detalle" on a self-declared
// vaccine, making it the only asiento type with no route to its own detail
// page — which is also the only place its photo attachment renders, so the
// photo was unreachable from the UI entirely (9-role external run,
// 2026-08-18).

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AsientoCard } from "./AsientoCard";
import type { AsientoView } from "./asiento-fields";

function view(overrides: Partial<AsientoView> = {}): AsientoView {
  return {
    kind: "VACUNA · OBLIGATORIA",
    title: "Antirrábica",
    icon: "vacuna",
    tint: "ln-ic-vac",
    whenRelative: "hoy",
    whenAbsolute: "18 ago 2026",
    facts: [],
    provenance: { verified: false, label: "Cargado por vos" },
    ...overrides,
  } as AsientoView;
}

describe("<AsientoCard> — action slot", () => {
  it("a verify-eligible asiento shows BOTH 'Pedir verificación' and 'Ver detalle'", () => {
    const html = renderToStaticMarkup(
      <AsientoCard view={view({ verifyHref: "/verificar" })} eventHref="/eventos/e1" />,
    );
    expect(html).toContain("Pedir verificación");
    expect(html).toContain("Ver detalle");
    expect(html).toContain('href="/eventos/e1"');
  });

  it("a plain asiento shows only 'Ver detalle'", () => {
    const html = renderToStaticMarkup(<AsientoCard view={view()} eventHref="/eventos/e2" />);
    expect(html).not.toContain("Pedir verificación");
    expect(html).toContain("Ver detalle");
  });
});

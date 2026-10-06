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

  it("hides the kind when it repeats the title, and drops a date that repeats the head", () => {
    const html = renderToStaticMarkup(
      <AsientoCard
        view={view({
          kind: "Credencial escaneada",
          title: "Credencial escaneada",
          facts: [
            { key: "Fecha", value: "18 ago 2026" },
            { key: "Lote", value: "A1" },
          ],
        })}
        eventHref="/eventos/e3"
      />,
    );
    expect(html).not.toContain("ln-asiento-kind");
    expect(html).not.toContain(">Fecha<");
    expect(html).toContain("Credencial escaneada");
    expect(html).toContain("Lote");
    expect(html).toContain("18 ago 2026");
  });

  it("keeps a kind that the title does not already say", () => {
    const html = renderToStaticMarkup(<AsientoCard view={view()} eventHref="/eventos/e4" />);
    expect(html).toContain("ln-asiento-kind");
    expect(html).toContain("Antirrábica");
  });

  it("a plain asiento shows only 'Ver detalle'", () => {
    const html = renderToStaticMarkup(<AsientoCard view={view()} eventHref="/eventos/e2" />);
    expect(html).not.toContain("Pedir verificación");
    expect(html).toContain("Ver detalle");
  });
});

// Regression guard: OpSubmitButton must render primary (blue, ln-op-azul),
// NOT green (ln-op-ok). This was the green/blue inconsistency fixed in F3.
//
// If someone accidentally reverts OpSubmitButton to a raw <button> with
// bg-ln-op-ok, this test fails immediately.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OpSubmitButton } from "@/components/ui/dashboard/OpField";

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

describe("OpSubmitButton — color token regression (F3 green→blue migration)", () => {
  it("renders primary blue (ln-op-azul) not green (ln-op-ok) in idle state", () => {
    const html = render(<OpSubmitButton pending={false}>Guardar</OpSubmitButton>);
    expect(html).toContain("ln-op-azul");
    expect(html).not.toContain("ln-op-ok");
  });

  it("renders primary blue (ln-op-azul) not green (ln-op-ok) while pending", () => {
    const html = render(<OpSubmitButton pending={true}>Guardar</OpSubmitButton>);
    expect(html).toContain("ln-op-azul");
    expect(html).not.toContain("ln-op-ok");
  });

  it("renders type=submit", () => {
    const html = render(<OpSubmitButton pending={false}>Guardar</OpSubmitButton>);
    expect(html).toContain('type="submit"');
  });

  it("is disabled when pending", () => {
    const html = render(<OpSubmitButton pending={true}>Guardar</OpSubmitButton>);
    expect(html).toContain("disabled");
  });

  it("shows pendingLabel when pending", () => {
    const html = render(
      <OpSubmitButton pending={true} pendingLabel="Guardando…">
        Guardar
      </OpSubmitButton>,
    );
    expect(html).toContain("Guardando…");
    expect(html).not.toContain(">Guardar<");
  });

  it("shows children label when idle", () => {
    const html = render(
      <OpSubmitButton pending={false} pendingLabel="Guardando…">
        Registrar asistencia
      </OpSubmitButton>,
    );
    expect(html).toContain("Registrar asistencia");
  });

  it("renders full-width (block)", () => {
    const html = render(<OpSubmitButton pending={false}>Guardar</OpSubmitButton>);
    expect(html).toContain("w-full");
  });
});

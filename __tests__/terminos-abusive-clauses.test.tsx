// @vitest-environment jsdom
//
// /terminos must not carry the three clauses the legal review of 2026-10-02
// found abusive (row P11 and D5; PO decision D2 = b, conservative interim),
// and must say what the product now does instead.
//
//   · "El uso del servicio implica la aceptación de estos términos" — acceptance
//     by mere use (Disp. 377/2026, inc. p);
//   · "En ningún caso seremos responsables por daños indirectos…" — held
//     unwritten against a consumer (Ley 24.240, art. 37 a; Disp. 377/2026,
//     inc. g);
//   · "Podemos actualizar estos términos. Los cambios relevantes se notificarán
//     por correo…" — unilateral change by notice (Disp. 377/2026, inc. b).
//
// The patterns match the CONCEPT, not one spelling of it, so a rewording of the
// same clause is still caught. Expected texts are written out, never read from
// the page's source.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import TerminosPage from "@/app/(institucional)/terminos/page";

afterEach(cleanup);

function pageText(): string {
  const view = render(<TerminosPage />);
  return (view.container.textContent ?? "").replace(/\s+/g, " ");
}

describe("/terminos — the clauses removed on 2026-10-07", () => {
  it("does not make use of the service an acceptance (inc. p)", () => {
    const text = pageText();
    expect(text).not.toMatch(/uso del servicio implica/i);
    expect(text).not.toMatch(/implica la aceptaci[oó]n/i);
    expect(text).not.toMatch(/al (usar|utilizar|navegar)[^.]*acept/i);
  });

  it("does not exclude liability for indirect damages (art. 37 a; inc. g)", () => {
    const text = pageText();
    expect(text).not.toMatch(/da[nñ]os indirectos/i);
    expect(text).not.toMatch(/en ning[uú]n caso seremos responsables/i);
  });

  it("does not let the terms change by a mere email notice (inc. b)", () => {
    const text = pageText();
    expect(text).not.toMatch(/se notificar[aá]n por correo/i);
    expect(text).not.toMatch(/podemos (actualizar|modificar|cambiar) estos t[eé]rminos/i);
  });

  it("says a substantive change is accepted again, and how to leave instead", () => {
    const text = pageText();
    expect(text).toContain(
      "Si cambiamos estos términos en algo importante, te vamos a pedir que los aceptes de nuevo antes de seguir usando tu cuenta.",
    );
    expect(text).toContain("podés descargar tus datos y eliminar tu cuenta");
  });

  it("states the interim 18+ requirement (review row P9)", () => {
    expect(pageText()).toContain("Para crear una cuenta tenés que tener 18 años o más.");
  });

  it("carries the bumped version (written out: a bump is a deliberate edit here)", () => {
    expect(pageText()).toContain("(v2026-10-07)");
  });
});

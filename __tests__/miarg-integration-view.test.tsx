// D3 — Mi Argentina illustrative close view tests.
//
// Asserts the page renders the non-hideable disclaimer + illustrative Mi
// Argentina content. Uses renderToStaticMarkup (the repo's component-test
// harness — no jsdom/testing-library).

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import IntegracionMiArgPage from "@/app/admin/acerca/integracion-miarg/page";

describe("D3 — /admin/acerca/integracion-miarg", () => {
  const html = renderToStaticMarkup(<IntegracionMiArgPage />);

  it("renders the disclaimer element", () => {
    expect(html).toContain('data-testid="miarg-disclaimer"');
  });

  it("disclaimer text contains the required copy", () => {
    expect(html).toContain("Integración en desarrollo");
    expect(html).toContain("vista ilustrativa");
  });

  it("disclaimer is announced (<output> status region) and not hidden", () => {
    // The disclaimer is an <output> (implicit status live region), announced and
    // visible. (A decorative aria-hidden on the flag emoji elsewhere is correct
    // and unrelated.) Nothing is display:none / visibility:hidden.
    expect(html).toContain("<output");
    expect(html).toContain('data-testid="miarg-disclaimer"');
    expect(html).not.toContain("display:none");
    expect(html).not.toContain("visibility:hidden");
  });

  it("renders illustrative Mi Argentina content", () => {
    expect(html).toContain("Mi Argentina");
  });
});

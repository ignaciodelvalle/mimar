// WP5 / D3 — PanoramaDemoDisclosure suppression: no double disclosure when the
// global demo banner is on.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PanoramaDemoDisclosure } from "@/components/panorama/PanoramaDemoDisclosure";

describe("PanoramaDemoDisclosure (D3)", () => {
  it("shows the synthetic-data notice by default", () => {
    const html = renderToStaticMarkup(<PanoramaDemoDisclosure />);
    expect(html).toContain("Datos de demostración");
  });

  it("renders nothing when hidden — the global banner already covers it", () => {
    const html = renderToStaticMarkup(<PanoramaDemoDisclosure hidden />);
    expect(html).toBe("");
  });
});

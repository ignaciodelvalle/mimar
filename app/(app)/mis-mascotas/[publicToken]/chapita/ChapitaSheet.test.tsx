// The chapita page draws its controls with the citizen kit's LnButton.
//
// It used to hand-build a <button> and a <Link> styled with the OPERATOR
// tier's radius token — an owner page wearing /gob's corners, and two controls
// that would not follow a change to the kit. These pin both doors to LnButton:
// the print button on the sheet, and the way out on the page shown where the
// printable QR is not enabled.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/infra/pet-access", () => ({
  requirePetAccess: async () => ({
    ok: true,
    pet: { name: "Pampa", jurisdictionProvince: "CABA", jurisdictionLocality: null },
  }),
}));
vi.mock("@/lib/infra/physical-credential-channels", () => ({
  resolvePhysicalCredentialChannels: async () => ({ printable_qr: false }),
}));
vi.mock("@/lib/infra/site-url", () => ({ resolveSiteUrl: () => "https://mimar.test" }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
}));

import { ChapitaSheet } from "./ChapitaSheet";
import ChapitaPage from "./page";

/** LnButton's own shape: the pill radius every citizen button wears. */
const LN_BUTTON_MARK = "rounded-[var(--radius-pill)]";
const OPERATOR_RADIUS = "--radius-op-btn";

describe("chapita — the print control", () => {
  it("is an LnButton that prints, not a hand-built button on the operator radius", () => {
    const html = renderToStaticMarkup(
      <ChapitaSheet petName="Pampa" publicToken="DIM-PAMP-0001" qrSvg="<svg></svg>" />,
    );
    const button = html.match(/<button[^>]*>[^<]*Imprimir<\/button>/)?.[0] ?? "";
    expect(button).not.toBe("");
    expect(button).toContain('type="button"');
    expect(button).toContain(LN_BUTTON_MARK);
    expect(html).not.toContain(OPERATOR_RADIUS);
  });
});

describe("chapita — where the printable QR is not enabled", () => {
  it("leaves through an LnButton link to the available channels", async () => {
    const html = renderToStaticMarkup(
      await ChapitaPage({ params: Promise.resolve({ publicToken: "DIM-PAMP-0001" }) }),
    );
    expect(html).toContain("El QR imprimible no está habilitado en tu zona.");
    const link = html.match(/<a[^>]*>Ver canales disponibles<\/a>/)?.[0] ?? "";
    expect(link).toContain('href="/mis-mascotas/DIM-PAMP-0001?sheet=chapita"');
    expect(link).toContain(LN_BUTTON_MARK);
    expect(html).not.toContain(OPERATOR_RADIUS);
  });
});

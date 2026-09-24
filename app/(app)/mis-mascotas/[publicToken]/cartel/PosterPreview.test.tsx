// Tests for <PosterPreview> — the printable lost-pet poster client component.
//
// Uses the same renderToStaticMarkup pattern as the project's component smoke
// tests: we render server-style static HTML and assert structural invariants.
// No browser APIs needed — the "use client" directive is irrelevant for
// renderToStaticMarkup (it renders synchronously in the test environment).

import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PosterPreview } from "./PosterPreview";

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

// Minimal base props used across most tests.
const BASE_PROPS = {
  publicToken: "DIM-TEST-1234",
  petName: "Luna",
  species: "Perro",
  breed: "Labrador",
  sex: "Hembra",
  sexRaw: "female",
  age: "3 años",
  color: "dorada",
  distinguishingFeatures: "mancha en la oreja derecha",
  photoUrl: null,
  placeName: "Parque Centenario",
  lastSeenAt: new Date("2026-05-01T12:00:00Z"),
  ownerFirstName: "María",
  ownerPhone: "+5491100000000",
  locationDisclosed: true,
  qrSvg:
    '<svg data-testid="qr" xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>',
};

describe("<PosterPreview> — structural invariants", () => {
  it("renders the pet name prominently", () => {
    const html = render(<PosterPreview {...BASE_PROPS} />);
    expect(html).toContain("Luna");
  });

  it("renders a sex-correct headline (PERDIDA for a female pet)", () => {
    const html = render(<PosterPreview {...BASE_PROPS} />);
    expect(html).toContain("PERDIDA");
  });

  it("renders PERDIDO for a male pet", () => {
    const html = render(<PosterPreview {...BASE_PROPS} sex="Macho" sexRaw="male" />);
    expect(html).toContain("PERDIDO");
    expect(html).not.toContain("PERDIDA");
  });

  it("renders SE BUSCA when the sex is not recorded — never a slashed headline", () => {
    const html = render(<PosterPreview {...BASE_PROPS} sex="No especificado" sexRaw="unknown" />);
    expect(html).toContain("SE BUSCA");
    expect(html).not.toContain("PERDIDO/A");
  });

  it("renders the QR container (dangerouslySetInnerHTML target)", () => {
    const html = render(<PosterPreview {...BASE_PROPS} />);
    // The qrSvg content is injected via dangerouslySetInnerHTML.
    expect(html).toContain('data-testid="qr-container"');
    // The SVG content from qrSvg should appear in the HTML.
    expect(html).toContain("qr");
  });
});

describe("<PosterPreview> — disclosure: phone NOT disclosed", () => {
  it("omits phone when ownerPhone is null", () => {
    const html = render(<PosterPreview {...BASE_PROPS} ownerPhone={null} ownerFirstName="María" />);
    // Phone number should not appear.
    expect(html).not.toContain("+5491100000000");
    // But the first name (which IS disclosed) should still appear.
    expect(html).toContain("María");
  });

  it("omits contact block entirely when both ownerFirstName and ownerPhone are null", () => {
    const html = render(<PosterPreview {...BASE_PROPS} ownerFirstName={null} ownerPhone={null} />);
    // The 📞 Contacto label should not appear when there's no contact info.
    expect(html).not.toContain("Contacto:");
  });
});

describe("<PosterPreview> — disclosure: last location NOT disclosed", () => {
  it("omits location section when locationDisclosed is false", () => {
    const html = render(
      <PosterPreview {...BASE_PROPS} locationDisclosed={false} placeName="Parque Centenario" />,
    );
    // Even if placeName is provided, it must NOT appear when not disclosed.
    expect(html).not.toContain("Parque Centenario");
    expect(html).not.toContain("Última vez vista");
  });

  it("shows location section when locationDisclosed is true and placeName is set", () => {
    const html = render(
      <PosterPreview {...BASE_PROPS} locationDisclosed={true} placeName="Parque Centenario" />,
    );
    expect(html).toContain("Parque Centenario");
    expect(html).toContain("Última vez vista");
  });
});

describe("<PosterPreview> — disclosure: ownerFirstName null but phone present", () => {
  it("renders phone without crashing when ownerFirstName is null", () => {
    const html = render(
      <PosterPreview {...BASE_PROPS} ownerFirstName={null} ownerPhone="+5491155551234" />,
    );
    // Contact block still renders with the phone only — no crash, name absent.
    expect(html).toContain("+5491155551234");
    expect(html).toContain("Contacto:");
    expect(html).not.toContain("María");
  });
});

describe("<PosterPreview> — no email leaks onto the poster", () => {
  it("does not render any email-looking content in the poster output", () => {
    // BASE_PROPS contains no email. The poster must never surface one even
    // if future props are added — discloseEmailWhenLost is intentionally not
    // wired to PosterPreview (phone/firstName/location only, per spec).
    const html = render(<PosterPreview {...BASE_PROPS} />);
    // No "@" character from an email address should appear.
    // (The QR SVG may contain xmlns="…" but no "@"-containing attribute value.)
    expect(html).not.toMatch(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  });
});

describe("<PosterPreview> — optional fields omitted when null", () => {
  it("omits color line when color is null", () => {
    const html = render(<PosterPreview {...BASE_PROPS} color={null} />);
    expect(html).not.toContain("Color:");
  });

  it("omits señas line when distinguishingFeatures is null", () => {
    const html = render(<PosterPreview {...BASE_PROPS} distinguishingFeatures={null} />);
    expect(html).not.toContain("Señas:");
  });

  it("renders a placeholder when photoUrl is null (shows first letter of name)", () => {
    const html = render(<PosterPreview {...BASE_PROPS} photoUrl={null} />);
    // Should show the first letter of the pet name as a fallback.
    expect(html).toContain("L");
  });
});

describe("<PosterPreview> — missing-photo pre-print warning (tester fix #3b)", () => {
  it("warns strongly and links to add a photo when photoUrl is null", () => {
    const html = render(<PosterPreview {...BASE_PROPS} photoUrl={null} />);
    expect(html).toContain("Sin foto, el cartel pierde casi todo su valor");
    expect(html).toContain("Agregar foto");
    expect(html).toContain("/mis-mascotas/DIM-TEST-1234?sheet=editar-mascota");
    // Print CTA is demoted (secondary styling), NOT removed — printing stays possible.
    expect(html).toContain("Imprimir cartel");
    expect(html).not.toContain(
      "bg-[var(--color-ln-azul)] text-white hover:bg-[var(--color-ln-azul-700)]",
    );
  });

  it("no warning and a primary print CTA when a photo exists", () => {
    const html = render(<PosterPreview {...BASE_PROPS} photoUrl="https://cdn.test/luna.jpg" />);
    expect(html).not.toContain("Sin foto, el cartel pierde casi todo su valor");
    expect(html).toContain(
      "bg-[var(--color-ln-azul)] text-white hover:bg-[var(--color-ln-azul-700)]",
    );
  });
});

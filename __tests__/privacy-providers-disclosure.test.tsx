// @vitest-environment jsdom
//
// /privacidad names every provider that processes personal data, with its
// country, and states the legal basis of the international transfer.
//
// WHY (finding S-2, PO decision 6A, 2026-09-24): Ley 25.326 art. 6 requires
// telling the holder who receives their data, and art. 12 forbids a transfer to
// a country without adequate protection unless the holder consents expressly.
// Brazil and the US are not on the AAIP adequacy list (Disposición DNPDP 60-E/2016, art. 3).
// Before this change the page named no provider and said nothing about the
// transfer, and Google Play's Data safety form has to match what this page says.
//
// The signup sentence consents to "los proveedores que se detallan en ella" and
// links to `#proveedores`, so that anchor is part of the consent: if the section
// loses its id, the consent points at nothing. That is pinned here too.
//
// The expected values are written out, never read from the page's source.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import PrivacidadPage from "@/app/(institucional)/privacidad/page";
import { LEGAL_VERSION } from "@/lib/reference/legal-version";

afterEach(cleanup);

function providersSection(): HTMLElement {
  const view = render(<PrivacidadPage />);
  const section = view.container.querySelector<HTMLElement>("section#proveedores");
  if (section === null) throw new Error("/privacidad has no section#proveedores");
  return section;
}

function text(el: HTMLElement): string {
  return (el.textContent ?? "").replace(/\s+/g, " ");
}

describe("/privacidad — providers and the international transfer", () => {
  it("has the anchor the signup consent links to", () => {
    const section = providersSection();
    expect(section.querySelector("h2")?.textContent).toBe(
      "Proveedores que procesan datos por cuenta de miMAR",
    );
  });

  it("names each provider with its country", () => {
    const items = Array.from(providersSection().querySelectorAll("li")).map(text);
    const expected: Array<[string, string]> = [
      ["Supabase", "Brasil"],
      ["Vercel", "Estados Unidos"],
      ["Sentry", "Estados Unidos"],
      ["Expo", "Estados Unidos"],
      ["Google Firebase Cloud Messaging", "Estados Unidos"],
      ["Resend", "Estados Unidos"],
      ["OpenStreetMap Foundation", "Reino Unido"],
    ];
    for (const [provider, country] of expected) {
      const item = items.find((i) => i.startsWith(provider));
      expect(item, `no list item for ${provider}`).toBeDefined();
      expect(item, `${provider} is listed without its country`).toContain(country);
    }
  });

  it("says Sentry gets the Android app's reports only, scrubbed", () => {
    const sentry = Array.from(providersSection().querySelectorAll("li"))
      .map(text)
      .find((i) => i.startsWith("Sentry"));
    expect(sentry).toContain("app de Android");
    expect(sentry).toContain("el sitio web no le envía nada");
    expect(sentry).toContain("no se envían capturas de pantalla");
  });

  it("discloses the /municipios contact form: sent by mail through Resend, not stored", () => {
    const body = text(providersSection());
    expect(body).toContain(
      "Formulario de contacto para organismos. Si completás el formulario de /municipios, tu nombre, organismo, cargo, correo y, si lo das, tu teléfono, se envían por correo electrónico a nuestro equipo a través de Resend (Estados Unidos). No los guardamos en nuestra base de datos; los usamos solo para responderte.",
    );
  });

  it("discloses the organization access-request form the same way (critique 2026-09-29, M8)", () => {
    const body = text(providersSection());
    expect(body).toContain(
      "Pedido de acceso para organizaciones. Si completás el formulario de /organizaciones/solicitar-acceso, tu nombre, el de tu organización, su localidad, tu correo y, si lo das, tu teléfono, se envían por correo electrónico a nuestro equipo a través de Resend (Estados Unidos). No los guardamos en nuestra base de datos; los usamos solo para responderte.",
    );
  });

  it("rests the transfer on express consent under art. 12, without claiming adequacy", () => {
    const body = text(providersSection());
    expect(body).toContain("Disposición DNPDP 60-E/2016");
    expect(body).not.toContain("Disposición AAIP");
    expect(body).toContain("consentimiento expreso");
    expect(body).toContain("art. 12 de la Ley 25.326");
    // No contract or clause is on file in this repo, so none may be claimed.
    expect(body).not.toMatch(/cláusulas contractuales|certificad/i);
  });

  it("carries the version that records this revision", () => {
    // A substantive revision bumps the version new acceptances record: first
    // the disclosure + consent by name (2026-09-24), then the separate transfer
    // box naming the countries (2026-10-07, legal review P10). Written out on
    // purpose.
    expect(LEGAL_VERSION).toBe("2026-10-07");
  });

  it("says the transfer consent is its own box, and that older accounts are asked again", () => {
    // Legal review 2026-10-02, row P10 (Dec. 1558/2001 art. 5 inc. 1): the
    // consent is given in a box apart from the one that accepts this policy,
    // and an account older than this version is asked for it at its next
    // sign-in (the re-acceptance screen). The page must say both, and no more.
    const body = text(providersSection());
    expect(body).toContain("con una casilla aparte de la que acepta esta política");
    expect(body).toContain(
      "si tu cuenta es anterior a esta versión, te lo pedimos la próxima vez que entres",
    );
  });
});

// Legal review 2026-10-02 (P2, P3, P6). The rest of the page, pinned on the
// rendered text so a rewrite cannot drop a mandatory legend or bring back a
// promise the append-only record cannot keep.
describe("/privacidad — mandatory legend and honest promises", () => {
  function pageText(): string {
    const view = render(<PrivacidadPage />);
    return text(view.container);
  }

  it("carries the AAIP legend verbatim (Res. AAIP 14/2018, art. 3)", () => {
    expect(pageText()).toContain(
      "LA AGENCIA DE ACCESO A LA INFORMACIÓN PÚBLICA, en su carácter de órgano de Control de la Ley N° 25.326, tiene la atribución de atender las denuncias y reclamos que interpongan quienes resulten afectados en sus derechos por incumplimiento de las normas vigentes en materia de protección de datos personales.",
    );
  });

  it("does not promise to erase sanitary records on request", () => {
    const body = pageText();
    expect(body).not.toContain("pedínoslo");
    expect(body).not.toContain("borremos");
    expect(body).toContain("se corrige con un registro nuevo y el original se conserva");
  });

  it("does not call the follow-up contact of a denuncia anonymous or unlinked", () => {
    const body = pageText();
    expect(body).not.toContain("no a ningún perfil de usuario");
    expect(body).toContain("si iniciaste sesión, tu cuenta");
    expect(body).toContain("y el equipo de miMAR");
  });

  it("does not invoke Ley 27.275, which does not reach a private operator", () => {
    expect(pageText()).not.toContain("27.275");
  });
});

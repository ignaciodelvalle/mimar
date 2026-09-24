/**
 * Structural + a11y tests for Wave 2 Item 12 — CaseStatusBadge, CaseDetailShell.
 *
 * Pattern: renderToStaticMarkup (repo convention — no jsdom required).
 *
 * Coverage:
 *  - CaseStatusBadge: all four statuses render Spanish labels; color not sole conveyor.
 *  - CaseStatusBadge: label override prop.
 *  - CaseDetailShell: publicCode rendered as badge.
 *  - CaseDetailShell: parties list hides personal names when isPublic=true.
 *  - CaseDetailShell: org name stays visible even when isPublic=true.
 *  - CaseDetailShell: unowned_animal subject renders graceful descriptor.
 *  - CaseDetailShell: location subject renders location descriptor.
 *  - CaseDetailShell: pet subject renders pet name.
 *  - CaseDetailShell: normatives rendered when supplied.
 *  - CaseDetailShell: empty parties list renders "Apertura automática" (internal).
 *  - CaseDetailShell: empty parties list renders "no disponible" (public).
 *  - CaseDetailShell: openedReason hidden when isPublic=true.
 *  - CaseDetailShell: openedReason shown when isPublic=false.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CaseDetailShell,
  type CaseParty,
  type CaseSubjectDescriptor,
} from "@/components/ui/dashboard/CaseDetailShell";
import { CaseStatusBadge } from "@/components/ui/dashboard/CaseStatusBadge";
import type { CaseStatus } from "@/db/schema";
import type { LawReference } from "@/lib/domain/case-normatives";

// ---------------------------------------------------------------------------
// CaseStatusBadge
// ---------------------------------------------------------------------------

describe("CaseStatusBadge — consistent cross-kind tones", () => {
  const CASES: Array<{ status: CaseStatus; expectedLabel: string }> = [
    { status: "open", expectedLabel: "Abierto" },
    { status: "escalated", expectedLabel: "Escalado" },
    { status: "closed", expectedLabel: "Cerrado" },
    { status: "merged", expectedLabel: "Fusionado" },
  ];

  for (const { status, expectedLabel } of CASES) {
    it(`status="${status}" renders human-readable label "${expectedLabel}"`, () => {
      const html = renderToStaticMarkup(<CaseStatusBadge status={status} />);
      expect(html).toContain(expectedLabel);
    });

    it(`status="${status}" does not expose the raw key as sole text`, () => {
      const html = renderToStaticMarkup(<CaseStatusBadge status={status} />);
      // The raw key "open" should not appear verbatim as user-visible text
      // (it must be replaced by the Spanish label).
      expect(html).not.toMatch(new RegExp(`>${status}</`));
    });
  }

  it("renders a custom label override when provided", () => {
    const html = renderToStaticMarkup(<CaseStatusBadge status="open" label="En curso" />);
    expect(html).toContain("En curso");
    expect(html).not.toContain("Abierto");
  });
});

// ---------------------------------------------------------------------------
// CaseDetailShell — structural tests (no jsdom, no DB)
// ---------------------------------------------------------------------------

const NOW = new Date("2026-06-18T10:00:00Z");

function makeShell(overrides: Partial<Parameters<typeof CaseDetailShell>[0]> = {}) {
  return renderToStaticMarkup(
    <CaseDetailShell
      publicCode="CAS-TEST-0001"
      kind="bite_incident"
      status="open"
      openedAt={NOW}
      jurisdictionCountry="AR"
      jurisdictionProvince="CABA"
      jurisdictionLocality="Palermo"
      {...overrides}
    />,
  );
}

describe("CaseDetailShell — header", () => {
  it("renders the publicCode in the badge", () => {
    const html = makeShell();
    expect(html).toContain("CAS-TEST-0001");
  });

  it("renders the status badge", () => {
    const html = makeShell({ status: "escalated" });
    expect(html).toContain("Escalado");
  });

  it("renders the case kind label", () => {
    const html = makeShell({ kind: "welfare_denuncia" });
    expect(html).toContain("Denuncia de bienestar");
  });
});

describe("CaseDetailShell — parties (PII gating)", () => {
  const parties: CaseParty[] = [
    { role: "opener", name: "Juan Pérez" },
    { role: "organization", name: "El Campito", orgPublicToken: "ORG-CAMP-0001" },
    { role: "closer", name: "María García" },
  ];

  it("shows personal names for authenticated (isPublic=false) viewers", () => {
    const html = makeShell({ parties, isPublic: false });
    expect(html).toContain("Juan Pérez");
    expect(html).toContain("María García");
    expect(html).toContain("El Campito");
  });

  it("hides personal names for public (isPublic=true) viewers", () => {
    const html = makeShell({ parties, isPublic: true });
    expect(html).not.toContain("Juan Pérez");
    expect(html).not.toContain("María García");
  });

  it("keeps org name visible for public viewers", () => {
    const html = makeShell({ parties, isPublic: true });
    expect(html).toContain("El Campito");
  });

  it("renders org as a link to /refugios/[token]", () => {
    const html = makeShell({ parties, isPublic: false });
    expect(html).toContain("/refugios/ORG-CAMP-0001");
  });

  it("shows 'Apertura automática del sistema' when parties empty and isPublic=false", () => {
    const html = makeShell({ parties: [], isPublic: false });
    expect(html).toContain("Apertura automática del sistema");
  });

  it("shows 'no disponibles' when parties empty and isPublic=true", () => {
    const html = makeShell({ parties: [], isPublic: true });
    expect(html).toContain("no disponibles");
  });
});

describe("CaseDetailShell — subject descriptor (edge cases)", () => {
  it("renders pet name and species for pet subject", () => {
    const subject: CaseSubjectDescriptor = {
      kind: "pet",
      petName: "Laika",
      petSpecies: "Perro · Hembra",
      petHref: "/mis-mascotas/DIM-1234-ABCD",
    };
    const html = makeShell({ subject });
    expect(html).toContain("Laika");
    expect(html).toContain("Perro · Hembra");
    expect(html).toContain("/mis-mascotas/DIM-1234-ABCD");
  });

  it("renders graceful descriptor for unowned_animal subject (no crash)", () => {
    const subject: CaseSubjectDescriptor = { kind: "unowned_animal" };
    const html = makeShell({ subject });
    expect(html).toContain("Animal sin identificar");
  });

  it("renders location descriptor with label when available", () => {
    const subject: CaseSubjectDescriptor = {
      kind: "location",
      locationLabel: "Palermo, CABA",
    };
    const html = makeShell({ subject });
    expect(html).toContain("Palermo, CABA");
  });

  it("renders generic location descriptor when locationLabel is absent", () => {
    const subject: CaseSubjectDescriptor = { kind: "location" };
    const html = makeShell({ subject });
    expect(html).toContain("Ubicación específica");
  });

  it("renders general descriptor for 'general' subject kind", () => {
    const subject: CaseSubjectDescriptor = { kind: "general" };
    const html = makeShell({ subject });
    expect(html).toContain("sin sujeto identificado");
  });
});

describe("CaseDetailShell — normativa", () => {
  const normatives: LawReference[] = [
    {
      id: "ley_test",
      label: "Ley Test 123",
      scope: "Alcance de la ley de prueba",
    },
    {
      id: "res_test",
      label: "Res. Test 456",
      scope: "Resolución de prueba",
      fullTextUrl: "https://example.com/res456",
    },
  ];

  it("renders normative labels and scope", () => {
    const html = makeShell({ normatives });
    expect(html).toContain("Ley Test 123");
    expect(html).toContain("Alcance de la ley de prueba");
    expect(html).toContain("Res. Test 456");
  });

  it("renders a link for normatives with fullTextUrl", () => {
    const html = makeShell({ normatives });
    expect(html).toContain("https://example.com/res456");
  });

  it("renders 'Sin norma específica' when normatives array is empty", () => {
    const html = makeShell({ normatives: [] });
    expect(html).toContain("Sin norma específica");
  });
});

describe("CaseDetailShell — openedReason PII gating", () => {
  it("hides openedReason for public viewers", () => {
    const html = makeShell({
      openedReason: "Motivo confidencial del operador",
      isPublic: true,
    });
    expect(html).not.toContain("Motivo confidencial del operador");
  });

  it("shows openedReason for authenticated viewers", () => {
    const html = makeShell({
      openedReason: "Motivo confidencial del operador",
      isPublic: false,
    });
    expect(html).toContain("Motivo confidencial del operador");
  });
});

describe("CaseDetailShell — a11y landmarks", () => {
  it("parties section has aria-label", () => {
    const html = makeShell();
    expect(html).toContain('aria-label="Partes del caso"');
  });

  it("jurisdiction section has aria-label", () => {
    const html = makeShell();
    expect(html).toContain('aria-label="Jurisdicción"');
  });

  it("normativa section has aria-label", () => {
    const html = makeShell();
    expect(html).toContain('aria-label="Normativa aplicable"');
  });
});

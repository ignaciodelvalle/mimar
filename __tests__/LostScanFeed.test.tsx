// Unit tests for <LostScanFeed> photo rendering (P0g).
//
// Tests verify:
//   1. Renders an <img> when a sighting item has a photoUrl.
//   2. Renders the "foto adjunta" text fallback when photoStoragePath is set
//      but photoUrl is absent (no signed URL resolved yet).
//   3. Renders neither photo nor "foto adjunta" when no photo fields are set.
//   4. Renders finder contact info when finderContact is set.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  LostScanFeed,
  type ScanFeedItem,
  relativeShort,
} from "@/components/pet-profile/LostScanFeed";
// The producer's literal, imported rather than retyped: the assertion below is
// about "the joined value", and the separator is what makes it recognisable.
import { CONTACT_SEPARATOR } from "@/lib/utils/contact-parts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSightingItem(
  overrides: Partial<Extract<ScanFeedItem, { kind: "sighting" }>> = {},
): ScanFeedItem {
  return {
    kind: "sighting",
    id: "test-sighting-id",
    at: new Date("2026-05-01T10:00:00Z"),
    description: "Vi un perro parecido.",
    localityLabel: null,
    lat: "-34.9",
    lng: "-57.9",
    ...overrides,
  };
}

function renderFeed(items: ScanFeedItem[]): string {
  return renderToStaticMarkup(
    React.createElement(LostScanFeed, {
      items,
      totalScans: 0,
      totalSightings: items.length,
    }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LostScanFeed — photo rendering (P0g)", () => {
  it("renders an <img> when the sighting item has a photoUrl", () => {
    const items = [makeSightingItem({ photoUrl: "https://cdn.example.com/signed/abc.jpg" })];
    const html = renderFeed(items);

    // An img element with the signed URL should be present.
    expect(html).toContain("<img");
    expect(html).toContain("https://cdn.example.com/signed/abc.jpg");
    // The alt text should be descriptive (in Spanish, per repo convention).
    expect(html).toContain("Foto adjunta al avistaje");
    // The "foto adjunta" text fallback should NOT appear when a real img is rendered.
    expect(html).not.toContain("foto adjunta");
  });

  it("renders 'foto adjunta' text fallback when photoStoragePath is set but photoUrl is absent", () => {
    const items = [makeSightingItem({ photoStoragePath: "finder/abc123.jpg", photoUrl: null })];
    const html = renderFeed(items);

    expect(html).not.toContain("<img");
    expect(html).toContain("foto adjunta");
  });

  it("renders neither photo nor text fallback when no photo fields are set", () => {
    const items = [makeSightingItem({ photoStoragePath: null, photoUrl: null })];
    const html = renderFeed(items);

    expect(html).not.toContain("<img");
    expect(html).not.toContain("foto adjunta");
  });

  it("renders finder contact info when finderContact is set", () => {
    const items = [makeSightingItem({ finderContact: "11-5555-1234" })];
    const html = renderFeed(items);

    expect(html).toContain("11-5555-1234");
    // The phone glyph is now a lucide icon routed through <Icon name="telefono">.
    expect(html).toContain('data-icon-name="telefono"');
  });

  it("renders nothing for photo/contact when neither is set", () => {
    const items = [
      makeSightingItem({ finderContact: null, photoStoragePath: null, photoUrl: null }),
    ];
    const html = renderFeed(items);

    expect(html).not.toContain('data-icon-name="telefono"');
    expect(html).not.toContain('data-icon-name="camara"');
    expect(html).not.toContain("<img");
  });
});

describe("relativeShort — pure given a fixed now", () => {
  const NOW = new Date("2026-07-04T12:00:00Z").getTime();

  it("is deterministic: same (date, now) yields the same label across calls", () => {
    const d = new Date("2026-07-04T09:30:00Z");
    expect(relativeShort(d, NOW)).toBe(relativeShort(d, NOW));
  });

  it("buckets elapsed time correctly against a frozen now", () => {
    expect(relativeShort(new Date("2026-07-04T11:59:40Z"), NOW)).toBe("ahora");
    expect(relativeShort(new Date("2026-07-04T11:30:00Z"), NOW)).toBe("hace 30 min");
    expect(relativeShort(new Date("2026-07-04T09:00:00Z"), NOW)).toBe("hace 3 h");
    expect(relativeShort(new Date("2026-07-01T12:00:00Z"), NOW)).toBe("hace 3 d.");
  });
});

// ---------------------------------------------------------------------------
// Reportar — dónde aparece el control, y dónde deliberadamente no
// ---------------------------------------------------------------------------
//
// La web renderiza el MISMO feed que la app, así que la afordancia que una
// declaración de clasificación de contenido promete tiene que existir en las
// dos. Lo que estas pruebas fijan es la regla que decide en qué filas:
// avistaje y "la tengo" los escribió un desconocido anónimo; un escaneo es una
// máquina leyendo un QR, sin autor y sin texto.

function renderFeedWithReport(items: ScanFeedItem[]): string {
  return renderToStaticMarkup(
    React.createElement(LostScanFeed, {
      items,
      totalScans: items.filter((i) => i.kind === "scan").length,
      totalSightings: items.filter((i) => i.kind !== "scan").length,
      reportAction: async () => ({ error: null }),
    }),
  );
}

function makeScanItem(): ScanFeedItem {
  return {
    kind: "scan",
    id: "test-scan-id",
    at: new Date("2026-05-01T09:00:00Z"),
    count: 1,
    localityLabel: "Santa Rosa",
  };
}

function makeFinderItem(
  overrides: Partial<Extract<ScanFeedItem, { kind: "finder" }>> = {},
): ScanFeedItem {
  return {
    kind: "finder",
    id: "test-finder-id",
    at: new Date("2026-05-01T11:00:00Z"),
    finderName: "Vecina",
    finderContact: null,
    petCondition: null,
    localityLabel: null,
    message: null,
    availabilityLabel: null,
    ...overrides,
  };
}

/** Cuántas veces aparece `needle` en `haystack`. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("LostScanFeed — el contacto del hallador, un enlace por contacto", () => {
  // `finderContact` is ONE column carrying up to TWO contacts, joined by
  // `CONTACT_SEPARATOR` in `encontre/action.ts`. This row used to build
  // `tel:${value}` over the whole string.
  const BOTH = "11 4123-4567 / ana@example.com";

  it("builds no href that carries BOTH contacts, whatever the scheme", () => {
    const html = renderFeed([makeFinderItem({ finderContact: BOTH })]);
    // The exact defect that shipped, as one assertion.
    expect(html).not.toContain("tel:11 4123-4567 / ana@example.com");

    // And the SHAPE of it. This replaces `not.toContain("mailto:11")`, which
    // pinned one scheme against one fixture's leading digits — the mobile
    // client's spelling of the same bug — and would have missed a third. The
    // subject is "an href that still holds the joined value", and the joined
    // value is recognisable by the separator its producer writes.
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map(([, href]) => href);
    expect(hrefs.filter((href) => href.includes(CONTACT_SEPARATOR))).toEqual([]);

    // Non-vacuity: the sweep above passes trivially over a row that rendered no
    // links at all, which is the same green as a correct split.
    expect(hrefs.length).toBeGreaterThan(0);
  });

  it("renders one link per contact, each with its own href", () => {
    const html = renderFeed([makeFinderItem({ finderContact: BOTH })]);
    expect(html).toContain('href="tel:1141234567"');
    expect(html).toContain('href="mailto:ana@example.com"');
    // Both parts stay readable as the finder wrote them.
    expect(html).toContain("11 4123-4567");
    expect(html).toContain("ana@example.com");
  });

  it("labels each link so the two targets are distinguishable", () => {
    const html = renderFeed([makeFinderItem({ finderContact: BOTH })]);
    expect(html).toContain('aria-label="Llamar al 11 4123-4567"');
    expect(html).toContain('aria-label="Escribir a ana@example.com"');
  });

  it("gives the e-mail a mail glyph rather than a telephone one", () => {
    const html = renderFeed([makeFinderItem({ finderContact: BOTH })]);
    expect(count(html, 'data-icon-name="telefono"')).toBe(1);
    expect(count(html, 'data-icon-name="mail"')).toBe(1);
  });

  it("leaves a single contact exactly as it behaved before the split", () => {
    const html = renderFeed([makeFinderItem({ finderContact: "11 4123-4567" })]);
    expect(html).toContain('href="tel:1141234567"');
    expect(count(html, 'data-icon-name="telefono"')).toBe(1);
    expect(html).not.toContain("mailto:");
  });

  it("keeps an unlinkable contact visible as text instead of dropping it", () => {
    const html = renderFeed([makeFinderItem({ finderContact: "preguntá por Ana" })]);
    expect(html).toContain("preguntá por Ana");
    expect(html).not.toContain("tel:");
  });
});

describe("LostScanFeed — reportar un mensaje", () => {
  it("ofrece el control en el avistaje y en el 'la tengo', y NUNCA en el escaneo", () => {
    const html = renderFeedWithReport([makeSightingItem(), makeFinderItem(), makeScanItem()]);
    // DOS controles sobre TRES filas. Contar y no chequear existencia es toda la
    // prueba: si el escaneo creciera uno, esto daría 3.
    expect(count(html, 'aria-label="Reportar este mensaje"')).toBe(2);
  });

  it("no ofrece ninguno cuando el feed es sólo escaneos", () => {
    const html = renderFeedWithReport([makeScanItem()]);
    expect(html).not.toContain("Reportar este mensaje");
  });

  it("no ofrece ninguno en la variante ORG — el servidor lo rechaza ahí", () => {
    // `LostCaseBlock` no le pasa `reportAction` a la variante de organización
    // porque el servidor refuta `report_content` en ese camino: el ocultamiento
    // es global a la mascota, así que una organización con custodia podría hacer
    // desaparecer un "tengo a tu perro" del panel del DUEÑO. Un control que
    // contesta 403 es un control que miente.
    const html = renderFeed([makeSightingItem(), makeFinderItem()]);
    expect(html).not.toContain("Reportar este mensaje");
  });

  it("no ofrece ninguno cuando la superficie no pasa la acción", () => {
    // La prop es opcional a propósito: sin ella las filas se dibujan igual y sin
    // control. Un `undefined` no es un control roto, es una superficie que
    // todavía no lo ofrece.
    const html = renderFeed([makeSightingItem(), makeFinderItem()]);
    expect(html).not.toContain("Reportar este mensaje");
  });

  it("nunca dice 'denunciar' — esa palabra ya es una denuncia por Ley 14.346", () => {
    const html = renderFeedWithReport([makeSightingItem(), makeFinderItem(), makeScanItem()]);
    expect(html.toLowerCase()).not.toContain("denunci");
  });
});

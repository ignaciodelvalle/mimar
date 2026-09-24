// What the fiscalía PDF actually SAYS, asserted against the rendered document.
//
// WHY THIS FILE EXISTS
// ---------------------------------------------------------------------------
// Every other test of this export reaches a pure builder and stops there. That
// leaves the edge between a builder and the page unverified, and that edge is
// where a legal document silently regresses: reverting the coordinate
// formatting in the renderer — putting the seven-decimal value straight back
// on the page — survived the entire suite. Nothing was reading the document.
//
// These tests render the real PDF and read the text out of it (see
// __tests__/_helpers/pdf-text.ts). They are the only tests here that can
// answer "what does the fiscal see".
//
// The document under test is titled "DENUNCIA FORMAL — LEY NACIONAL 14.346
// (1954)" and is filed with the Unidad Fiscal de Maltrato Animal.

import { describe, expect, it } from "vitest";

import {
  type WelfareMpfDto,
  formatCoordinate,
  generateWelfareMpfPdf,
} from "@/lib/analytics/welfare-exports";
import { extractPdfText } from "./_helpers/pdf-text";

function makeDto(overrides: Partial<WelfareMpfDto> = {}): WelfareMpfDto {
  return {
    referenceCode: "DEN-2026-000123",
    reportId: "aaaaaaaa-0000-0000-0000-000000000001",
    kindLabel: "Abandono",
    severityLabel: "Alta",
    description: "Perro atado a la intemperie sin agua ni alimento.",
    observedSymptoms: null,
    occurredAtLabel: "19 de junio de 2026 a las 21:00",
    jurisdictionProvince: "CABA",
    jurisdictionLocality: "CABA",
    locationAddress: "Av. Corrientes 1234",
    locationLat: "-34.6307660",
    locationLng: "-58.3826932",
    subjectKindLabel: "Animal sin dueño",
    subjectDescription: "Perro mestizo marrón",
    subjectPet: null,
    reporterDisplayName: null,
    reporterIsAnonymous: true,
    reporterContactEmail: null,
    reporterContactPhone: null,
    attachments: [],
    exportGeneratedAt: "30 de julio de 2026, 10:00 (hora de Argentina)",
    reportCreatedAt: "19 de junio de 2026",
    exportedByDisplayName: "Agente Fiscalía",
    knowledgeGapLabel: "La autoridad tomó conocimiento el mismo día del hecho.",
    fiscalUnitLabel: "Unidad Fiscal de Maltrato Animal — CABA",
    mpfFormatLabel: "Estándar nacional (PDF libre, Ley 14.346)",
    mpfFormatProvenanceLabel: "Default nacional",
    ...overrides,
  };
}

async function renderText(overrides: Partial<WelfareMpfDto> = {}): Promise<string> {
  return extractPdfText(await generateWelfareMpfPdf(makeDto(overrides)));
}

// ---------------------------------------------------------------------------
// The helper has to actually work before anything below means anything.
// ---------------------------------------------------------------------------

describe("extractPdfText — the reading apparatus itself", () => {
  it("recovers the document title", async () => {
    expect(await renderText()).toContain("DENUNCIA FORMAL");
  });

  it("decodes WinAnsi punctuation — an em dash is one byte, not UTF-8", async () => {
    expect(await renderText()).toContain("miMAR — Mi Mascota Argentina");
  });

  it("recovers accented Spanish", async () => {
    expect(await renderText()).toContain("Descripción".toUpperCase());
  });
});

// ---------------------------------------------------------------------------
// Síntomas observados — the field that used to die between form and column
// ---------------------------------------------------------------------------

describe("observed symptoms in the legal export", () => {
  it("prints the reporter's observation verbatim when one was recorded", async () => {
    // Column since migration 0209. The MPF export is the read that makes the
    // repair real: a vet's clinical observation reaching the fiscal document,
    // not just a database row.
    const text = await renderText({ observedSymptoms: "Costillas visibles, pelaje opaco" });
    expect(text).toContain("Síntomas observados".toUpperCase());
    expect(text).toContain("Costillas visibles, pelaje opaco");
  });

  it("omits the label entirely when nothing was observed — no empty legal field", async () => {
    expect(await renderText()).not.toContain("Síntomas observados".toUpperCase());
  });
});

// ---------------------------------------------------------------------------
// One issuer, one name
// ---------------------------------------------------------------------------

describe("the rendered document names one issuer", () => {
  it("signs the footer with the public brand", async () => {
    expect(await renderText()).toContain("Documento generado por miMAR");
  });

  it("never prints the internal codename standing alone", async () => {
    // The page legitimately contains DIM-XXXX-XXXX tokens in other exports;
    // this rule is the codename as a bare word. Same distinction the brand
    // fence draws (scripts/check-brand-casing.ts Rule 2).
    expect(await renderText()).not.toMatch(/\bDIM\b(?!-)/);
  });

  it("keeps the header and footer telling the same story", async () => {
    const text = await renderText();
    expect(text).toContain("miMAR — Mi Mascota Argentina");
    expect(text).not.toContain("generado por DIM");
  });
});

// ---------------------------------------------------------------------------
// Coordinates — the wiring the surviving mutant exposed
// ---------------------------------------------------------------------------

describe("GPS coordinates on the page", () => {
  it("prints the FORMATTED coordinate, not the raw stored value", async () => {
    const text = await renderText({ locationLat: "-34.6307660", locationLng: "-58.3826932" });
    expect(text).toContain("Lat: -34.63077 · Lng: -58.38269");
  });

  it("does not print the seven-decimal value the record stores", async () => {
    const text = await renderText({ locationLat: "-34.6307660", locationLng: "-58.3826932" });
    expect(text).not.toContain("-34.6307660");
    expect(text).not.toContain("-58.3826932");
  });

  it("routes through formatCoordinate rather than a second, drifting rule", async () => {
    const lat = "-31.4201110";
    const lng = "-64.1888220";
    const text = await renderText({ locationLat: lat, locationLng: lng });
    expect(text).toContain(`Lat: ${formatCoordinate(lat)} · Lng: ${formatCoordinate(lng)}`);
  });

  it("omits the coordinates block entirely when the report has no location", async () => {
    const text = await renderText({ locationLat: null, locationLng: null });
    expect(text).not.toContain("COORDENADAS GPS");
  });
});

// ---------------------------------------------------------------------------
// The authenticity disclosure, on the page
// ---------------------------------------------------------------------------

describe("the authenticity footer as the fiscal reads it", () => {
  it("still admits there is no cryptographic signature", async () => {
    expect(await renderText()).toContain("Sin firma PKI");
  });

  it("prints no internal requirement code", async () => {
    expect(await renderText()).not.toMatch(/\bF-D\d+\b/);
  });

  it("prints no raw code identifiers", async () => {
    const text = await renderText();
    expect(text).not.toContain("audit_log");
    expect(text).not.toContain("referenceCode");
  });
});

// ---------------------------------------------------------------------------
// The things this document already does well — regression guards, not changes
// ---------------------------------------------------------------------------

describe("what this document gets right stays right", () => {
  it("cites the article that permits an anonymous denuncia", async () => {
    const text = await renderText({ reporterIsAnonymous: true });
    expect(text).toContain("Anónimo (denuncia legal por Ley 14.346 §11)");
  });

  it("keeps the bitemporal note explaining why two dates are not one", async () => {
    // The note word-wraps across several drawText calls, so assert on phrases
    // that survive the wrap rather than the whole sentence.
    const text = await renderText();
    expect(text).toContain("La fecha de ocurrencia indica cuándo sucedió el hecho");
    expect(text).toContain("cuándo la autoridad tomó noticia de él");
    expect(text).toContain("para evaluar la diligencia y los plazos de actuación");
  });

  it("prints the jurisdiction-resolved fiscal unit and where that resolution came from", async () => {
    // Field LABELS render uppercased by the renderer; the fiscal unit is drawn
    // as a label, so the province appears as "CHACO".
    const text = await renderText({
      jurisdictionProvince: "Chaco",
      jurisdictionLocality: "Resistencia",
      fiscalUnitLabel: "Unidad Fiscal de Maltrato Animal — Chaco",
      mpfFormatProvenanceLabel: "Override provincia",
    });
    expect(text).toContain("CHACO");
    expect(text).not.toContain("CABA");
    expect(text).toContain("Override provincia");
  });

  it("names who generated the export", async () => {
    expect(await renderText({ exportedByDisplayName: "Dra. Pérez" })).toContain("Dra. Pérez");
  });

  it("prints the denunciante's own words verbatim — the export never edits the denuncia", async () => {
    // Deliberate: a legal document that rewrites the reporter's description is
    // a far worse problem than an ugly value. Data quality belongs to intake.
    const raw = "PANO-HIST-WEL-001022 denuncia histórica";
    expect(await renderText({ description: raw })).toContain(raw);
  });
});

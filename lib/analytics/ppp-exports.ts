// PDF renderer for the PPP CABA RUPPPA export (Chunk F, F2).
//
// Decision F-D3+D4: CABA only in v1. Prov BA is NOT implemented in this PR.
//   See TODO(F2-prov-ba-v2) below for the deferred channel.
// Decision F-D5: audit_log action = "ppp_export_generated" (snake_case).
// Decision F-D6: storage bucket = "ppp-exports" (private, separate from welfare-exports).
//
// JURISDICTION GATE (mandatory per F-D3+D4):
//   The action MUST validate pet.jurisdictionProvince === "Ciudad Autónoma de Buenos Aires"
//   before generating the PDF. Prov BA pets receive a clear error:
//   "ppp_prov_ba_not_implemented" — see TODO(F2-prov-ba-v2).
//
// BUCKETS REQUIRED (owner ops — create in Supabase Studio, do NOT auto-create):
//   - ppp-exports  (private, signed URLs only)
//
// TODO(F2-prov-ba-v2): Prov BA PPP export is deferred. When Ley 14.107 municipal
//   registry support is added, extend this file with a `generatePppProvBaPdf()` function
//   and update the action to accept targetJurisdiction: "prov_ba". The storage path
//   should use `${petPublicToken}/prov_ba/${timestamp}.pdf`.

import { PDFDocument, type PDFFont, type PDFPage, PageSizes, StandardFonts, rgb } from "pdf-lib";

import { PPP_AUTHENTICITY_NOTE, documentAttributionLine } from "@/lib/analytics/export-attribution";
import { CABA_PROVINCE } from "@/lib/domain/ppp-export-eligibility";
import { formatDate, speciesLabel } from "@/lib/utils/format";

export const PPP_EXPORT_SCHEMA_VERSION = "2026-05-21";

// CABA jurisdiction constant — used for validation. Canonical display name
// per PROVINCES in lib/ar-provincias.ts (CHECK constraint enforces this since
// migration 0055). Defined in the pure eligibility module so the owner page can
// read the same value without importing this renderer (and pdf-lib).
export { CABA_PROVINCE };

// ---------------------------------------------------------------------------
// DTO types
// ---------------------------------------------------------------------------

export type PppCabaDto = {
  // Pet
  petName: string;
  petPublicToken: string;
  petSpecies: string;
  petBreed: string | null;
  petDateOfBirth: string | null; // ISO date string or null
  petMicrochipId: string | null;
  petPotentiallyDangerousBreed: boolean;
  // Owner
  ownerDisplayName: string;
  ownerDniNumber: string | null; // null → "DNI no verificado"
  ownerEmail: string;
  // Jurisdiction
  jurisdictionProvince: string;
  jurisdictionLocality: string | null;
  // Audit
  exportGeneratedAt: string;
};

// ---------------------------------------------------------------------------
// PDF renderer
// ---------------------------------------------------------------------------

function drawPppField(
  page: PDFPage,
  opts: {
    label: string;
    value: string;
    x: number;
    y: number;
    boldFont: PDFFont;
    regularFont: PDFFont;
    labelSize?: number;
    valueSize?: number;
    maxWidth?: number;
  },
): number {
  const {
    label,
    value,
    x,
    y,
    boldFont,
    regularFont,
    labelSize = 7,
    valueSize = 9,
    maxWidth = 480,
  } = opts;

  if (label) {
    page.drawText(label.toUpperCase(), {
      x,
      y,
      size: labelSize,
      font: boldFont,
      color: rgb(0.5, 0.5, 0.5),
    });
  }

  const rawLines = value.split("\n");
  const wrapped: string[] = [];
  for (const raw of rawLines) {
    if (regularFont.widthOfTextAtSize(raw, valueSize) <= maxWidth) {
      wrapped.push(raw);
    } else {
      const words = raw.split(" ");
      let current = "";
      for (const word of words) {
        const test = current ? `${current} ${word}` : word;
        if (regularFont.widthOfTextAtSize(test, valueSize) <= maxWidth) {
          current = test;
        } else {
          if (current) wrapped.push(current);
          current = word;
        }
      }
      if (current) wrapped.push(current);
    }
  }

  let cursor = label ? y - labelSize - 2 : y;
  for (const line of wrapped) {
    page.drawText(line, {
      x,
      y: cursor,
      size: valueSize,
      font: regularFont,
      color: rgb(0.1, 0.1, 0.1),
    });
    cursor -= valueSize + 2;
  }
  return cursor - 4;
}

function drawPppSection(
  page: PDFPage,
  opts: {
    text: string;
    x: number;
    y: number;
    width: number;
    boldFont: PDFFont;
  },
): number {
  const { text, x, y, width, boldFont } = opts;
  page.drawRectangle({
    x,
    y: y - 3,
    width,
    height: 14,
    color: rgb(0.9, 0.95, 1.0),
  });
  page.drawText(text, {
    x: x + 4,
    y,
    size: 8,
    font: boldFont,
    color: rgb(0.1, 0.1, 0.5),
  });
  return y - 20;
}

/**
 * Renders a PPP CABA RUPPPA registration PDF and returns the raw bytes.
 * Only call after validating pet.jurisdictionProvince === CABA_PROVINCE.
 */
export async function generatePppCabaPdf(dto: PppCabaDto): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage(PageSizes.A4);

  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const regularFont = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const { width, height } = page.getSize();
  const margin = 56;
  const contentWidth = width - margin * 2;
  let y = height - margin;

  // ------------------------------------------------------------------
  // Header
  // ------------------------------------------------------------------
  page.drawText("miMAR — Mi Mascota Argentina", {
    x: margin,
    y,
    size: 14,
    font: boldFont,
    color: rgb(0.1, 0.1, 0.6),
  });
  y -= 18;
  page.drawText("REGISTRO RUPPPA — CIUDAD AUTÓNOMA DE BUENOS AIRES", {
    x: margin,
    y,
    size: 10,
    font: boldFont,
    color: rgb(0.2, 0.2, 0.2),
  });
  y -= 14;
  page.drawText("Ley CABA 4078 — Tenencia de perros considerados potencialmente peligrosos", {
    x: margin,
    y,
    size: 8,
    font: regularFont,
    color: rgb(0.4, 0.4, 0.4),
  });
  y -= 8;
  page.drawLine({
    start: { x: margin, y },
    end: { x: width - margin, y },
    thickness: 1,
    color: rgb(0.7, 0.7, 0.7),
  });
  y -= 14;

  // ------------------------------------------------------------------
  // Datos del animal
  // ------------------------------------------------------------------
  y = drawPppSection(page, {
    text: "DATOS DEL ANIMAL",
    x: margin,
    y,
    width: contentWidth,
    boldFont,
  });
  y = drawPppField(page, {
    label: "Nombre",
    value: dto.petName,
    x: margin,
    y,
    boldFont,
    regularFont,
    maxWidth: contentWidth,
  });
  if (dto.petBreed) {
    y = drawPppField(page, {
      label: "Raza",
      value: dto.petBreed,
      x: margin,
      y,
      boldFont,
      regularFont,
      maxWidth: contentWidth,
    });
  }
  y = drawPppField(page, {
    label: "Especie",
    value: speciesLabel(dto.petSpecies),
    x: margin,
    y,
    boldFont,
    regularFont,
    maxWidth: contentWidth,
  });
  if (dto.petDateOfBirth) {
    y = drawPppField(page, {
      label: "Fecha de nacimiento",
      // AR-pinned (bug 4): ambient-zone formatting can shift a birth date to
      // the previous calendar day when the server clock is UTC.
      value: formatDate(dto.petDateOfBirth),
      x: margin,
      y,
      boldFont,
      regularFont,
      maxWidth: contentWidth,
    });
  }
  y = drawPppField(page, {
    label: "Microchip",
    value: dto.petMicrochipId ?? "Sin microchip registrado",
    x: margin,
    y,
    boldFont,
    regularFont,
    maxWidth: contentWidth,
  });
  y = drawPppField(page, {
    label: "Clasificación PPP",
    value: dto.petPotentiallyDangerousBreed
      ? "Raza potencialmente peligrosa (clasificación miMAR)"
      : "No PPP",
    x: margin,
    y,
    boldFont,
    regularFont,
    maxWidth: contentWidth,
  });
  y = drawPppField(page, {
    label: "Identificador público (token miMAR)",
    value: dto.petPublicToken,
    x: margin,
    y,
    boldFont,
    regularFont,
    maxWidth: contentWidth,
  });
  y -= 4;

  // ------------------------------------------------------------------
  // Datos del tenedor / propietario
  // ------------------------------------------------------------------
  y = drawPppSection(page, {
    text: "DATOS DEL TENEDOR / PROPIETARIO",
    x: margin,
    y,
    width: contentWidth,
    boldFont,
  });
  y = drawPppField(page, {
    label: "Nombre completo",
    value: dto.ownerDisplayName,
    x: margin,
    y,
    boldFont,
    regularFont,
    maxWidth: contentWidth,
  });
  y = drawPppField(page, {
    label: "DNI",
    value: dto.ownerDniNumber ?? "DNI no verificado — el tenedor debe completarlo en el organismo",
    x: margin,
    y,
    boldFont,
    regularFont,
    maxWidth: contentWidth,
  });
  y = drawPppField(page, {
    label: "Email de contacto",
    value: dto.ownerEmail,
    x: margin,
    y,
    boldFont,
    regularFont,
    maxWidth: contentWidth,
  });
  y -= 4;

  // ------------------------------------------------------------------
  // Jurisdicción destino
  // ------------------------------------------------------------------
  y = drawPppSection(page, {
    text: "JURISDICCIÓN DESTINO",
    x: margin,
    y,
    width: contentWidth,
    boldFont,
  });
  y = drawPppField(page, {
    label: "Registro destino",
    value: "Registro Único de Perros Potencialmente Peligrosos (RUPPPA) — CABA",
    x: margin,
    y,
    boldFont,
    regularFont,
    maxWidth: contentWidth,
  });
  y = drawPppField(page, {
    label: "Provincia / jurisdicción",
    value: dto.jurisdictionProvince,
    x: margin,
    y,
    boldFont,
    regularFont,
    maxWidth: contentWidth,
  });
  if (dto.jurisdictionLocality) {
    y = drawPppField(page, {
      label: "Localidad",
      value: dto.jurisdictionLocality,
      x: margin,
      y,
      boldFont,
      regularFont,
      maxWidth: contentWidth,
    });
  }
  y -= 4;

  // ------------------------------------------------------------------
  // Normativa aplicable
  // ------------------------------------------------------------------
  y = drawPppSection(page, {
    text: "NORMATIVA APLICABLE",
    x: margin,
    y,
    width: contentWidth,
    boldFont,
  });
  y = drawPppField(page, {
    label: "Ley CABA 4078",
    value: "Tenencia de perros considerados peligrosos en la Ciudad Autónoma de Buenos Aires",
    x: margin,
    y,
    boldFont,
    regularFont,
    maxWidth: contentWidth,
  });
  y -= 4;

  // ------------------------------------------------------------------
  // Instrucciones al tenedor
  // ------------------------------------------------------------------
  y = drawPppSection(page, {
    text: "INSTRUCCIONES",
    x: margin,
    y,
    width: contentWidth,
    boldFont,
  });
  page.drawText(
    "Presentar este documento junto al carnet sanitario y libreta de vacunas del animal",
    {
      x: margin,
      y,
      size: 8,
      font: regularFont,
      color: rgb(0.2, 0.2, 0.2),
    },
  );
  y -= 12;
  page.drawText("en la comuna o registro RUPPPA correspondiente de CABA.", {
    x: margin,
    y,
    size: 8,
    font: regularFont,
    color: rgb(0.2, 0.2, 0.2),
  });
  y -= 16;

  // ------------------------------------------------------------------
  // Trazabilidad / audit
  // ------------------------------------------------------------------
  y = drawPppSection(page, {
    text: "TRAZABILIDAD",
    x: margin,
    y,
    width: contentWidth,
    boldFont,
  });
  y = drawPppField(page, {
    label: "PDF generado el",
    value: dto.exportGeneratedAt,
    x: margin,
    y,
    boldFont,
    regularFont,
    maxWidth: contentWidth,
  });

  // ------------------------------------------------------------------
  // Footer
  // ------------------------------------------------------------------
  const footerY = margin - 10;
  page.drawLine({
    start: { x: margin, y: footerY + 14 },
    end: { x: width - margin, y: footerY + 14 },
    thickness: 0.5,
    color: rgb(0.8, 0.8, 0.8),
  });
  page.drawText(documentAttributionLine(dto.petPublicToken), {
    x: margin,
    y: footerY,
    size: 7,
    font: regularFont,
    color: rgb(0.5, 0.5, 0.5),
  });
  page.drawText(PPP_AUTHENTICITY_NOTE, {
    x: margin,
    y: footerY - 10,
    size: 6,
    font: regularFont,
    color: rgb(0.65, 0.65, 0.65),
  });

  return pdfDoc.save();
}

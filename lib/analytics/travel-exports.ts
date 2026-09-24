// PDF renderer for the travel doc bundle (movilidad-jurisdiccional Fase 1,
// Capability 5).
//
// R5.1: ONE multi-section PDF — never a zip, never per-corridor files.
// R5.2: bucket `travel-exports` (private, signed URLs only). Bucket creation
//       is OWNER OPS — create in Supabase Studio before deploying; never from
//       application code (same contract as welfare-exports/ppp-exports).
// R5.4: every corridor section carries the checklist state AND the staleness
//       disclaimer + corridor version/effectiveFrom — a PDF handed to a
//       consulate or carrier is not exempt from the "verify with the
//       authority" caveat.
//
// NOTE: this module carries its OWN storage helpers instead of widening the
// bucket union in welfare-exports.ts — that file belongs to a concurrent
// change in flight; the helpers are 15 lines and bucket-typed locally.

import { PDFDocument, type PDFFont, PageSizes, StandardFonts, rgb } from "pdf-lib";

import { documentAttributionLine } from "@/lib/analytics/export-attribution";
import type { RequirementLevel } from "@/lib/domain/travel-strictness";
import type {
  CorridorDisclosure,
  TravelObligation,
  TravelSemaforo,
} from "@/lib/projections/travel-compliance";
import { TRAVEL_DISCLAIMER } from "@/lib/reference/cross-border-corridors";
import { speciesInProse } from "@/lib/utils/species";

export const TRAVEL_EXPORT_SCHEMA_VERSION = "2026-07-04";

const TRAVEL_EXPORTS_BUCKET = "travel-exports";

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

export type TravelExportDto = {
  petName: string;
  petPublicToken: string;
  petSpecies: string;
  ownerDisplayName: string;
  exportGeneratedAt: string;
  semaforo: TravelSemaforo;
  corridors: CorridorDisclosure[];
  obligations: TravelObligation[];
};

// ---------------------------------------------------------------------------
// Storage path convention (R5.2): ${token}/travel/${corridor|"domestic"}/${ts}.pdf
// Multiple corridors collapse into one sorted, dash-joined segment — still
// ONE file (R5.1), the segment just names the corridors covered.
// ---------------------------------------------------------------------------

export function buildTravelExportPath(
  petPublicToken: string,
  corridorIds: readonly string[],
  timestamp: number,
): string {
  const segment = corridorIds.length === 0 ? "domestic" : [...corridorIds].sort().join("-");
  return `${petPublicToken}/travel/${segment}/${timestamp}.pdf`;
}

// ---------------------------------------------------------------------------
// Section builder — pure, unit-testable. The PDF renderer draws exactly what
// this returns, so the R5.4 disclaimer requirement is asserted on data, not
// on parsed PDF bytes.
// ---------------------------------------------------------------------------

const SEMAFORO_LABELS: Record<TravelSemaforo, string> = {
  rojo: "ROJO — No viajar todavía",
  amarillo: "AMARILLO — Revisar pendientes",
  verde: "VERDE — Requisitos en orden",
  sin_datos: "SIN DATOS — Verificación no disponible",
};

const LEVEL_LABELS: Record<RequirementLevel, string> = {
  blocker: "Bloqueante",
  warning: "Atención",
  info: "Informativo",
};

export type TravelExportSection = {
  kind: "summary" | "checklist" | "corridor" | "traceability";
  heading: string;
  lines: string[];
};

export function buildTravelExportSections(dto: TravelExportDto): TravelExportSection[] {
  const sections: TravelExportSection[] = [];

  sections.push({
    kind: "summary",
    heading: "RESUMEN DE VIAJE",
    lines: [
      // Antes: `petSpecies === "dog" ? "perro" : petSpecies` — un ternario que
      // escribía "perro" para perro y el ENUM CRUDO para todo lo demás, así que
      // el PDF de viaje de un gato decía "Mascota: Michi (cat)". Es la misma
      // clase que el ternario que renderizaba toda especie no-perro como
      // "Gatos" (revisión adversa 2026-08-08), y sobrevivió invisible porque su
      // etiqueta estaba en minúscula y el fence era sensible a mayúsculas.
      `Mascota: ${dto.petName} (${speciesInProse(dto.petSpecies)})`,
      `Identificador público (token miMAR): ${dto.petPublicToken}`,
      `Tenedor/propietario: ${dto.ownerDisplayName}`,
      `Semáforo: ${SEMAFORO_LABELS[dto.semaforo]}`,
    ],
  });

  sections.push({
    kind: "checklist",
    heading: "CHECKLIST DE REQUISITOS",
    lines:
      dto.obligations.length === 0
        ? ["Sin requisitos para el contexto de viaje registrado."]
        : dto.obligations.flatMap((o) => [
            `[${LEVEL_LABELS[o.requirementLevel]}] ${o.label} — ${o.state}`,
            ...(o.detail ? [`  ${o.detail}`] : []),
            ...(o.contributingJurisdictions.length > 0
              ? [`  Exigido por: ${o.contributingJurisdictions.join(" · ")}`]
              : []),
          ]),
  });

  // R5.4: one section per corridor, each with version/effectiveFrom + the
  // staleness disclaimer (S13 applies to the exported artifact).
  for (const corridor of dto.corridors) {
    sections.push({
      kind: "corridor",
      heading: `CORREDOR: ${corridor.label.toUpperCase()}`,
      lines: [
        `Versión de reglas: ${corridor.version} — vigencia desde ${corridor.effectiveFrom}`,
        `Fuente oficial: ${corridor.sourceUrl}`,
        TRAVEL_DISCLAIMER,
      ],
    });
  }

  sections.push({
    kind: "traceability",
    heading: "TRAZABILIDAD",
    lines: [
      `PDF generado el ${dto.exportGeneratedAt}`,
      `Esquema de exportación: ${TRAVEL_EXPORT_SCHEMA_VERSION}`,
      documentAttributionLine(dto.petPublicToken),
    ],
  });

  return sections;
}

// ---------------------------------------------------------------------------
// PDF renderer
// ---------------------------------------------------------------------------

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(test, size) <= maxWidth) {
      current = test;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Renders the ONE multi-section travel PDF (R5.1) and returns raw bytes. */
export async function generateTravelExportPdf(dto: TravelExportDto): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const regularFont = await pdfDoc.embedFont(StandardFonts.Helvetica);

  let page = pdfDoc.addPage(PageSizes.A4);
  const { width, height } = page.getSize();
  const margin = 56;
  const contentWidth = width - margin * 2;
  let y = height - margin;

  const ensureRoom = (needed: number) => {
    if (y - needed < margin) {
      page = pdfDoc.addPage(PageSizes.A4);
      y = height - margin;
    }
  };

  // Header
  page.drawText("miMAR — Mi Mascota Argentina", {
    x: margin,
    y,
    size: 14,
    font: boldFont,
    color: rgb(0.1, 0.1, 0.6),
  });
  y -= 18;
  page.drawText("DOCUMENTACIÓN DE VIAJE — MOVILIDAD JURISDICCIONAL", {
    x: margin,
    y,
    size: 10,
    font: boldFont,
    color: rgb(0.2, 0.2, 0.2),
  });
  y -= 18;

  for (const section of buildTravelExportSections(dto)) {
    ensureRoom(40);
    page.drawRectangle({
      x: margin,
      y: y - 3,
      width: contentWidth,
      height: 14,
      color: rgb(0.9, 0.95, 1.0),
    });
    page.drawText(section.heading, {
      x: margin + 4,
      y,
      size: 8,
      font: boldFont,
      color: rgb(0.1, 0.1, 0.5),
    });
    y -= 20;

    for (const line of section.lines) {
      for (const wrapped of wrapText(line, regularFont, 9, contentWidth)) {
        ensureRoom(14);
        page.drawText(wrapped, {
          x: margin,
          y,
          size: 9,
          font: regularFont,
          color: rgb(0.1, 0.1, 0.1),
        });
        y -= 12;
      }
    }
    y -= 8;
  }

  return pdfDoc.save();
}

// ---------------------------------------------------------------------------
// Storage helpers — bucket-typed locally (see module note above).
// BUCKET REQUIRED (owner ops — create in Supabase Studio before deploying):
//   - travel-exports (private)
// Do NOT auto-create buckets from application code.
// ---------------------------------------------------------------------------

// The service-role client is imported dynamically (lib/supabase/admin.ts is
// `server-only`), memoised so concurrent calls share one module load.
let adminModule: Promise<typeof import("@/lib/supabase/admin")> | null = null;
function loadAdmin(): Promise<typeof import("@/lib/supabase/admin")> {
  adminModule ??= import("@/lib/supabase/admin");
  return adminModule;
}

// Both helpers take NO caller client on purpose (migration 0172) — the rationale
// lives on createSignedExportUrl in welfare-exports.ts; `travel-exports` was the
// third bucket covered by the same over-permissive authenticated SELECT policy.
// Authorization for this bucket is the strict owner-path check in
// generate-travel-export.ts, which runs before either helper is called.

export async function uploadTravelExportToStorage(
  path: string,
  bytes: Uint8Array,
): Promise<{ storagePath: string } | { error: string }> {
  try {
    const { createAdminClient } = await loadAdmin();
    const { error } = await createAdminClient()
      .storage.from(TRAVEL_EXPORTS_BUCKET)
      .upload(path, bytes, {
        contentType: "application/pdf",
        upsert: false,
      });
    if (error) return { error: error.message };
    return { storagePath: path };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "storage_client_unavailable" };
  }
}

export async function createSignedTravelExportUrl(
  path: string,
  expiresIn = 86400,
): Promise<string | null> {
  try {
    const { createAdminClient } = await loadAdmin();
    const { data, error } = await createAdminClient()
      .storage.from(TRAVEL_EXPORTS_BUCKET)
      .createSignedUrl(path, expiresIn);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  } catch {
    return null;
  }
}

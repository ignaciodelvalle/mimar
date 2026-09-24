// Audience-precision plan (2026-06-19): welfare-report coordinates are shown at
// the minimum precision each audience needs.
//   - Public tracking receipt (/denuncias/codigo/[code]) — APPROXIMATE only
//     (Ley 25.326 minimisation). No exact decimals, no street address.
//   - Authority (/gob/maltrato/[id], /admin/moderacion/[id]) — EXACT, labelled
//     "uso oficial" (Ley 14.346), and every view is logged for accountability.
//
// These surfaces are server components; rather than render them, we assert the
// contract in source (same source-scan style as
// welfare-integration-banner-gating.test.ts). If a future edit re-introduces an
// exact public coordinate or drops the authority access log, this fails.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isMetadataStripped } from "@/lib/infra/welfare-uploads";

const PUBLIC_RECEIPT = join(
  process.cwd(),
  "app",
  "(public)",
  "denuncias",
  "codigo",
  "[code]",
  "page.tsx",
);
const GOB_DETAIL = join(process.cwd(), "app", "gob", "maltrato", "[id]", "page.tsx");
const ADMIN_DETAIL = join(process.cwd(), "app", "admin", "moderacion", "[id]", "page.tsx");
// A3 (2026-07-31): the queue INSPECTOR is a third exact-coordinate surface and
// had no precision/audit test of its own. Unlike the two routes above, its
// render and its audit live in DIFFERENT files — the panel prints
// `toFixed(6)` while `logWelfareLocationViewed` fires in the detail LOADER. A
// coupling across a file boundary is exactly the kind that drifts silently, so
// both ends are pinned below.
const INSPECTOR_CONTENT = join(
  process.cwd(),
  "app",
  "gob",
  "maltrato",
  "_inspector",
  "WelfareInspectorContent.tsx",
);
const INSPECTOR_LOADER = join(process.cwd(), "lib", "infra", "welfare-inspector-detail.ts");

/** Read a source file with comments blanked out.
 *
 *  A source-scan assertion over RAW text is satisfied by prose: the loader below
 *  names `logWelfareLocationViewed` in a header comment, so a `toContain` on the
 *  raw file would stay green after the actual call was deleted. Blanking
 *  comments (line offsets preserved) makes the assertion about CODE. */
function readCode(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, before) => before + " ".repeat(m.length - before.length));
}

// STRENGTHENED, legal/denuncias-despublicadas (2026-08-17).
//
// This block used to assert that the public comprobante COARSENED the point and
// LABELLED the map "aproximada". Those assertions passed for a year and protected
// the wrong subject. Coarsening a coordinate defends against a precision attack;
// it does nothing against a sentence, and the page was also rendering the
// locality, the province, the denunciante's free text and a physical description
// of the ACCUSED. In a town of five thousand, "el hombre de unos sesenta, del
// galpón de chapa sobre la ruta" plus a coarse point is one person — an unverified
// allegation of a crime that carries prison (Ley 14.346 art. 1), against someone
// who has not been investigated and cannot answer.
//
// So the assertions inverted rather than relaxed: the surface now renders NO point
// at all, coarse or otherwise. `not.toMatch(coarsenPoint)` is a strictly stronger
// claim than `toMatch(coarsenPoint with "approx")` — there is no precision left to
// argue about. The reporter's own view (/denuncias/seguimiento) does not render
// location either; see __tests__/denuncia-reporter-view-contract.test.tsx.
describe("public comprobante — NO location at all (legal/denuncias-despublicadas)", () => {
  // readCode, not readFileSync: this is the most sensitive surface in the file and
  // it was the one still scanning RAW text — so a positive match could be
  // satisfied by a COMMENT naming the call even with the call itself deleted. The
  // helper right above exists precisely to prevent that (audit 2026-08-12). It
  // matters just as much for the negative assertions below, in the other
  // direction: the file's header comment DISCUSSES coarsenPoint at length, and a
  // raw-text `not.toMatch` would fail on the prose while the code was clean.
  const src = readCode(PUBLIC_RECEIPT);

  it("never renders an exact coordinate (no toFixed(6))", () => {
    expect(src).not.toMatch(/toFixed\(6\)/);
  });

  it("renders no coordinate whatsoever — not even a coarsened one", () => {
    expect(src).not.toMatch(/coarsenPoint\(/);
    expect(src).not.toMatch(/readPoint\(/);
    expect(src).not.toMatch(/locationLat|locationLng/);
  });

  it("embeds no map", () => {
    expect(src).not.toMatch(/LocationMap|StaticFirstMap/);
    expect(src).not.toContain("Ubicación aproximada");
  });

  it("renders neither the street address nor the locality/province", () => {
    // Locality is the field that, combined with free text, identifies the accused.
    // It was rendered here for a year under a data-minimisation rationale that
    // only ever considered the coordinate.
    expect(src).not.toMatch(/report\.locationAddress/);
    expect(src).not.toMatch(/jurisdictionLocality|jurisdictionProvince/);
  });

  it("renders neither the denunciante's free text nor the description of the accused", () => {
    expect(src).not.toMatch(/report\.description/);
    expect(src).not.toMatch(/report\.subjectDescription/);
  });
});

describe("authority surfaces — exact location, labelled, and logged (Ley 14.346)", () => {
  it("gob detail keeps the exact coordinate, labels official use, and logs the view", () => {
    const src = readCode(GOB_DETAIL);
    // Exact precision preserved — do NOT degrade the investigative surface.
    expect(src).toMatch(/toFixed\(6\)/);
    expect(src).toContain("uso oficial (Ley 14.346)");
    expect(src).toContain("logWelfareLocationViewed");
  });

  it("admin moderation renders the EXACT point (un-coarsened), labels official use, and logs the view", () => {
    const src = readCode(ADMIN_DETAIL);
    // The map must receive the raw exact point — admin must NOT coarsen.
    expect(src).toMatch(/LocationMap lat=\{locationPoint\.lat\}/);
    expect(src).not.toMatch(/coarsenPoint/);
    expect(src).toContain("uso oficial (Ley 14.346)");
    expect(src).toContain("logWelfareLocationViewed");
  });

  it("the queue inspector shows the EXACT point and labels it official use", () => {
    const src = readCode(INSPECTOR_CONTENT);
    // Same investigative precision as the detail route — and never coarsened.
    expect(src).toMatch(/locationPoint\.lat\.toFixed\(6\)/);
    expect(src).toMatch(/locationPoint\.lng\.toFixed\(6\)/);
    expect(src).not.toMatch(/coarsenPoint/);
    expect(src).toContain("uso oficial (Ley 14.346)");
  });

  it("the inspector's exact-coordinate view is audited by its loader", () => {
    // The accountability half of the same disclosure. The inspector panel does
    // NOT log the view itself (grep it: no logWelfareLocationViewed there) —
    // the loader that feeds it does, on fetch. If that call is ever dropped, an
    // operator reads exact victim coordinates with no access trail, and the
    // render-side test above would still be green.
    const render = readCode(INSPECTOR_CONTENT);
    const loader = readCode(INSPECTOR_LOADER);
    expect(render).not.toContain("logWelfareLocationViewed");
    // The CALL, not the import and not the header comment that names it.
    expect(loader).toMatch(/await\s+logWelfareLocationViewed\(/);
  });
});

// ---------------------------------------------------------------------------
// Evidencia con metadatos: qué se sirve en la superficie pública
// (segunda pasada de auditoría, hallazgo #1, 2026-08-12)
// ---------------------------------------------------------------------------
//
// El comprobante público firmaba y servía los adjuntos de la denuncia. `sharp`
// sólo re-encodea jpeg/png/webp; en ese momento HEIC/HEIF/GIF y video se
// guardaban con los bytes originales, o sea con el GPS de la cámara intacto (HEIC
// se rechaza desde D4, 2026-09-18). Servirlos derrotaba el mismo control que esta página aplica al punto
// del mapa (coarsenPoint "approx") y a la dirección de calle (Ley 25.326): se
// descarga el archivo y se lee la coordenada exacta del metadato.
//
// El riesgo estaba anotado como aceptado (LOW-2, "readable by an operator …
// never the public") con una premisa que nunca fue cierta: el comprobante ES
// público.
//
// QUÉ TENDRÍA QUE ROMPERSE PARA QUE ESTO FALLE: que el gate se saque o que se
// agregue un formato a ALLOWED_MIME sin poder estriparlo.
describe("evidencia de denuncia — sólo se sirve en público lo que pudimos estripar", () => {
  it("NO declara con metadatos removidos a HEIC, GIF ni video", () => {
    // HEIC/HEIF ya no se aceptan (decisión D4 del PO, 2026-09-18: se rechazan en
    // vez de transcodificarse — __tests__/welfare-uploads.test.ts lo prueba), pero
    // si alguno llegara a estar guardado sigue sin poder declararse limpio. El
    // video se sigue aceptando (el denunciante filma con el teléfono) con sus
    // metadatos hasta el neutralizador de D4b, así que tampoco.
    expect(isMetadataStripped("image/heic")).toBe(false);
    expect(isMetadataStripped("image/heif")).toBe(false);
    expect(isMetadataStripped("image/gif")).toBe(false);
    expect(isMetadataStripped("video/mp4")).toBe(false);
    expect(isMetadataStripped("video/quicktime")).toBe(false);
    expect(isMetadataStripped("video/webm")).toBe(false);
  });

  it("declara removidos los tres formatos que sharp sí re-encodea", () => {
    expect(isMetadataStripped("image/jpeg")).toBe(true);
    expect(isMetadataStripped("image/png")).toBe(true);
    expect(isMetadataStripped("image/webp")).toBe(true);
  });

  it("falla cerrado ante un formato desconocido, null o vacío", () => {
    // Si mañana alguien suma un tipo a ALLOWED_MIME y olvida el strip, el
    // comprobante público no lo muestra en vez de filtrarlo.
    expect(isMetadataStripped("image/avif")).toBe(false);
    expect(isMetadataStripped("application/pdf")).toBe(false);
    expect(isMetadataStripped(null)).toBe(false);
    expect(isMetadataStripped(undefined)).toBe(false);
    expect(isMetadataStripped("")).toBe(false);
  });

  it("el comprobante público NO mintea ninguna URL firmada, con gate o sin gate", () => {
    // ANTES este caso exigía que la llamada estuviera CONDICIONADA a
    // isMetadataStripped: se servía la evidencia cuyos metadatos habíamos podido
    // remover, y se retenía el HEIC/video que podía conservar el GPS de la cámara.
    // Ese gate resolvía el problema equivocado. Una URL firmada es una capacidad
    // al portador: vive 3600s (WELFARE_ATTACHMENT_URL_TTL_SECONDS), sobrevive a la
    // visita, se reenvía por WhatsApp y viaja directo a Supabase Storage sin pasar
    // por nuestro rate limiter. Que la foto no traiga GPS no la vuelve publicable
    // cuando muestra el patio de una persona que todavía no fue investigada.
    //
    // Ahora la afirmación es más fuerte y no admite matices: en esta superficie no
    // se firma nada. El denunciante ya tiene sus propios archivos y el organismo
    // los recibe completos por su camino autenticado (cadena de evidencia, Ley
    // 14.346). Sobre CÓDIGO, no sobre texto crudo: readCode blanquea comentarios,
    // y este archivo NOMBRA las dos funciones en prosa.
    const src = readCode(PUBLIC_RECEIPT);
    expect(src).not.toMatch(/welfareAttachmentSignedUrl\(/);
    expect(src).not.toMatch(/isMetadataStripped\(/);
    // Ni siquiera se leen los adjuntos: sin fila no hay storagePath que firmar.
    expect(src).not.toMatch(/welfareReportAttachments/);
  });
});

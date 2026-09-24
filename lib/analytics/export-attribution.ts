// Shared attribution footer for every PDF this system hands to a human.
//
// WHY THIS MODULE EXISTS
// ---------------------------------------------------------------------------
// The line "Documento generado por DIM — Trazabilidad: … — mimar.ar" was
// triplicated verbatim across the MPF (fiscalía) denuncia, the PPP certificate
// and the travel document. All three signed the document with "DIM" — the
// INTERNAL codename (CLAUDE.md: "Internal codename DIM (code, schema,
// DIM-XXXX-XXXX tokens); user-facing brand miMAR").
//
// On the Ley 14.346 denuncia that is not a cosmetic slip: the header says
// "miMAR — Mi Mascota Argentina" and the footer of the same page attributed
// the document to a different, unexplained name. A fiscal reading it sees two
// issuers on one instrument.
//
// Triplication is what let one wrong word ship to three legal surfaces, so the
// fix is a single origin, not three edits. scripts/check-brand-casing.ts
// Rule 2 keeps it from coming back.
//
// The codename is NOT a secret — /acerca discloses it deliberately. It simply
// is not the name the product signs documents with.

import { CANONICAL_DOMAIN } from "@/lib/infra/site-url";

/** User-facing brand. The codename never appears in document attribution. */
export const PUBLIC_BRAND_NAME = "miMAR";

/**
 * Public domain printed alongside the attribution.
 *
 * It read `mimar.ar` until 2026-09-07, and that domain DOES NOT EXIST — no NS,
 * no A, on both 8.8.8.8 and 1.1.1.1. Unlike the site-url fallback, nothing
 * conditioned this: every denuncia, PPP certificate and travel document ever
 * exported footed a legal instrument with an address its reader cannot reach,
 * under the one line whose job is to say where to go and check.
 *
 * Re-exported from lib/infra/site-url.ts rather than typed again. A domain
 * spelled in two modules is the same defect this file's header opens with —
 * "triplication is what let one wrong word ship to three legal surfaces, so
 * the fix is a single origin, not three edits" — and it is exactly how the
 * dead value survived here after the mailbox sweep had already replaced it
 * everywhere else. `www.` is deliberately absent: this is read off paper and
 * typed by hand, and the apex resolves.
 */
export const PUBLIC_BRAND_DOMAIN: string = CANONICAL_DOMAIN;

/**
 * The one-line attribution printed at the foot of every exported PDF.
 *
 * @param traceabilityCode the code that lets the holder trace this exact
 *   document back to its record — a denuncia reference code (MPF) or a pet
 *   public token (PPP / travel).
 */
export function documentAttributionLine(traceabilityCode: string): string {
  return `Documento generado por ${PUBLIC_BRAND_NAME} — Trazabilidad: ${traceabilityCode} — ${PUBLIC_BRAND_DOMAIN}`;
}

/**
 * The authenticity disclosure printed under the attribution.
 *
 * The candour here is the best thing about these documents and is kept
 * verbatim in substance: the system does NOT cryptographically sign its PDFs,
 * and the document says so to the fiscal reading it rather than implying a
 * guarantee it cannot make.
 *
 * What changed (2026-07-30) is who the sentence is written for. It read:
 *
 *   "Sin firma PKI. Autenticidad verificable via referenceCode + audit_log
 *    (F-D2)."
 *
 * "(F-D2)" is an INTERNAL requirement id from the change that built this
 * export — meaningless to a fiscal and, printed at the foot of a Ley 14.346
 * denuncia, indistinguishable from a legal citation. `referenceCode` and
 * `audit_log` are a struct field and a database table dropped raw into a
 * Spanish sentence. All three named real things; none of them named those
 * things in the reader's language.
 *
 * The two artefacts are now described by what they ARE to the reader: the
 * reference code printed at the head of this same document, and the system's
 * audit trail. Nothing about the PKI disclosure is softened.
 */
export function authenticityNote(credentialPhrase: string): string {
  return `Sin firma PKI. La autenticidad se verifica con ${credentialPhrase} y el registro de auditoría del sistema.`;
}

/** Ley 14.346 denuncia (MPF) — traced by the denuncia's reference code. */
export const MPF_AUTHENTICITY_NOTE = authenticityNote("el código de referencia de esta denuncia");

/** PPP certificate — traced by the pet's public credential token. */
export const PPP_AUTHENTICITY_NOTE = authenticityNote("el token miMAR de la credencial");

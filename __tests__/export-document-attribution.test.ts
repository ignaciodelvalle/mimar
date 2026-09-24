// Every PDF this system hands to a human is signed with the PUBLIC brand.
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// The MPF (fiscalía) denuncia PDF — "DENUNCIA FORMAL — LEY NACIONAL 14.346
// (1954)", the instrument filed with the Unidad Fiscal de Maltrato Animal —
// carried a header reading "miMAR — Mi Mascota Argentina" and, on the same
// page, a footer reading "Documento generado por DIM". "DIM" is the INTERNAL
// codename (CLAUDE.md: internal codename DIM; user-facing brand miMAR). A
// fiscal reading that page saw two different issuers on one legal instrument.
//
// The same line was triplicated verbatim into the PPP certificate and the
// travel document, so one wrong word signed three legal surfaces. It now has
// a single origin: lib/analytics/export-attribution.ts.
//
// The PDFs themselves are pdf-lib byte streams with no text-extraction path in
// this repo, so these tests assert the exported pure builders that produce the
// strings the renderers draw. The renderers call these builders directly — see
// welfare-exports.ts / ppp-exports.ts / travel-exports.ts.

import { describe, expect, it } from "vitest";

import {
  MPF_AUTHENTICITY_NOTE,
  PPP_AUTHENTICITY_NOTE,
  PUBLIC_BRAND_NAME,
  documentAttributionLine,
} from "@/lib/analytics/export-attribution";
import { buildTravelExportSections } from "@/lib/analytics/travel-exports";
import { UNRESOLVED_EXPORTER_LABEL } from "@/src/modules/welfare/infrastructure/welfare-repository";

/**
 * The internal codename as a standalone word — NOT the `DIM-XXXX-XXXX`
 * credential token, which is public by design. Mirrors the rule enforced by
 * scripts/check-brand-casing.ts Rule 2: a hyphen on either side means "token",
 * anything else means "codename".
 */
const INTERNAL_CODENAME = /(?<!-)\bDIM\b(?!-)/;

describe("documentAttributionLine — the brand signs the document, not the codename", () => {
  it("attributes the document to the public brand", () => {
    // Literal, not PUBLIC_BRAND_NAME: asserting the line contains the very
    // constant it is built from is a tautology that survives any mutation of
    // that constant (found by mutating PUBLIC_BRAND_NAME back to the codename
    // — this assertion still passed while four others failed).
    expect(documentAttributionLine("DEN-2026-000123")).toContain("miMAR");
  });

  it("never signs a document with the internal codename", () => {
    expect(documentAttributionLine("DEN-2026-000123")).not.toMatch(INTERNAL_CODENAME);
  });

  it("still carries the traceability code the holder needs to trace the document back", () => {
    expect(documentAttributionLine("DEN-2026-000123")).toContain("DEN-2026-000123");
  });

  it("carries the public domain", () => {
    // Literal for the same reason as above — and this one had to be paid for.
    // It read "mimar.ar", a domain with no NS and no A record on either 8.8.8.8
    // or 1.1.1.1, so the assertion faithfully pinned a footer that told every
    // fiscal, veterinarian and border officer to go and verify the document at
    // an address that does not exist. A tautological pin to PUBLIC_BRAND_DOMAIN
    // would have gone on passing through the fix. Whether the domain RESOLVES
    // is not something a unit test can know: __tests__/public-hostname-fence
    // holds it against the owned-domain registry instead.
    expect(documentAttributionLine("DEN-2026-000123")).toContain("mimar.com.ar");
  });

  it("does NOT flag a DIM-XXXX-XXXX pet token passed as the traceability code — the token is public by design", () => {
    // PPP and travel exports trace by pet public token, which legitimately
    // starts with the codename as a prefix. The attribution must stay clean
    // even so: the only "DIM" on the line is inside the token.
    const line = documentAttributionLine("DIM-PAMP-0001");
    expect(line).toContain("DIM-PAMP-0001");
    expect(line).not.toMatch(INTERNAL_CODENAME);
  });

  it("uses the canonical brand casing (miMAR, not MiMAR)", () => {
    expect(PUBLIC_BRAND_NAME).toBe("miMAR");
  });
});

describe("travel export — the traceability section carries the shared attribution", () => {
  it("prints the attribution built by documentAttributionLine, codename-free", () => {
    const sections = buildTravelExportSections({
      petName: "Pampa",
      petPublicToken: "DIM-PAMP-0001",
      petSpecies: "dog",
      ownerDisplayName: "Ignacio Del Valle",
      exportGeneratedAt: "30 de julio de 2026, 10:00 (hora de Argentina)",
      semaforo: "verde",
      corridors: [],
      obligations: [],
    });

    const traceability = sections.find((s) => s.kind === "traceability");
    expect(traceability).toBeDefined();
    expect(traceability?.lines).toContain(documentAttributionLine("DIM-PAMP-0001"));
    for (const line of traceability?.lines ?? []) {
      expect(line).not.toMatch(INTERNAL_CODENAME);
    }
  });
});

// ---------------------------------------------------------------------------
// The authenticity note — honest about PKI, in the reader's language
// ---------------------------------------------------------------------------
//
// The MPF footer read: "Sin firma PKI. Autenticidad verificable via
// referenceCode + audit_log (F-D2)."
//
// The candour is the best thing about this document and these tests exist to
// PROTECT it, not to soften it. What they also pin down is that the sentence
// is addressed to the fiscal reading it: "(F-D2)" is an internal requirement
// id that, printed at the foot of a Ley 14.346 denuncia, is indistinguishable
// from a legal citation, and `referenceCode` / `audit_log` are a struct field
// and a database table dropped raw into a Spanish sentence.

describe("authenticity note — the PKI disclosure survives, the internal codes do not", () => {
  const NOTES: Array<[string, string]> = [
    ["MPF denuncia", MPF_AUTHENTICITY_NOTE],
    ["PPP certificate", PPP_AUTHENTICITY_NOTE],
  ];

  for (const [label, note] of NOTES) {
    describe(label, () => {
      it("still discloses that the document is not cryptographically signed", () => {
        expect(note).toContain("Sin firma PKI");
      });

      it("still tells the reader authenticity IS verifiable", () => {
        expect(note).toContain("autenticidad se verifica");
      });

      it("names the audit trail in Spanish, not as a table name", () => {
        expect(note).toContain("registro de auditoría");
        expect(note).not.toContain("audit_log");
      });

      it("carries no internal requirement code", () => {
        // "(F-D2)" is an id from the change that built this export. A fiscal
        // cannot tell it apart from a statute reference.
        expect(note).not.toMatch(/\bF-D\d+\b/);
      });

      it("carries no raw code identifier", () => {
        expect(note).not.toContain("referenceCode");
        expect(note).not.toMatch(/[a-z]+_[a-z]+/);
      });
    });
  }

  it("the MPF note points at the denuncia's reference code, in Spanish", () => {
    expect(MPF_AUTHENTICITY_NOTE).toContain("código de referencia");
  });

  it("the PPP note points at the credential token instead — the artefact that document actually carries", () => {
    expect(PPP_AUTHENTICITY_NOTE).toContain("token miMAR");
    expect(PPP_AUTHENTICITY_NOTE).not.toContain("código de referencia");
  });
});

describe("UNRESOLVED_EXPORTER_LABEL — the MPF 'GENERADO POR' fallback", () => {
  it("never prints the internal codename on a document filed with a fiscal", () => {
    expect(UNRESOLVED_EXPORTER_LABEL).not.toMatch(INTERNAL_CODENAME);
  });

  it("names the role, which the system does know", () => {
    expect(UNRESOLVED_EXPORTER_LABEL).toContain("Autoridad");
  });

  it("admits the identity gap instead of asserting an identity it does not have", () => {
    expect(UNRESOLVED_EXPORTER_LABEL).toContain("no disponible");
  });
});

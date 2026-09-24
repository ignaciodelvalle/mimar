// Unit tests for lib/govt-exports: Zod anonymization schemas + helpers.
//
// These are pure unit tests (no DB, no network) — they test the schema
// field-stripping behavior, anonymizeRows(), rowsToCsv(), and rowsToJson().
//
// Integration test for generateExportAction (Storage upload + Resend email +
// audit_log insert) is deferred: mocking the Supabase Storage SDK + Resend
// in a test environment without a real bucket requires significant harness
// work beyond the scope of this PR.
// TODO(E6-followup): add integration test for generateExportAction using a
// test Supabase Storage bucket + mocked Resend client.

import { describe, expect, it } from "vitest";

import { EXPORT_PRIVACY_NOTICE } from "@/app/gob/analytics/export/privacy-notice";
import {
  EXPORT_SCHEMA_VERSION,
  anonymizeRows,
  casesExportSchema,
  eventsExportSchema,
  organizationsExportSchema,
  petsExportSchema,
  rowsToCsv,
  rowsToJson,
} from "@/lib/analytics/govt-exports";

// ---------------------------------------------------------------------------
// petsExportSchema
// ---------------------------------------------------------------------------

describe("petsExportSchema", () => {
  it("drops `name` field silently", () => {
    const parsed = petsExportSchema.parse({
      publicToken: "DIM-XXXX",
      species: "perro",
      name: "Rex", // should be dropped
      ownerDisplayName: "Juan", // should be dropped
    });
    expect(parsed).not.toHaveProperty("name");
    expect(parsed).not.toHaveProperty("ownerDisplayName");
    expect(parsed.publicToken).toBe("DIM-XXXX");
  });

  it("keeps all whitelisted fields", () => {
    const parsed = petsExportSchema.parse({
      publicToken: "DIM-YYYY",
      species: "gato",
      acquisitionMethod: "adopted",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
      status: "active",
      registeredAtMonth: "2026-01",
      // Extra fields that should be stripped:
      microchipId: "123456789012345",
      dnI: "12345678",
    });
    expect(parsed.publicToken).toBe("DIM-YYYY");
    expect(parsed.species).toBe("gato");
    expect(parsed.acquisitionMethod).toBe("adopted");
    expect(parsed.jurisdictionProvince).toBe("Buenos Aires");
    expect(parsed.jurisdictionLocality).toBe("La Plata");
    expect(parsed.status).toBe("active");
    expect(parsed.registeredAtMonth).toBe("2026-01");
    expect(parsed).not.toHaveProperty("microchipId");
    expect(parsed).not.toHaveProperty("dnI");
  });

  it("rejects rows missing required publicToken", () => {
    const result = petsExportSchema.safeParse({ species: "perro" });
    expect(result.success).toBe(false);
  });

  it("rejects rows missing required species", () => {
    const result = petsExportSchema.safeParse({ publicToken: "DIM-XXXX" });
    expect(result.success).toBe(false);
  });

  it("allows optional fields to be absent", () => {
    const parsed = petsExportSchema.parse({ publicToken: "DIM-ZZZZ", species: "perro" });
    expect(parsed.publicToken).toBe("DIM-ZZZZ");
    // Optional fields should be undefined (not present) when absent.
    expect(parsed.acquisitionMethod).toBeUndefined();
    expect(parsed.jurisdictionProvince).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// eventsExportSchema
// ---------------------------------------------------------------------------

describe("eventsExportSchema", () => {
  it("drops performedByUserId", () => {
    const parsed = eventsExportSchema.parse({
      petPublicToken: "DIM-AAAA",
      eventType: "vaccination_administered",
      occurredAtMonth: "2026-03",
      performedByUserId: "some-uuid", // should be dropped
    });
    expect(parsed).not.toHaveProperty("performedByUserId");
    expect(parsed.petPublicToken).toBe("DIM-AAAA");
  });

  it("drops location coordinates", () => {
    const parsed = eventsExportSchema.parse({
      petPublicToken: "DIM-BBBB",
      eventType: "status_changed",
      occurredAtMonth: "2026-01",
      locationLat: -34.6037, // should be dropped
      locationLng: -58.3816, // should be dropped
    });
    expect(parsed).not.toHaveProperty("locationLat");
    expect(parsed).not.toHaveProperty("locationLng");
  });

  it("drops payload notes", () => {
    const parsed = eventsExportSchema.parse({
      petPublicToken: "DIM-CCCC",
      eventType: "outbreak_signal",
      occurredAtMonth: "2026-02",
      "payload.notes": "private note", // should be dropped
      recordedByUserId: "another-uuid", // should be dropped
    });
    expect(parsed).not.toHaveProperty("payload.notes");
    expect(parsed).not.toHaveProperty("recordedByUserId");
  });

  it("rejects rows missing required fields", () => {
    const result = eventsExportSchema.safeParse({ petPublicToken: "DIM-DDDD" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// casesExportSchema
// ---------------------------------------------------------------------------

describe("casesExportSchema", () => {
  it("drops party identity fields", () => {
    const parsed = casesExportSchema.parse({
      publicCode: "CASE-001",
      caseKind: "welfare_denuncia",
      status: "open",
      createdAtMonth: "2026-04",
      openedByUserId: "some-uuid", // should be dropped
      applicantUserId: "another-uuid", // should be dropped
    });
    expect(parsed).not.toHaveProperty("openedByUserId");
    expect(parsed).not.toHaveProperty("applicantUserId");
    expect(parsed.publicCode).toBe("CASE-001");
  });
});

// ---------------------------------------------------------------------------
// organizationsExportSchema
// ---------------------------------------------------------------------------

describe("organizationsExportSchema", () => {
  it("keeps display fields and drops sensitive ones", () => {
    const parsed = organizationsExportSchema.parse({
      publicToken: "ORG-001",
      displayName: "Refugio Patitas",
      orgType: "shelter",
      verified: true,
      jurisdictionProvince: "Córdoba",
      jurisdictionLocality: "Córdoba Capital",
      cuit: "30-12345678-9", // should be dropped
      email: "info@patitas.org", // should be dropped
    });
    expect(parsed.publicToken).toBe("ORG-001");
    expect(parsed.displayName).toBe("Refugio Patitas");
    expect(parsed.verified).toBe(true);
    expect(parsed).not.toHaveProperty("cuit");
    expect(parsed).not.toHaveProperty("email");
  });
});

// ---------------------------------------------------------------------------
// anonymizeRows
// ---------------------------------------------------------------------------

describe("anonymizeRows", () => {
  it("returns cleaned rows + rejected count", () => {
    const result = anonymizeRows("pets", [
      { publicToken: "A", species: "perro" }, // valid
      { publicToken: "B", species: "gato", name: "Rex" }, // name dropped, still valid
      { species: "perro" }, // missing publicToken — rejected
    ]);
    expect(result.rows.length).toBe(2);
    expect(result.rejected).toBe(1);
    expect(result.rows[1]).not.toHaveProperty("name");
  });

  it("counts zero rejections when all rows are valid", () => {
    const result = anonymizeRows("pets", [
      { publicToken: "X1", species: "perro" },
      { publicToken: "X2", species: "gato" },
    ]);
    expect(result.rows.length).toBe(2);
    expect(result.rejected).toBe(0);
  });

  it("returns empty rows + zero rejected for empty input", () => {
    const result = anonymizeRows("pets", []);
    expect(result.rows).toHaveLength(0);
    expect(result.rejected).toBe(0);
  });

  it("rejects all rows if all are missing required fields", () => {
    const result = anonymizeRows("pets", [
      { species: "perro" }, // missing publicToken
      { species: "gato" }, // missing publicToken
    ]);
    expect(result.rows).toHaveLength(0);
    expect(result.rejected).toBe(2);
  });

  it("works for events slice", () => {
    const result = anonymizeRows("events", [
      {
        petPublicToken: "DIM-001",
        eventType: "vaccination_administered",
        occurredAtMonth: "2026-01",
        performedByUserId: "drop-me",
      },
      { eventType: "status_changed", occurredAtMonth: "2026-02" }, // missing petPublicToken
    ]);
    expect(result.rows).toHaveLength(1);
    expect(result.rejected).toBe(1);
    expect(result.rows[0]).not.toHaveProperty("performedByUserId");
  });

  it("works for cases slice", () => {
    const result = anonymizeRows("cases", [
      {
        publicCode: "CASE-001",
        caseKind: "welfare_denuncia",
        status: "open",
        createdAtMonth: "2026-03",
      },
    ]);
    expect(result.rows).toHaveLength(1);
    expect(result.rejected).toBe(0);
  });

  it("works for organizations slice", () => {
    const result = anonymizeRows("organizations", [
      {
        publicToken: "ORG-001",
        displayName: "Refugio XYZ",
        orgType: "shelter",
        verified: false,
        cuit: "should-be-dropped",
      },
    ]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).not.toHaveProperty("cuit");
  });
});

// ---------------------------------------------------------------------------
// rowsToCsv
// ---------------------------------------------------------------------------

describe("rowsToCsv", () => {
  it("emits headers + values in CSV format", () => {
    const csv = rowsToCsv([
      { publicToken: "A", species: "perro" },
      { publicToken: "B", species: "gato" },
    ]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("publicToken,species");
    expect(lines[1]).toBe("A,perro");
    expect(lines[2]).toBe("B,gato");
  });

  it("returns empty string for empty rows array", () => {
    expect(rowsToCsv([])).toBe("");
  });

  it("escapes cells with embedded commas (RFC 4180)", () => {
    const csv = rowsToCsv([{ displayName: "Refugio, Patitas", orgType: "shelter" }]);
    expect(csv).toContain('"Refugio, Patitas"');
  });

  it("escapes cells with embedded double quotes (RFC 4180 — double up)", () => {
    const csv = rowsToCsv([{ displayName: 'He said "hello"', orgType: "shelter" }]);
    // RFC 4180: enclose in quotes AND double internal quotes.
    expect(csv).toContain('"He said ""hello"""');
  });

  it("escapes cells with embedded newlines", () => {
    const csv = rowsToCsv([{ displayName: "line1\nline2", orgType: "shelter" }]);
    expect(csv).toContain('"line1\nline2"');
  });

  it("handles null/undefined cell values as empty strings", () => {
    const csv = rowsToCsv([{ publicToken: "A", species: null, status: undefined }]);
    const lines = csv.split("\r\n");
    // headers
    expect(lines[0]).toBe("publicToken,species,status");
    // values — nulls and undefined become empty
    expect(lines[1]).toBe("A,,");
  });

  // -------------------------------------------------------------------------
  // CSV formula injection
  //
  // Every government and open-data CSV in the product funnels through this one
  // function, so this is where the class is closed rather than at six call
  // sites. The reachable path that made it urgent: a vet types a formula into a
  // free-text clinical field (`laboratorio`, `lote_biologico`), and a SENASA
  // operator opens the export on their desktop. RFC 4180 quoting does not help
  // — the spreadsheet strips the quotes and evaluates what is inside.
  // -------------------------------------------------------------------------

  it.each([
    ["equals", '=HYPERLINK("http://x/","ok")'],
    ["plus", "+1+1"],
    ["at", "@SUM(A1:A9)"],
    ["tab", "\tcmd"],
    ["carriage return", "\rcmd"],
  ])("neutralizes a string cell starting with %s", (_label, payload) => {
    const csv = rowsToCsv([{ laboratorio: payload }]);
    const cell = csv.split("\r\n")[1];
    // The leading apostrophe is what makes a spreadsheet treat the rest as
    // literal text. It survives RFC 4180 quoting when quoting also applies.
    expect(cell.replace(/^"|"$/g, "").startsWith("'")).toBe(true);
  });

  it("neutralizes the minus vector that a naive 'minus then digit' exemption would miss", () => {
    // `-2+3+cmd|' /C calc'!A0` is the canonical DDE payload and it begins with
    // a minus followed by a DIGIT — which is exactly the shape an exemption
    // written to protect negative numbers would wave through.
    const csv = rowsToCsv([{ lote: "-2+3+cmd|' /C calc'!A0" }]);
    expect(csv.split("\r\n")[1].startsWith("'-2")).toBe(true);
  });

  it("leaves a NEGATIVE NUMBER alone — the exemption is by type, not by pattern", () => {
    // A real negative quantity in a column somebody sums must stay summable.
    const csv = rowsToCsv([{ delta: -5, total: 12 }]);
    expect(csv.split("\r\n")[1]).toBe("-5,12");
  });

  it("leaves ordinary text untouched, so the guard is not a blanket prefix", () => {
    const csv = rowsToCsv([{ laboratorio: "Biogénesis Bagó", lote: "A1234" }]);
    expect(csv.split("\r\n")[1]).toBe("Biogénesis Bagó,A1234");
  });
});

// ---------------------------------------------------------------------------
// rowsToJson
// ---------------------------------------------------------------------------

describe("rowsToJson", () => {
  it("returns pretty-printed JSON array", () => {
    const json = rowsToJson([{ publicToken: "A", species: "perro" }]);
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].publicToken).toBe("A");
  });

  it("returns empty array JSON for empty input", () => {
    const json = rowsToJson([]);
    expect(JSON.parse(json)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// EXPORT_SCHEMA_VERSION
// ---------------------------------------------------------------------------

describe("EXPORT_SCHEMA_VERSION", () => {
  it("is a non-empty string (used in audit log payload)", () => {
    expect(typeof EXPORT_SCHEMA_VERSION).toBe("string");
    expect(EXPORT_SCHEMA_VERSION.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// D2 (PO 2026-08-23) — the export declares itself a row-level padrón
//
// /gob/analytics/export is a ROW-LEVEL CSV and the k-anonymity policy is simply
// not applied to it: `anonymizeRows` only STRIPS fields (the schema tests above
// are the proof), it never suppresses a cell, so `SELECT locality, count(*) …
// GROUP BY 1` over the rows reconstructs every cell the map suppresses. The PO
// decided NOT to aggregate it — a funcionario needs the padrón of their own
// territory and suppressing cells breaks the purpose. What was dishonest was
// the operator notice calling the file "anonimizado" while handing over one row
// per animal.
// ---------------------------------------------------------------------------

describe("EXPORT_PRIVACY_NOTICE — says what the operator is actually downloading (D2)", () => {
  it("calls the file row-level, and drops the anonymity it does not deliver", () => {
    expect(EXPORT_PRIVACY_NOTICE).toMatch(/fila por fila|nivel de fila/i);
    // The old copy promised anonymity it does not deliver. A padrón of one row
    // per animal is pseudonymous at best.
    expect(EXPORT_PRIVACY_NOTICE).not.toMatch(/est[aá]n anonimizados/i);
  });

  it("states it is OUTSIDE the k-anonymity policy that governs the dashboards", () => {
    expect(EXPORT_PRIVACY_NOTICE).toMatch(/anonimato/i);
    expect(EXPORT_PRIVACY_NOTICE).toMatch(/no se aplica|queda fuera|fuera de/i);
  });

  it("states the two properties the declaration rests on: own jurisdiction + audited", () => {
    expect(EXPORT_PRIVACY_NOTICE).toMatch(/jurisdicci[oó]n/i);
    expect(EXPORT_PRIVACY_NOTICE).toMatch(/auditor[ií]a/i);
  });
});

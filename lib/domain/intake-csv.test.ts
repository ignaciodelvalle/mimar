// Unit tests for the intake CSV domain (org-pilot-pack Req 1, design D1/D6):
// header round-trip through the real csv-parse, delimiter sniff, windows-1252
// fallback (Excel es-AR), DD/MM/AAAA normalization, enum mapping, duplicate
// flagging and the failed-rows re-download layout.

import { parse } from "csv-parse/sync";
import { describe, expect, it } from "vitest";

import {
  INTAKE_CSV_COLUMNS,
  INTAKE_CSV_EXPORT_STATUS_HEADER,
  buildFailedRowsCsv,
  buildIntakeCsvTemplate,
  buildIntakeExportCsv,
  decodeIntakeCsv,
  findExactDuplicateRows,
  intakeReasonToIntakeCsvValue,
  mapIntakeCsvRecord,
  normalizeIntakeCsvDate,
  sexToIntakeCsvValue,
  sniffIntakeCsvDelimiter,
  speciesToIntakeCsvValue,
  weightToIntakeCsvValue,
} from "./intake-csv";

function parseTemplate(text: string): Record<string, string>[] {
  return parse(text.replace(/^﻿/, ""), {
    columns: true,
    delimiter: ";",
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];
}

describe("buildIntakeCsvTemplate", () => {
  it("emits BOM + semicolons + CRLF + all headers + one example row", () => {
    const template = buildIntakeCsvTemplate();
    expect(template.startsWith("﻿")).toBe(true);
    expect(template).toContain("\r\n");
    const headerLine = template.replace(/^﻿/, "").split("\r\n")[0];
    for (const column of INTAKE_CSV_COLUMNS) {
      expect(headerLine).toContain(column.header.replace(/,.*/, ""));
    }
    const rows = parseTemplate(template);
    expect(rows).toHaveLength(1);
  });

  it("round-trips: the example row maps cleanly through mapIntakeCsvRecord", () => {
    const [example] = parseTemplate(buildIntakeCsvTemplate());
    const { fields, errors } = mapIntakeCsvRecord(example);
    expect(errors).toEqual([]);
    expect(fields.name).toBe("Negrita");
    expect(fields.species).toBe("dog");
    expect(fields.sex).toBe("female");
    expect(fields.intakeReason).toBe("rescue");
    expect(fields.occurredAt).toBe("2026-07-01");
    // Excel es-AR decimal comma normalized to a dot.
    expect(fields.estimatedWeightKg).toBe("12.5");
    // custodyRole is not a column — it defaults to shelter custody.
    expect(fields.custodyRole).toBe("shelter_custody");
    // Quoted field containing a comma survives the round trip intact.
    expect(fields.rescueJurisdiction).toBe("La Plata, Buenos Aires");
  });
});

describe("sniffIntakeCsvDelimiter", () => {
  it("detects semicolons (Excel es-AR)", () => {
    expect(sniffIntakeCsvDelimiter("nombre*;especie*;sexo\r\na;b;c")).toBe(";");
  });

  it("detects commas", () => {
    expect(sniffIntakeCsvDelimiter("nombre*,especie*,sexo\r\na,b,c")).toBe(",");
  });

  it("defaults to semicolon (the template's own delimiter)", () => {
    expect(sniffIntakeCsvDelimiter("nombre*")).toBe(";");
  });
});

describe("decodeIntakeCsv", () => {
  it("decodes UTF-8 with BOM, stripping the BOM", () => {
    const body = new TextEncoder().encode("nombre*;señas\r\náéñ;x\r\n");
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...body]);
    const { text, encoding } = decodeIntakeCsv(bytes);
    expect(encoding).toBe("utf-8");
    expect(text.startsWith("nombre*")).toBe(true);
    expect(text).toContain("áéñ");
  });

  it("falls back to windows-1252 for Latin-1 Excel exports (no mojibake)", () => {
    // "ñandú árbol café" in windows-1252 single bytes — invalid as UTF-8.
    const latin = "nombre*;color\r\nÑandú;marrón café\r\n";
    const bytes = new Uint8Array([...latin].map((ch) => ch.charCodeAt(0)));
    const { text, encoding } = decodeIntakeCsv(bytes);
    expect(encoding).toBe("windows-1252");
    expect(text).toContain("Ñandú");
    expect(text).toContain("marrón café");
    // U+FFFD via fromCharCode: the encoding-fitness fence forbids the literal
    // replacement character anywhere in source, and a string escape here is
    // one tooling-roundtrip away from becoming that literal.
    expect(text).not.toContain(String.fromCharCode(0xfffd));
  });
});

describe("normalizeIntakeCsvDate", () => {
  it("normalizes DD/MM/AAAA to ISO", () => {
    expect(normalizeIntakeCsvDate("09/07/2026")).toBe("2026-07-09");
  });

  it("rejects malformed formats", () => {
    expect(normalizeIntakeCsvDate("2026-07-09")).toBeNull();
    expect(normalizeIntakeCsvDate("9/7/2026")).toBeNull();
    expect(normalizeIntakeCsvDate("hoy")).toBeNull();
  });

  it("rejects impossible calendar dates", () => {
    expect(normalizeIntakeCsvDate("31/02/2026")).toBeNull();
    expect(normalizeIntakeCsvDate("00/01/2026")).toBeNull();
    expect(normalizeIntakeCsvDate("15/13/2026")).toBeNull();
  });
});

describe("mapIntakeCsvRecord — named per-column errors (spec 1.3)", () => {
  const validRecord: Record<string, string> = {
    "nombre*": "Rocío",
    "especie*": "gato",
    sexo: "macho",
    "motivo_ingreso*": "via_publica",
    "fecha_ingreso*": "01/06/2026",
  };

  it("maps valid es-AR enums to intake enum values", () => {
    const { fields, errors } = mapIntakeCsvRecord(validRecord);
    expect(errors).toEqual([]);
    expect(fields.species).toBe("cat");
    expect(fields.sex).toBe("male");
    expect(fields.intakeReason).toBe("stray_found");
  });

  it("rejects an invalid especie naming the column and the options", () => {
    const { errors } = mapIntakeCsvRecord({ ...validRecord, "especie*": "conejo" });
    expect(errors.some((e) => e.startsWith("especie:") && e.includes("conejo"))).toBe(true);
  });

  it("rejects an invalid motivo_ingreso naming the column", () => {
    const { errors } = mapIntakeCsvRecord({ ...validRecord, "motivo_ingreso*": "compra" });
    expect(errors.some((e) => e.startsWith("motivo_ingreso:"))).toBe(true);
  });

  it("flags missing required columns by name", () => {
    const { errors } = mapIntakeCsvRecord({ "especie*": "perro" });
    expect(errors.some((e) => e.startsWith("nombre:"))).toBe(true);
    expect(errors.some((e) => e.startsWith("motivo_ingreso:"))).toBe(true);
    expect(errors.some((e) => e.startsWith("fecha_ingreso:"))).toBe(true);
  });

  it("rejects an invalid fecha_ingreso naming the column", () => {
    const { errors } = mapIntakeCsvRecord({ ...validRecord, "fecha_ingreso*": "31/02/2026" });
    expect(errors.some((e) => e.startsWith("fecha_ingreso:"))).toBe(true);
  });

  it("accepts headers without asterisks and with different casing", () => {
    const { fields, errors } = mapIntakeCsvRecord({
      Nombre: "Luna",
      ESPECIE: "perro",
      "motivo_ingreso*": "rescate",
      fecha_ingreso: "01/06/2026",
    });
    expect(errors).toEqual([]);
    expect(fields.name).toBe("Luna");
    expect(fields.species).toBe("dog");
  });
});

describe("findExactDuplicateRows (spec 1.10 — warn, never dedupe)", () => {
  it("flags only later byte-identical rows", () => {
    const a = { "nombre*": "Uno", "especie*": "perro" };
    const rows = [a, { "nombre*": "Dos", "especie*": "perro" }, { ...a }, { ...a }];
    const dupes = findExactDuplicateRows(rows);
    expect(dupes).toEqual(new Set([2, 3]));
  });

  it("near-identical rows (littermates) are NOT flagged", () => {
    const rows = [
      { "nombre*": "Cachorro 1", "especie*": "perro" },
      { "nombre*": "Cachorro 2", "especie*": "perro" },
    ];
    expect(findExactDuplicateRows(rows).size).toBe(0);
  });
});

describe("buildFailedRowsCsv (spec 1.6)", () => {
  it("keeps the template layout, preserves original values and appends errores", () => {
    const csv = buildFailedRowsCsv([
      {
        record: { "nombre*": "Fallida", "especie*": "conejo", "fecha_ingreso*": "31/02/2026" },
        errors: ["especie: valor inválido «conejo»"],
      },
    ]);
    expect(csv.startsWith("﻿")).toBe(true);
    const [header, row] = csv.replace(/^﻿/, "").split("\r\n");
    expect(header.endsWith(";errores")).toBe(true);
    expect(header).toContain("nombre*");
    expect(row).toContain("Fallida");
    expect(row).toContain("conejo");
    expect(row).toContain("valor inválido");
  });
});

// ---------------------------------------------------------------------------
// Export half — the roster download (org-first readiness finding #4)
// ---------------------------------------------------------------------------
//
// The property under test is the ROUND TRIP: whatever the export writes must be
// readable by the import without an edit. These are the pure assertions; the
// live-DB route test (__tests__/org-mascotas-export-route.test.ts) makes the
// same trip with real rows.

describe("buildIntakeExportCsv (export half)", () => {
  it("mirrors the template exactly — BOM, semicolons, CRLF, same headers in the same order", () => {
    const template = buildIntakeCsvTemplate().replace(/^﻿/, "").split("\r\n")[0];
    const csv = buildIntakeExportCsv([{ nombre: "Negrita" }]);

    expect(csv.startsWith("﻿")).toBe(true);
    const header = csv.replace(/^﻿/, "").split("\r\n")[0];
    // The export header IS the template header plus the one export-only column.
    expect(header).toBe(`${template};${INTAKE_CSV_EXPORT_STATUS_HEADER}`);
    expect(csv).toContain("\r\n");
  });

  it("is keyed by the catalog key, not the starred header — callers never type a header", () => {
    // "nombre" (the normalized key), NOT "nombre*". A caller keying by the
    // starred header would silently export a column of blanks.
    const csv = buildIntakeExportCsv([{ nombre: "Negrita", "especie*": "perro" }]);
    const row = csv.replace(/^﻿/, "").split("\r\n")[1];
    expect(row.startsWith("Negrita;")).toBe(true);
    // The wrong-key value went nowhere rather than landing in some other cell.
    expect(row).not.toContain("perro");
  });

  it("round-trips a full row back through the import path with zero errors", () => {
    const csv = buildIntakeExportCsv([
      {
        nombre: "Negrita",
        especie: speciesToIntakeCsvValue("dog"),
        sexo: sexToIntakeCsvValue("female"),
        edad_anios: "2",
        edad_meses: "6",
        raza: "mestizo",
        color: "negro",
        peso_estimado_kg: weightToIntakeCsvValue("12.50"),
        senias_particulares: "mancha blanca",
        microchip: "900123456789012",
        pais_chip: "032",
        tatuaje: "AB-123",
        motivo_ingreso: intakeReasonToIntakeCsvValue("rescue"),
        condicion_ingreso: "buen estado general",
        // Embedded comma — the escape has to survive a `;`-delimited file.
        jurisdiccion_rescate: "La Plata, Buenos Aires",
        fecha_ingreso: "01/07/2026",
        [INTAKE_CSV_EXPORT_STATUS_HEADER]: "Activa",
      },
    ]);

    // Exactly the import's own entry point: decode the bytes, sniff, parse, map.
    const bytes = new TextEncoder().encode(csv);
    const { text, encoding } = decodeIntakeCsv(bytes);
    expect(encoding).toBe("utf-8");
    expect(sniffIntakeCsvDelimiter(text)).toBe(";");

    const [record] = parseTemplate(text);
    const { fields, errors } = mapIntakeCsvRecord(record);
    expect(errors).toEqual([]);
    expect(fields.name).toBe("Negrita");
    expect(fields.species).toBe("dog");
    expect(fields.sex).toBe("female");
    expect(fields.intakeReason).toBe("rescue");
    expect(fields.occurredAt).toBe("2026-07-01");
    expect(fields.estimatedWeightKg).toBe("12.5");
    expect(fields.microchipId).toBe("900123456789012");
    expect(fields.tattooCode).toBe("AB-123");
    expect(fields.rescueJurisdiction).toBe("La Plata, Buenos Aires");
    // `estado` is export-only: header-keyed mapping ignores it instead of
    // choking on an unknown column.
    expect(fields).not.toHaveProperty("estado");
  });

  it("emits only a header for an empty roster — never a stray blank data row", () => {
    const csv = buildIntakeExportCsv([]);
    expect(parseTemplate(csv)).toEqual([]);
  });
});

describe("export value mappers are the exact inverse of the import maps", () => {
  it("maps every species/sex/reason the import accepts, in both directions", () => {
    // Derived from the import's own example + enum error text rather than a
    // second hand-written table, so a new enum value cannot be added to one
    // side alone without this failing.
    for (const [es, en] of [
      ["perro", "dog"],
      ["gato", "cat"],
      ["otra", "other"],
    ]) {
      expect(speciesToIntakeCsvValue(en)).toBe(es);
    }
    for (const [es, en] of [
      ["macho", "male"],
      ["hembra", "female"],
      ["desconocido", "unknown"],
    ]) {
      expect(sexToIntakeCsvValue(en)).toBe(es);
    }
    for (const [es, en] of [
      ["rescate", "rescue"],
      ["entrega", "surrender"],
      ["via_publica", "stray_found"],
      ["otro", "other"],
    ]) {
      expect(intakeReasonToIntakeCsvValue(en)).toBe(es);
    }
  });

  it("emits an unmapped species RAW instead of folding it into «otra»", () => {
    // A ferret exported as "otra" would come back as species=other and the
    // animal would have quietly changed species. Raw means the re-import names
    // the column and the value, and a human decides.
    expect(speciesToIntakeCsvValue("ferret")).toBe("ferret");
    const { errors } = mapIntakeCsvRecord({
      "nombre*": "Hurón",
      "especie*": "ferret",
      "motivo_ingreso*": "rescate",
      "fecha_ingreso*": "01/07/2026",
    });
    expect(errors.some((e) => e.startsWith("especie:"))).toBe(true);
  });

  it("leaves a missing intake reason EMPTY rather than inventing «otro»", () => {
    expect(intakeReasonToIntakeCsvValue(null)).toBe("");
    expect(intakeReasonToIntakeCsvValue(undefined)).toBe("");
  });

  it("writes weights with a decimal comma and no scale padding", () => {
    // Postgres numeric(5,2) arrives as "12.50"; the operator typed 12,5.
    expect(weightToIntakeCsvValue("12.50")).toBe("12,5");
    expect(weightToIntakeCsvValue(3)).toBe("3");
    expect(weightToIntakeCsvValue(null)).toBe("");
    expect(weightToIntakeCsvValue("no-es-un-numero")).toBe("");
  });
});

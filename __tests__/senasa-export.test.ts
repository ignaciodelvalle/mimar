// Tests for lib/analytics/senasa-export.ts — the PURE core of the SENASA
// export (transform + CSV formatter). No DB: the query stage lives in
// senasa-export-query.ts and is out of scope here.
//
// See dim-interno:docs/design/sdd/2026-07-07-senasa-lsucyf-batch-export.md.

import { describe, expect, it } from "vitest";

import {
  SENASA_CSV_COLUMNS,
  type SenasaEventRow,
  csvSenasaFormatter,
  resolveSenasaFormatter,
  toSenasaCanonicalRow,
  toSenasaCanonicalRows,
} from "@/lib/analytics/senasa-export";

const baseRow: SenasaEventRow = {
  animalToken: "DIM-AAAA-BBBB",
  species: "dog",
  jurisdictionProvince: "Ciudad Autónoma de Buenos Aires",
  jurisdictionLocality: "Palermo",
  occurredAt: new Date("2026-06-15T13:45:00.000Z"),
  tipoEventoCode: "vacunacion_antirrabica",
  loteBiologico: "LOTE-42",
  laboratorio: "Biogénesis",
  vencimientoBiologico: "2027-06-01",
  viaAplicacionCode: "sc",
  vetMatricula: "MP-1234",
  vetJurisdiccionCode: "AR-C",
  establecimientoRenspa: "01.234.5.67890/1",
  proximaDosisAt: "2027-06-15",
};

describe("toSenasaCanonicalRow — transform + vocab resolution", () => {
  it("resolves tipo_evento + via labels from sanitary-vocab", () => {
    const row = toSenasaCanonicalRow(baseRow);
    expect(row.tipo_evento_code).toBe("vacunacion_antirrabica");
    expect(row.tipo_evento_label).toBe("Vacunación antirrábica");
    expect(row.tipo_evento_norma).toContain("Ley 22.953");
    expect(row.via_aplicacion_label).toBe("Subcutánea");
  });

  it("reduces occurred_at to a date-only string (no time, no precise location)", () => {
    const row = toSenasaCanonicalRow(baseRow);
    expect(row.occurred_on).toBe("2026-06-15");
  });

  it("is a privacy allowlist — no owner/DNI/location fields can appear", () => {
    const row = toSenasaCanonicalRow(baseRow) as Record<string, unknown>;
    for (const forbidden of [
      "owner",
      "owner_id",
      "dni",
      "dni_hash",
      "recorded_by",
      "location_lat",
      "location_lng",
      "notes",
    ]) {
      expect(row[forbidden]).toBeUndefined();
    }
  });

  it("passes through nulls without inventing values", () => {
    const row = toSenasaCanonicalRow({
      ...baseRow,
      loteBiologico: null,
      viaAplicacionCode: null,
      vetMatricula: null,
      proximaDosisAt: null,
    });
    expect(row.lote_biologico).toBeNull();
    expect(row.via_aplicacion_code).toBeNull();
    expect(row.via_aplicacion_label).toBeNull();
    expect(row.vet_matricula).toBeNull();
    expect(row.proxima_dosis_on).toBeNull();
  });

  it("returns null labels for an unknown tipo_evento_code (no throw)", () => {
    const row = toSenasaCanonicalRow({ ...baseRow, tipoEventoCode: "not_a_real_code" });
    expect(row.tipo_evento_label).toBeNull();
    expect(row.tipo_evento_norma).toBeNull();
  });
});

describe("csvSenasaFormatter — CSV baseline", () => {
  it("emits the stable column header in the documented order", () => {
    const csv = csvSenasaFormatter.format(toSenasaCanonicalRows([baseRow]));
    const firstLine = csv.replace(/^﻿/, "").split("\r\n")[0];
    expect(firstLine).toBe(SENASA_CSV_COLUMNS.join(","));
  });

  it("prepends a UTF-8 BOM for Excel", () => {
    const csv = csvSenasaFormatter.format(toSenasaCanonicalRows([baseRow]));
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it("emits a header-only file for an empty batch (still valid)", () => {
    const csv = csvSenasaFormatter.format([]);
    const withoutBom = csv.replace(/^﻿/, "");
    expect(withoutBom).toBe(SENASA_CSV_COLUMNS.join(","));
  });

  it("escapes cells containing commas per RFC 4180", () => {
    const csv = csvSenasaFormatter.format(
      toSenasaCanonicalRows([{ ...baseRow, laboratorio: "Lab, S.A." }]),
    );
    expect(csv).toContain('"Lab, S.A."');
  });
});

describe("resolveSenasaFormatter", () => {
  it("returns the csv formatter by id", () => {
    expect(resolveSenasaFormatter("csv").id).toBe("csv");
  });

  it("falls back to csv for unknown / missing ids (no real SENASA formatter yet)", () => {
    expect(resolveSenasaFormatter("senasa_xml").id).toBe("csv");
    expect(resolveSenasaFormatter(null).id).toBe("csv");
    expect(resolveSenasaFormatter(undefined).id).toBe("csv");
  });
});

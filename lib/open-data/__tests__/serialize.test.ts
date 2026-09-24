// Unit tests for lib/open-data/serialize.ts — pure, no DB.

import { describe, expect, it } from "vitest";

import { type BuiltDataset, OPEN_DATA_LICENSE } from "../datasets";
import { datasetToCsv, datasetToJson, parseFormat } from "../serialize";

const built: BuiltDataset = {
  meta: {
    id: "cobertura-antirrabica",
    title: "Cobertura de vacunación antirrábica",
    summary: "Porcentaje de perros con vacuna antirrábica vigente por provincia.",
    unit: "Una fila por provincia.",
    cadence: "Actualización diaria.",
    license: OPEN_DATA_LICENSE,
    methodologyUrl: "https://www.mimar.gob.ar/transparencia#metodologia",
    dictionaryUrl: "https://www.mimar.gob.ar/transparencia#diccionario",
    generatedAt: "2026-07-15T00:00:00.000Z",
    suppression: { k: 5, marker: "suprimido por privacidad", rule: "regla" },
    columns: [
      { name: "provincia", description: "Nombre." },
      { name: "codigo_iso", description: "ISO." },
      { name: "perros_registrados", description: "Base." },
      { name: "cobertura_antirrabica_pct", description: "Pct." },
    ],
    rowCount: 2,
    suppressedCount: 1,
  },
  rows: [
    {
      provincia: "Córdoba",
      codigo_iso: "AR-X",
      perros_registrados: 9000,
      cobertura_antirrabica_pct: 71.2,
    },
    {
      provincia: "Tierra del Fuego",
      codigo_iso: "AR-V",
      perros_registrados: "suprimido por privacidad",
      cobertura_antirrabica_pct: "suprimido por privacidad",
    },
  ],
};

describe("parseFormat", () => {
  it("returns csv only for the exact 'csv' value", () => {
    expect(parseFormat("csv")).toBe("csv");
  });
  it("defaults to json for anything else", () => {
    expect(parseFormat("json")).toBe("json");
    expect(parseFormat(null)).toBe("json");
    expect(parseFormat("xml")).toBe("json");
    expect(parseFormat(undefined)).toBe("json");
  });
});

describe("datasetToCsv", () => {
  const csv = datasetToCsv(built);

  it("starts with a UTF-8 BOM", () => {
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it("embeds license, methodology and suppression metadata in the preamble", () => {
    expect(csv).toContain("# licencia: Creative Commons Atribución 4.0");
    expect(csv).toContain("# metodologia: https://www.mimar.gob.ar/transparencia#metodologia");
    expect(csv).toContain("# supresion: k=5");
    expect(csv).toContain("# generado: 2026-07-15T00:00:00.000Z");
  });

  it("emits the header row and data with the suppression marker verbatim (never 0)", () => {
    expect(csv).toContain("provincia,codigo_iso,perros_registrados,cobertura_antirrabica_pct");
    expect(csv).toContain("Córdoba,AR-X,9000,71.2");
  });

  it("always quotes the suppression-marker cell, even though it contains no comma/quote/newline", () => {
    // The marker is a privacy signal, not ordinary data — it must stay
    // mechanically distinct from a real value in the exported CSV. Both
    // numeric columns of the suppressed row carry the marker, both quoted.
    expect(csv).toContain(
      'Tierra del Fuego,AR-V,"suprimido por privacidad","suprimido por privacidad"',
    );
    // And NOT the unquoted form.
    expect(csv).not.toContain(
      "Tierra del Fuego,AR-V,suprimido por privacidad,suprimido por privacidad",
    );
  });
});

describe("datasetToJson", () => {
  it("wraps { meta, data } with the metadata and rows intact", () => {
    const parsed = JSON.parse(datasetToJson(built));
    expect(parsed.meta.id).toBe("cobertura-antirrabica");
    expect(parsed.meta.license.id).toBe("CC-BY-4.0");
    expect(parsed.meta.suppression.k).toBe(5);
    expect(parsed.data).toHaveLength(2);
    expect(parsed.data[1].perros_registrados).toBe("suprimido por privacidad");
  });
});

// Tests for lib/ui/csv-export.ts — the shared operator CSV builder (Q1).
// Pins the RFC 4180 escaping, the CRLF join, the context-block position
// (ABOVE the header) and the page-disclosure honesty line.

import { describe, expect, it } from "vitest";

import { buildOperatorCsv, csvField, csvPageDisclosure } from "./csv-export";

describe("csvField", () => {
  it("passes plain values through untouched", () => {
    expect(csvField("Perro")).toBe("Perro");
  });

  it("quotes fields containing commas", () => {
    expect(csvField("La Plata, Buenos Aires")).toBe('"La Plata, Buenos Aires"');
  });

  it("doubles embedded quotes and wraps", () => {
    expect(csvField('dijo "hola"')).toBe('"dijo ""hola"""');
  });

  it("quotes fields containing newlines", () => {
    expect(csvField("línea 1\nlínea 2")).toBe('"línea 1\nlínea 2"');
  });
});

describe("buildOperatorCsv", () => {
  it("emits header + rows joined with CRLF", () => {
    const csv = buildOperatorCsv({
      columns: ["Código", "Estado"],
      rows: [
        ["CAS-0001", "Abierto"],
        ["CAS-0002", "Cerrado"],
      ],
    });
    expect(csv).toBe("Código,Estado\r\nCAS-0001,Abierto\r\nCAS-0002,Cerrado");
  });

  it("prepends context lines ABOVE the column header, prefixing '#' when absent", () => {
    const csv = buildOperatorCsv({
      columns: ["Código"],
      rows: [["CAS-0001"]],
      contextLines: ["miMAR · casos — cobertura completa", "# ya prefijada"],
    });
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("# miMAR · casos — cobertura completa");
    expect(lines[1]).toBe("# ya prefijada");
    expect(lines[2]).toBe("Código");
  });

  it("escapes header cells and row cells alike", () => {
    const csv = buildOperatorCsv({
      columns: ["Jurisdicción, provincia"],
      rows: [["CABA, Palermo"]],
    });
    expect(csv).toBe('"Jurisdicción, provincia"\r\n"CABA, Palermo"');
  });

  it("emits only the header when there are no rows", () => {
    expect(buildOperatorCsv({ columns: ["A", "B"], rows: [] })).toBe("A,B");
  });
});

describe("csvPageDisclosure", () => {
  it("returns null when the export covers the whole set", () => {
    expect(csvPageDisclosure(12, 12)).toBeNull();
    expect(csvPageDisclosure(12, 5)).toBeNull();
  });

  it("declares the page when the total exceeds the shown rows", () => {
    const line = csvPageDisclosure(50, 1234);
    expect(line).toContain("50");
    expect(line).toContain("1.234");
    expect(line?.startsWith("#")).toBe(true);
  });
});

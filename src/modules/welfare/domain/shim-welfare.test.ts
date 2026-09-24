// Approval test: verifies that after shimming lib/welfare.ts the domain
// module exports the SAME values as the original lib/welfare.ts did.
// This test imports directly from the DOMAIN module — it's the source of truth.
// The shim itself is tested by TypeScript typecheck (tsc --noEmit).

import { describe, expect, it } from "vitest";

import {
  WELFARE_REPORT_KINDS,
  WELFARE_REPORT_SEVERITIES,
  WELFARE_REPORT_STATUSES,
  WELFARE_REPORT_SUBJECT_KINDS,
  welfareReportKindLabel,
  welfareReportSeverityLabel,
  welfareReportStatusLabel,
  welfareReportSubjectKindLabel,
} from "./types";

describe("lib/welfare.ts shim — domain exports are identical to original values", () => {
  it("WELFARE_REPORT_KINDS matches original 9-element array", () => {
    expect(WELFARE_REPORT_KINDS).toEqual([
      "abandonment",
      "neglect",
      "physical_abuse",
      "chained",
      "no_shelter",
      "hoarding",
      "dog_fighting",
      "trafficking",
      "other",
    ]);
  });

  it("WELFARE_REPORT_SEVERITIES matches original 4-element array", () => {
    expect(WELFARE_REPORT_SEVERITIES).toEqual(["low", "medium", "high", "critical"]);
  });

  it("WELFARE_REPORT_STATUSES matches original 6-element array", () => {
    expect(WELFARE_REPORT_STATUSES).toEqual([
      "open",
      "triaged",
      "in_progress",
      "closed",
      "duplicate",
      "invalid",
    ]);
  });

  it("WELFARE_REPORT_SUBJECT_KINDS matches original 4-element array", () => {
    expect(WELFARE_REPORT_SUBJECT_KINDS).toEqual([
      "registered_pet",
      "unowned_animal",
      "location",
      "general",
    ]);
  });

  it("welfareReportKindLabel produces the same output as original", () => {
    expect(welfareReportKindLabel("abandonment")).toBe("Abandono");
    expect(welfareReportKindLabel("neglect")).toBe("Negligencia (sin agua/comida/refugio)");
    expect(welfareReportKindLabel("physical_abuse")).toBe("Maltrato físico / golpes / lesiones");
    expect(welfareReportKindLabel("chained")).toBe("Animal encadenado o sin movilidad");
    expect(welfareReportKindLabel("no_shelter")).toBe("Sin refugio del clima");
    expect(welfareReportKindLabel("hoarding")).toBe("Acumulación de animales");
    expect(welfareReportKindLabel("dog_fighting")).toBe("Peleas de perros");
    expect(welfareReportKindLabel("trafficking")).toBe("Tráfico / venta clandestina");
    expect(welfareReportKindLabel("other")).toBe("Otra");
    expect(welfareReportKindLabel("unknown")).toBe("unknown");
  });

  it("welfareReportSeverityLabel produces the same output as original", () => {
    expect(welfareReportSeverityLabel("low")).toBe("Baja — preocupante, no urgente");
    expect(welfareReportSeverityLabel("medium")).toBe("Media — requiere intervención pronto");
    expect(welfareReportSeverityLabel("high")).toBe("Alta — urgente");
    expect(welfareReportSeverityLabel("critical")).toBe("Crítica — peligro inmediato");
    expect(welfareReportSeverityLabel("unknown")).toBe("unknown");
  });

  it("welfareReportStatusLabel produces the same output as original", () => {
    expect(welfareReportStatusLabel("open")).toBe("Abierta");
    expect(welfareReportStatusLabel("triaged")).toBe("Revisada");
    expect(welfareReportStatusLabel("in_progress")).toBe("En curso");
    expect(welfareReportStatusLabel("closed")).toBe("Cerrada");
    expect(welfareReportStatusLabel("duplicate")).toBe("Duplicada");
    expect(welfareReportStatusLabel("invalid")).toBe("Sin sustento");
    expect(welfareReportStatusLabel("unknown")).toBe("unknown");
  });

  it("welfareReportSubjectKindLabel produces the same output as original", () => {
    expect(welfareReportSubjectKindLabel("registered_pet")).toBe("Mascota miMAR registrada");
    expect(welfareReportSubjectKindLabel("unowned_animal")).toBe("Animal sin dueño identificado");
    expect(welfareReportSubjectKindLabel("location")).toBe("Lugar / situación");
    expect(welfareReportSubjectKindLabel("general")).toBe("Otro");
    expect(welfareReportSubjectKindLabel("unknown")).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// lib/welfare-codes.ts shim approval
// ---------------------------------------------------------------------------

import {
  generateReferenceCode,
  isValidReferenceCodeFormat,
  normalizeReferenceCode,
} from "./reference-code";

describe("lib/welfare-codes.ts shim — domain exports identical to original", () => {
  it("generateReferenceCode produces DEN-XXXX-XXXX format", () => {
    const code = generateReferenceCode();
    expect(code).toMatch(/^DEN-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  });

  it("normalizeReferenceCode uppercases and trims", () => {
    expect(normalizeReferenceCode("  den-abcd-efgh  ")).toBe("DEN-ABCD-EFGH");
  });

  it("isValidReferenceCodeFormat accepts valid codes", () => {
    expect(isValidReferenceCodeFormat("DEN-ABCD-EFGH")).toBe(true);
    expect(isValidReferenceCodeFormat("den-abcd-efgh")).toBe(false); // lowercase invalid
  });
});

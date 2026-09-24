// Unit tests for welfare domain types.
// These verify that all enum arrays, derived types, and label functions
// are exported with the correct values. The label functions contain
// real branching logic — triangulation required.

import { describe, expect, it } from "vitest";

import {
  FLAG_REASONS,
  type FlagReason,
  WELFARE_REPORT_KINDS,
  WELFARE_REPORT_SEVERITIES,
  WELFARE_REPORT_STATUSES,
  WELFARE_REPORT_SUBJECT_KINDS,
  type WelfareReportKind,
  type WelfareReportSeverity,
  type WelfareReportStatus,
  type WelfareReportSubjectKind,
  welfareAssignmentLabel,
  welfareReportKindLabel,
  welfareReportSeverityLabel,
  welfareReportStatusLabel,
  welfareReportSubjectKindLabel,
} from "./types";

// ---------------------------------------------------------------------------
// WELFARE_REPORT_KINDS
// ---------------------------------------------------------------------------

describe("WELFARE_REPORT_KINDS", () => {
  it("contains all expected kind values", () => {
    expect(WELFARE_REPORT_KINDS).toContain("abandonment");
    expect(WELFARE_REPORT_KINDS).toContain("neglect");
    expect(WELFARE_REPORT_KINDS).toContain("physical_abuse");
    expect(WELFARE_REPORT_KINDS).toContain("chained");
    expect(WELFARE_REPORT_KINDS).toContain("no_shelter");
    expect(WELFARE_REPORT_KINDS).toContain("hoarding");
    expect(WELFARE_REPORT_KINDS).toContain("dog_fighting");
    expect(WELFARE_REPORT_KINDS).toContain("trafficking");
    expect(WELFARE_REPORT_KINDS).toContain("other");
  });

  it("has exactly 9 values", () => {
    expect(WELFARE_REPORT_KINDS).toHaveLength(9);
  });
});

// ---------------------------------------------------------------------------
// welfareReportKindLabel
// ---------------------------------------------------------------------------

describe("welfareReportKindLabel", () => {
  it("returns Spanish label for abandonment", () => {
    expect(welfareReportKindLabel("abandonment")).toBe("Abandono");
  });

  it("returns Spanish label for physical_abuse", () => {
    expect(welfareReportKindLabel("physical_abuse")).toBe("Maltrato físico / golpes / lesiones");
  });

  it("returns Spanish label for dog_fighting", () => {
    expect(welfareReportKindLabel("dog_fighting")).toBe("Peleas de perros");
  });

  it("returns the raw value for unknown kinds (identity fallback)", () => {
    expect(welfareReportKindLabel("unknown_kind")).toBe("unknown_kind");
  });
});

// ---------------------------------------------------------------------------
// WELFARE_REPORT_SEVERITIES
// ---------------------------------------------------------------------------

describe("WELFARE_REPORT_SEVERITIES", () => {
  it("contains all four severity levels", () => {
    expect(WELFARE_REPORT_SEVERITIES).toContain("low");
    expect(WELFARE_REPORT_SEVERITIES).toContain("medium");
    expect(WELFARE_REPORT_SEVERITIES).toContain("high");
    expect(WELFARE_REPORT_SEVERITIES).toContain("critical");
  });

  it("has exactly 4 values", () => {
    expect(WELFARE_REPORT_SEVERITIES).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// welfareReportSeverityLabel
// ---------------------------------------------------------------------------

describe("welfareReportSeverityLabel", () => {
  it("returns urgency label for critical", () => {
    expect(welfareReportSeverityLabel("critical")).toBe("Crítica — peligro inmediato");
  });

  it("returns urgency label for low", () => {
    expect(welfareReportSeverityLabel("low")).toBe("Baja — preocupante, no urgente");
  });

  it("returns raw value for unknown severities", () => {
    expect(welfareReportSeverityLabel("extreme")).toBe("extreme");
  });
});

// ---------------------------------------------------------------------------
// WELFARE_REPORT_STATUSES
// ---------------------------------------------------------------------------

describe("WELFARE_REPORT_STATUSES", () => {
  it("contains all six statuses", () => {
    expect(WELFARE_REPORT_STATUSES).toContain("open");
    expect(WELFARE_REPORT_STATUSES).toContain("triaged");
    expect(WELFARE_REPORT_STATUSES).toContain("in_progress");
    expect(WELFARE_REPORT_STATUSES).toContain("closed");
    expect(WELFARE_REPORT_STATUSES).toContain("duplicate");
    expect(WELFARE_REPORT_STATUSES).toContain("invalid");
  });

  it("has exactly 6 values", () => {
    expect(WELFARE_REPORT_STATUSES).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// welfareReportStatusLabel
// ---------------------------------------------------------------------------

describe("welfareReportStatusLabel", () => {
  it("returns 'Abierta' for open", () => {
    expect(welfareReportStatusLabel("open")).toBe("Abierta");
  });

  it("returns 'En curso' for in_progress", () => {
    expect(welfareReportStatusLabel("in_progress")).toBe("En curso");
  });

  it("returns 'Sin sustento' for invalid", () => {
    expect(welfareReportStatusLabel("invalid")).toBe("Sin sustento");
  });

  it("returns raw value for unknown statuses", () => {
    expect(welfareReportStatusLabel("archived")).toBe("archived");
  });
});

// ---------------------------------------------------------------------------
// WELFARE_REPORT_SUBJECT_KINDS
// ---------------------------------------------------------------------------

describe("WELFARE_REPORT_SUBJECT_KINDS", () => {
  it("contains all four subject kinds", () => {
    expect(WELFARE_REPORT_SUBJECT_KINDS).toContain("registered_pet");
    expect(WELFARE_REPORT_SUBJECT_KINDS).toContain("unowned_animal");
    expect(WELFARE_REPORT_SUBJECT_KINDS).toContain("location");
    expect(WELFARE_REPORT_SUBJECT_KINDS).toContain("general");
  });
});

// ---------------------------------------------------------------------------
// welfareReportSubjectKindLabel
// ---------------------------------------------------------------------------

describe("welfareReportSubjectKindLabel", () => {
  it("returns correct label for registered_pet", () => {
    expect(welfareReportSubjectKindLabel("registered_pet")).toBe("Mascota miMAR registrada");
  });

  it("returns correct label for location", () => {
    expect(welfareReportSubjectKindLabel("location")).toBe("Lugar / situación");
  });

  it("returns raw value for unknown subject kinds", () => {
    expect(welfareReportSubjectKindLabel("organization")).toBe("organization");
  });
});

// ---------------------------------------------------------------------------
// FLAG_REASONS
// ---------------------------------------------------------------------------

describe("FLAG_REASONS", () => {
  it("contains all moderation reason codes", () => {
    expect(FLAG_REASONS).toContain("trivial_description");
    expect(FLAG_REASONS).toContain("critical_without_evidence");
    expect(FLAG_REASONS).toContain("duplicate_within_24h");
    expect(FLAG_REASONS).toContain("bot_suspected_dwell_time");
    expect(FLAG_REASONS).toContain("bot_suspected_honeypot");
  });

  it("has exactly 5 reason codes", () => {
    expect(FLAG_REASONS).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// welfareAssignmentLabel (G0b — derived case must not read as unowned)
// ---------------------------------------------------------------------------

describe("welfareAssignmentLabel", () => {
  it("shows the named operator when assigned (assignment wins over derivation)", () => {
    expect(welfareAssignmentLabel("Ana Gómez", "Mascotas BA Centro")).toBe("Ana Gómez");
  });

  it("shows 'Derivada a {org}' when derived but not assigned to an operator", () => {
    expect(welfareAssignmentLabel(null, "Mascotas BA Centro")).toBe(
      "Derivada a Mascotas BA Centro",
    );
  });

  it("shows 'Sin asignar' only when neither assigned nor derived", () => {
    expect(welfareAssignmentLabel(null, null)).toBe("Sin asignar");
    expect(welfareAssignmentLabel(undefined, undefined)).toBe("Sin asignar");
  });
});

// ---------------------------------------------------------------------------
// Type-level compile checks (TypeScript ensures these; Vitest verifies runtime)
// ---------------------------------------------------------------------------

describe("type assignments compile and resolve at runtime", () => {
  it("WelfareReportKind values are assignable to string", () => {
    const k: WelfareReportKind = "abandonment";
    expect(typeof k).toBe("string");
  });

  it("WelfareReportSeverity values are assignable to string", () => {
    const s: WelfareReportSeverity = "critical";
    expect(typeof s).toBe("string");
  });

  it("WelfareReportStatus values are assignable to string", () => {
    const st: WelfareReportStatus = "open";
    expect(typeof st).toBe("string");
  });

  it("WelfareReportSubjectKind values are assignable to string", () => {
    const sk: WelfareReportSubjectKind = "registered_pet";
    expect(typeof sk).toBe("string");
  });

  it("FlagReason values are assignable to string", () => {
    const fr: FlagReason = "trivial_description";
    expect(typeof fr).toBe("string");
  });
});

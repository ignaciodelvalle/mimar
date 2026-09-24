// "Ver mis datos" (Ley 25.326 art. 14) presenter — the module that turns the
// RPC's raw snake_case keys into what a citizen reads. See the module header
// for the full PO decision 13A rationale; this file pins the behaviour.

import { describe, expect, it } from "vitest";

import {
  SUBJECT_RIGHTS_FALLBACK_LABEL,
  SUBJECT_RIGHTS_SECTION_LABELS,
  describeProfileFields,
  formatSubjectRightsDate,
  subjectRightsSections,
  summarizeSubjectRightsValue,
} from "../subject-rights-sections.ts";

describe("subjectRightsSections", () => {
  it("gives a known key its human Spanish label instead of the raw name", () => {
    const sections = subjectRightsSections({ pets: [{}], push_targets: [{}] });

    expect(sections.find((s) => s.key === "pets")?.label).toBe("Tus mascotas");
    expect(sections.find((s) => s.key === "push_targets")?.label).toBe(
      "Avisos activados (celular)",
    );
  });

  it("falls back to a generic label for a key it has never heard of, without dropping it", () => {
    const sections = subjectRightsSections({ una_tabla_nueva: [{}, {}] });

    expect(sections).toEqual([
      { key: "una_tabla_nueva", label: SUBJECT_RIGHTS_FALLBACK_LABEL, summary: "2 registros" },
    ]);
  });

  it("hides pure-bookkeeping sections even when they have content", () => {
    const sections = subjectRightsSections({
      operator_feed_watermarks: [{ surface: "novedades" }],
      user_surface_visits: [{ surface: "onboarding" }],
      pets: [{}],
    });

    expect(sections.map((s) => s.key)).toEqual(["pets"]);
  });

  it("hides envelope metadata about the export itself, not just schema_version", () => {
    const sections = subjectRightsSections({
      schema_version: 5,
      exported_at: "2026-09-23T00:00:00Z",
      exported_under: "Ley 25.326 art. 14",
      subject_user_id: "11111111-1111-1111-1111-111111111111",
      pets: [{}],
    });

    expect(sections.map((s) => s.key)).toEqual(["pets"]);
  });

  it("keeps a technical-but-meaningful section visible with a plain label", () => {
    // PO decision 13A: audit_log is content a person should know about (their
    // own action history), not internal bookkeeping — it must NOT be hidden.
    const sections = subjectRightsSections({ audit_log: [{ action: "subject_data_exported" }] });

    expect(sections).toEqual([
      { key: "audit_log", label: "Historial de tus acciones", summary: "1 registro" },
    ]);
  });

  it("hides an empty section regardless of whether the key is known", () => {
    const sections = subjectRightsSections({
      pets: [],
      welfare_reports_filed: null,
      una_tabla_nueva: undefined,
    });

    expect(sections).toEqual([]);
  });

  it("keeps the RPC's own key order rather than sorting", () => {
    const sections = subjectRightsSections({ notifications: [{}], pets: [{}], audit_log: [{}] });

    expect(sections.map((s) => s.key)).toEqual(["notifications", "pets", "audit_log"]);
  });

  it("every SECTION_LABELS entry has a non-empty Spanish label", () => {
    for (const [key, meta] of Object.entries(SUBJECT_RIGHTS_SECTION_LABELS)) {
      expect(meta.label, `label for "${key}"`).toBeTruthy();
      // Non-vacuity: the fallback label itself must never be used as a
      // "known" entry's label — that would defeat the point of the table.
      expect(meta.label).not.toBe(SUBJECT_RIGHTS_FALLBACK_LABEL);
    }
  });
});

describe("summarizeSubjectRightsValue", () => {
  it("says sin datos for empty/null/undefined, never 0", () => {
    expect(summarizeSubjectRightsValue([])).toBe("sin datos");
    expect(summarizeSubjectRightsValue(null)).toBe("sin datos");
    expect(summarizeSubjectRightsValue(undefined)).toBe("sin datos");
  });

  it("counts array rows, singular vs. plural", () => {
    expect(summarizeSubjectRightsValue([{}])).toBe("1 registro");
    expect(summarizeSubjectRightsValue([{}, {}])).toBe("2 registros");
  });

  it("counts an object's own fields", () => {
    expect(summarizeSubjectRightsValue({ a: 1, b: 2 })).toBe("2 campos");
  });

  it("reports a scalar as present without printing it", () => {
    expect(summarizeSubjectRightsValue("4821")).toBe("presente");
  });
});

describe("describeProfileFields", () => {
  it("renders whitelisted fields with human labels", () => {
    const rows = describeProfileFields({ display_name: "Ana Pérez", phone: "1122334455" });

    expect(rows).toEqual([
      { key: "display_name", label: "Nombre", value: "Ana Pérez" },
      { key: "phone", label: "Teléfono", value: "1122334455" },
    ]);
  });

  it("never renders dni_hash or any other column outside the whitelist", () => {
    const rows = describeProfileFields({
      dni_hash: "sha256:deadbeef",
      dni_last4: "4821",
      miarg_sub: "opaque-sub",
      id: "11111111-1111-1111-1111-111111111111",
    });

    expect(rows).toEqual([{ key: "dni_last4", label: "DNI (últimos 4 dígitos)", value: "4821" }]);
    expect(JSON.stringify(rows)).not.toContain("deadbeef");
    expect(JSON.stringify(rows)).not.toContain("opaque-sub");
  });

  it("formats dates in es-AR and skips empty fields", () => {
    const rows = describeProfileFields({
      created_at: "2026-01-15T12:00:00.000Z",
      preferred_vet_name: null,
      emergency_contact_name: "",
    });

    expect(rows).toEqual([{ key: "created_at", label: "Cuenta creada", value: "15/01/2026" }]);
  });

  it("renders a boolean field as Sí/No", () => {
    expect(describeProfileFields({ dni_verified: true })).toEqual([
      { key: "dni_verified", label: "DNI verificado", value: "Sí" },
    ]);
    expect(describeProfileFields({ dni_verified: false })).toEqual([
      { key: "dni_verified", label: "DNI verificado", value: "No" },
    ]);
  });

  it("returns nothing for a null/undefined profile", () => {
    expect(describeProfileFields(null)).toEqual([]);
    expect(describeProfileFields(undefined)).toEqual([]);
  });
});

describe("formatSubjectRightsDate", () => {
  it("formats an ISO timestamp as es-AR DD/MM/AAAA", () => {
    expect(formatSubjectRightsDate("2026-01-15T12:00:00.000Z")).toBe("15/01/2026");
  });

  it("returns an em dash for missing or invalid input", () => {
    expect(formatSubjectRightsDate(null)).toBe("—");
    expect(formatSubjectRightsDate(undefined)).toBe("—");
    expect(formatSubjectRightsDate("not-a-date")).toBe("—");
  });
});

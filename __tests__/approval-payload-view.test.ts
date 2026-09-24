// Unit tests for lib/approval-payload-view.ts
//
// Pure helper — no DB, no imports that hit server-only. Tests run in the
// vitest browser or node pool without any special setup.

import { describe, expect, it } from "vitest";

import { buildPayloadRows } from "@/lib/infra/approval-payload-view";

describe("buildPayloadRows", () => {
  // ─── Guard: malformed inputs ────────────────────────────────────────────────

  it("returns [] for null payload", () => {
    expect(buildPayloadRows("role_upgrade_vet", null)).toEqual([]);
  });

  it("returns [] for undefined payload", () => {
    expect(buildPayloadRows("role_upgrade_vet", undefined)).toEqual([]);
  });

  it("returns [] for array payload", () => {
    expect(buildPayloadRows("role_upgrade_vet", [1, 2, 3])).toEqual([]);
  });

  it("returns [] for string payload", () => {
    expect(buildPayloadRows("role_upgrade_vet", "garbage")).toEqual([]);
  });

  it("returns [] for empty object payload", () => {
    expect(buildPayloadRows("role_upgrade_vet", {})).toEqual([]);
  });

  it("returns [] for unknown type", () => {
    expect(buildPayloadRows("unknown_type", { matricula_number: "123" })).toEqual([]);
  });

  it("never returns raw JSON blob — output is label/value rows only", () => {
    const result = buildPayloadRows("role_upgrade_vet", {
      matricula_number: "MP-001",
      extra: { nested: "data" },
    });
    for (const row of result) {
      expect(typeof row.label).toBe("string");
      expect(typeof row.value).toBe("string");
      // value should NOT look like a JSON object/array
      expect(row.value).not.toMatch(/^\[|^\{/);
    }
  });

  // ─── role_upgrade_vet ───────────────────────────────────────────────────────

  it("returns matricula row for role_upgrade_vet with matricula_number", () => {
    const rows = buildPayloadRows("role_upgrade_vet", {
      matricula_number: "MP-12345",
      jurisdiccion: "Buenos Aires",
    });
    expect(rows).toEqual(
      expect.arrayContaining([
        { label: "N° de matrícula", value: "MP-12345" },
        { label: "Jurisdicción", value: "Buenos Aires" },
      ]),
    );
  });

  it("accepts camelCase matriculaNumber alias", () => {
    const rows = buildPayloadRows("role_upgrade_vet", { matriculaNumber: "MP-99" });
    expect(rows[0]).toEqual({ label: "N° de matrícula", value: "MP-99" });
  });

  it("omits blank / whitespace-only matricula", () => {
    const rows = buildPayloadRows("role_upgrade_vet", { matricula_number: "   " });
    expect(rows.find((r) => r.label === "N° de matrícula")).toBeUndefined();
  });

  it("includes evidence_url when present", () => {
    const rows = buildPayloadRows("role_upgrade_vet", {
      matricula_number: "MP-1",
      evidence_url: "https://example.com/doc.pdf",
    });
    expect(rows.find((r) => r.label === "Evidencia adjunta")).toBeDefined();
  });

  // ─── organization_verification ──────────────────────────────────────────────

  it("returns CUIT and legal_name for organization_verification", () => {
    const rows = buildPayloadRows("organization_verification", {
      cuit: "30-71234567-8",
      legal_name: "Protectora XYZ S.A.",
    });
    expect(rows).toEqual(
      expect.arrayContaining([
        { label: "CUIT", value: "30-71234567-8" },
        { label: "Razón social", value: "Protectora XYZ S.A." },
      ]),
    );
  });

  it("accepts legalName camelCase alias", () => {
    const rows = buildPayloadRows("organization_verification", { legalName: "Refugio Sur" });
    expect(rows.find((r) => r.label === "Razón social")?.value).toBe("Refugio Sur");
  });

  it("includes org_type when present", () => {
    const rows = buildPayloadRows("organization_verification", { org_type: "shelter" });
    expect(rows.find((r) => r.label === "Tipo de organización")?.value).toBe("shelter");
  });

  it("returns [] when org payload has no recognised fields", () => {
    const rows = buildPayloadRows("organization_verification", { unknown_field: "x" });
    expect(rows).toEqual([]);
  });

  // ─── service_dog_credential_verification ────────────────────────────────────

  it("returns notes row for service_dog with notes", () => {
    const rows = buildPayloadRows("service_dog_credential_verification", {
      notes: "Certificado vencido en 2025",
    });
    expect(rows).toEqual(
      expect.arrayContaining([
        { label: "Notas del solicitante", value: "Certificado vencido en 2025" },
      ]),
    );
  });

  it("returns [] for service_dog with empty payload", () => {
    const rows = buildPayloadRows("service_dog_credential_verification", {});
    expect(rows).toEqual([]);
  });

  it("returns [] for service_dog with only pet_id (already shown in context block)", () => {
    // pet_id is not a field we surface in the payload rows
    const rows = buildPayloadRows("service_dog_credential_verification", { pet_id: "some-uuid" });
    expect(rows).toEqual([]);
  });
});

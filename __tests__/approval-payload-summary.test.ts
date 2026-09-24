// PII guard: the govt approval-review surface must NEVER dump the raw request
// payload. Covers both the pure summarizer (allowlist projection) and a static
// guard that /gob/cola/[publicToken] no longer renders JSON.stringify / <pre>.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { summarizeApprovalPayload } from "@/lib/infra/approval-payload-summary";

describe("summarizeApprovalPayload", () => {
  it("projects only the curated fields for role_upgrade_vet", () => {
    const rows = summarizeApprovalPayload("role_upgrade_vet", {
      payload_version: 1,
      matricula_number: "MP-12345",
      matricula_jurisdiccion: "CABA",
      especialidad: "Cirugía",
      anos_experiencia: 8,
      // A hostile/unexpected key must be dropped, never rendered.
      secret_internal_note: "do-not-leak",
    });

    const labels = rows.map((r) => r.label);
    expect(labels).toEqual([
      "Matrícula",
      "Jurisdicción de matrícula",
      "Especialidad",
      "Años de experiencia",
    ]);
    // The unknown key never surfaces in any value.
    expect(rows.some((r) => r.value.includes("do-not-leak"))).toBe(false);
  });

  it("maps org_type to a friendly label and skips null fields", () => {
    const rows = summarizeApprovalPayload("organization_verification", {
      payload_version: 1,
      org_type: "clinic",
      cuit: null,
      personeria_juridica_number: null,
      additional_documents_summary: "Copia de estatuto",
    });

    expect(rows).toEqual([
      { label: "Tipo de organización", value: "Clínica veterinaria" },
      { label: "Documentación adicional", value: "Copia de estatuto" },
    ]);
  });

  it("returns an empty projection for types with no curated fields (never dumps payload)", () => {
    // service_dog_credential_verification is a real ApprovalRequestType with no
    // structured display fields — it must project to nothing, not a JSON dump.
    const rows = summarizeApprovalPayload("service_dog_credential_verification", {
      some: "value",
      nested: { deep: true },
    });
    expect(rows).toEqual([]);
  });

  it("never stringifies nested objects into a value", () => {
    const rows = summarizeApprovalPayload("role_upgrade_vet", {
      matricula_number: { evil: "object" },
    });
    // Object-valued field is dropped, not JSON-stringified.
    expect(rows).toEqual([]);
  });
});

describe("/gob/cola/[publicToken] PII guard", () => {
  it("does not render the raw payload (no JSON.stringify / <pre>)", () => {
    const source = readFileSync(
      join(process.cwd(), "app", "gob", "cola", "[publicToken]", "page.tsx"),
      "utf8",
    );
    expect(source).not.toContain("JSON.stringify");
    expect(source).not.toContain("<pre");
  });
});

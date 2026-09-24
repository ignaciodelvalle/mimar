import { describe, expect, it } from "vitest";

import {
  RUPGA_APPROVAL_WARNING,
  VET_MATRICULA_BULK_APPROVE_BLOCKED,
  selectionHasRupga,
  selectionHasVetMatricula,
} from "@/lib/infra/approval-queue-breakdown";

import { matriculaRegistryFor, normalizeJurisdictionName } from "../matricula-registries";
import {
  MATRICULA_VERIFICATION_CHECKLIST,
  MATRICULA_VERIFICATION_NOTE,
  composeMatriculaApprovalNotes,
} from "../matricula-verification";

describe("matriculaRegistryFor", () => {
  it("matches known jurisdictions across their common aliases and accents", () => {
    for (const alias of ["CABA", "Capital Federal", "Ciudad Autónoma de Buenos Aires"]) {
      const link = matriculaRegistryFor(alias);
      expect(link?.url).toBe("https://cpmv.org.ar/");
    }
    for (const alias of ["Buenos Aires", "provincia de buenos aires", "PBA"]) {
      const link = matriculaRegistryFor(alias);
      expect(link?.url).toBe("https://cvpba.org/");
    }
  });

  it("every listed registry is flagged consulta manual (no authoritative deep link exists)", () => {
    const link = matriculaRegistryFor("CABA");
    expect(link?.consultaManual).toBe(true);
  });

  it("returns null for unknown jurisdictions — never a guessed URL", () => {
    expect(matriculaRegistryFor("Chubut")).toBeNull();
    expect(matriculaRegistryFor("")).toBeNull();
    expect(matriculaRegistryFor(null)).toBeNull();
    expect(matriculaRegistryFor(undefined)).toBeNull();
  });

  it("normalizes case, accents and whitespace", () => {
    expect(normalizeJurisdictionName("  Ciudad  Autónoma de Buenos Aires ")).toBe(
      "ciudad autonoma de buenos aires",
    );
  });
});

describe("matrícula verification checklist", () => {
  it("has the three mandatory ticks: formato / registro / identidad", () => {
    expect(MATRICULA_VERIFICATION_CHECKLIST.map((c) => c.key)).toEqual([
      "formato",
      "registro",
      "identidad",
    ]);
    for (const item of MATRICULA_VERIFICATION_CHECKLIST) {
      expect(item.label.length).toBeGreaterThan(0);
    }
  });

  it("composes the structured note first, free notes below", () => {
    expect(composeMatriculaApprovalNotes("")).toBe(MATRICULA_VERIFICATION_NOTE);
    expect(composeMatriculaApprovalNotes("  ")).toBe(MATRICULA_VERIFICATION_NOTE);
    expect(composeMatriculaApprovalNotes("Todo en orden.")).toBe(
      `${MATRICULA_VERIFICATION_NOTE}\nTodo en orden.`,
    );
  });
});

describe("bulk-approve allowlist (approval-queue-breakdown)", () => {
  it("a selection containing a vet matrícula blocks bulk approve", () => {
    expect(selectionHasVetMatricula(["role_upgrade_vet"])).toBe(true);
    expect(selectionHasVetMatricula(["organization_verification", "role_upgrade_vet"])).toBe(true);
  });

  it("selections without matrículas keep bulk approve available", () => {
    expect(selectionHasVetMatricula([])).toBe(false);
    expect(
      selectionHasVetMatricula([
        "organization_verification",
        "service_dog_credential_verification",
      ]),
    ).toBe(false);
  });

  it("the block message names the individual-verification requirement", () => {
    expect(VET_MATRICULA_BULK_APPROVE_BLOCKED).toMatch(/una por una/);
    // RUPGA keeps its own (non-blocking) warning — distinct copy.
    expect(VET_MATRICULA_BULK_APPROVE_BLOCKED).not.toBe(RUPGA_APPROVAL_WARNING);
  });

  it("rupga detection is unchanged by the vet exclusion", () => {
    expect(selectionHasRupga(["service_dog_credential_verification"])).toBe(true);
    expect(selectionHasRupga(["role_upgrade_vet"])).toBe(false);
  });
});

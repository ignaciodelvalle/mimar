// Permissions matrix columns by org type (portal-vet-p0 D13): a refugio keeps
// all sixteen, a clinic loses the six custody-rehoming ones.

import { describe, expect, it } from "vitest";

import { ORGANIZATION_CAPABILITIES } from "@/db/schema";
import { SHELTER_ONLY_CAPABILITIES } from "@/src/modules/organizations/domain/capabilities";

import { matrixColumnsFor } from "./matrix-columns";

describe("matrixColumnsFor", () => {
  it("keeps every column, in schema order, for a shelter and a rescue network (regression)", () => {
    for (const orgType of ["shelter", "rescue_network"]) {
      const columns = matrixColumnsFor(orgType);
      expect(columns, orgType).toHaveLength(16);
      expect(columns.map((c) => c.capability)).toEqual([...ORGANIZATION_CAPABILITIES]);
    }
  });

  it("drops exactly the shelter-only columns for a clinic", () => {
    const capabilities = matrixColumnsFor("clinic").map((c) => c.capability);
    expect(capabilities).toHaveLength(16 - SHELTER_ONLY_CAPABILITIES.size);
    expect(capabilities).toEqual(
      ORGANIZATION_CAPABILITIES.filter((cap) => !SHELTER_ONLY_CAPABILITIES.has(cap)),
    );
    expect(capabilities).toContain("event.write");
    expect(capabilities).toContain("appointment.manage");
  });

  it("labels every column in Spanish, including the two outside the catalog", () => {
    const labels = new Map(matrixColumnsFor("shelter").map((c) => [c.capability, c.label]));
    expect(labels.get("event.write")).toBe("Registrar eventos clínicos");
    expect(labels.get("org.transfer.propose")).toBe("Proponer transferencia");
    expect(labels.get("org.transfer.accept")).toBe("Aceptar transferencia");
  });
});

// The ONE settable-role list (portal-vet-p0 D13): the invite page and the role
// selector read it. A clinic never offers coordinator or volunteer; a refugio's
// lists are exactly what they were.

import { describe, expect, it } from "vitest";

import { getSettableRoles } from "./member-management";

describe("getSettableRoles", () => {
  it("offers a shelter admin every invitable role, labels and order unchanged (regression)", () => {
    for (const orgType of ["shelter", "rescue_network"]) {
      expect(getSettableRoles("admin", orgType), orgType).toEqual([
        { value: "admin", label: "Administrador" },
        { value: "coordinator", label: "Coordinador" },
        { value: "member", label: "Miembro" },
        { value: "volunteer", label: "Voluntario" },
        { value: "vet_individual", label: "Veterinario" },
      ]);
    }
  });

  it("stays bounded by the actor's rank in a shelter", () => {
    expect(getSettableRoles("coordinator", "shelter").map((r) => r.value)).toEqual([
      "coordinator",
      "member",
      "volunteer",
      "vet_individual",
    ]);
  });

  it("never offers coordinator or volunteer in a clinic", () => {
    expect(getSettableRoles("admin", "clinic").map((r) => r.value)).toEqual([
      "admin",
      "member",
      "vet_individual",
    ]);
    expect(getSettableRoles("member", "clinic").map((r) => r.value)).toEqual([
      "member",
      "vet_individual",
    ]);
  });
});

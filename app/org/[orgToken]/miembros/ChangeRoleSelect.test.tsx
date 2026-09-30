// @vitest-environment jsdom
//
// ChangeRoleSelect — a member may hold a role this org can no longer assign: a
// coordinator or volunteer in a clinic (portal-vet-p0 D13), or a foster. The
// select must still SHOW that role, disabled, instead of rendering the first
// option as if it were theirs.

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/src/modules/organizations/actions", () => ({
  changeMemberRoleAction: vi.fn(),
}));
vi.mock("@/lib/ui/action-feedback", () => ({ notifySaved: vi.fn() }));

import { ChangeRoleSelect } from "./ChangeRoleSelect";

const CLINIC_ROLES = [
  { value: "admin", label: "Administrador" },
  { value: "member", label: "Miembro" },
  { value: "vet_individual", label: "Veterinario" },
];

afterEach(cleanup);

describe("ChangeRoleSelect", () => {
  it("keeps a legacy role on screen as the selected, disabled option", () => {
    render(
      <ChangeRoleSelect
        organizationId="org-1"
        membershipId="mem-1"
        currentRole="volunteer"
        currentRoleLabel="Voluntario"
        settableRoles={CLINIC_ROLES}
      />,
    );
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("volunteer");
    const legacy = screen.getByRole("option", { name: "Voluntario" }) as HTMLOptionElement;
    expect(legacy.disabled).toBe(true);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Voluntario",
      "Administrador",
      "Miembro",
      "Veterinario",
    ]);
  });

  it("adds nothing when the current role is settable", () => {
    render(
      <ChangeRoleSelect
        organizationId="org-1"
        membershipId="mem-1"
        currentRole="member"
        currentRoleLabel="Miembro"
        settableRoles={CLINIC_ROLES}
      />,
    );
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("member");
  });
});

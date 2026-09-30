// @vitest-environment jsdom
//
// InviteForm — inviting a vet_individual explains where clinical permissions
// come from instead of offering (and silently dropping) the checkbox
// (portal-vet-p0 D11).

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actionMock = vi.fn();
vi.mock("@/src/modules/organizations/actions", () => ({
  inviteMemberAction: (...args: unknown[]) => actionMock(...args),
}));
vi.mock("@/lib/ui/action-feedback", () => ({ notifySaved: vi.fn() }));

import { InviteForm, VET_INVITE_MATRICULA_EXPLANATION } from "./InviteForm";

const ROLES = [
  { value: "member", label: "Miembro" },
  { value: "vet_individual", label: "Veterinario/a" },
];

beforeEach(() => {
  actionMock.mockReset();
  actionMock.mockResolvedValue({ inviteUrl: "https://example.test/r/invite/T" });
});

afterEach(cleanup);

const CHECKBOX_LABEL = "Puede registrar eventos clínicos/sanitarios";

describe("<InviteForm> — vet_individual", () => {
  it("shows the matrícula explanation instead of the clinical checkbox", () => {
    render(
      <InviteForm
        organizationId="org-1"
        orgToken="ORG-1"
        grantableRoles={ROLES}
        defaultRole="vet_individual"
      />,
    );
    expect(screen.queryByText(CHECKBOX_LABEL)).not.toBeInTheDocument();
    expect(screen.getByTestId("vet-invite-matricula-note")).toHaveTextContent(
      VET_INVITE_MATRICULA_EXPLANATION,
    );
    expect(VET_INVITE_MATRICULA_EXPLANATION).toMatch(/matrícula verificada/);
  });

  it("switching the role to vet swaps the checkbox for the explanation and sends false", async () => {
    const { container } = render(
      <InviteForm organizationId="org-1" orgToken="ORG-1" grantableRoles={ROLES} />,
    );
    // Tick the checkbox as a member, then switch to vet_individual.
    fireEvent.click(screen.getByText(CHECKBOX_LABEL));
    const select = container.querySelector("select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "vet_individual" } });
    expect(screen.queryByText(CHECKBOX_LABEL)).not.toBeInTheDocument();
    expect(screen.getByTestId("vet-invite-matricula-note")).toBeInTheDocument();

    const email = container.querySelector('input[type="email"]') as HTMLInputElement;
    fireEvent.change(email, { target: { value: "vet@example.test" } });
    (container.querySelector("form") as HTMLFormElement).requestSubmit();

    await waitFor(() => expect(actionMock).toHaveBeenCalled());
    expect(actionMock).toHaveBeenCalledWith(
      expect.objectContaining({ invitedRole: "vet_individual", canWritePetEvents: false }),
    );
  });
});

describe("<InviteForm> — other roles keep the checkbox", () => {
  it("a member invite shows the checkbox and no explanation", () => {
    render(
      <InviteForm
        organizationId="org-1"
        orgToken="ORG-1"
        grantableRoles={ROLES}
        defaultRole="member"
      />,
    );
    expect(screen.getByText(CHECKBOX_LABEL)).toBeInTheDocument();
    expect(screen.queryByTestId("vet-invite-matricula-note")).not.toBeInTheDocument();
  });
});

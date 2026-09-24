// @vitest-environment jsdom
//
// EditOrgForm's "tier0ShowOriginOrg" checkbox had a STATIC defaultChecked
// derived from `organization` — a rejected submit puts back the ORIGINAL
// toggle state, discarding whatever the admin had just changed it to.
//
// Real submit via `form.requestSubmit()` — see
// __tests__/react19-form-reset-contract.test.tsx for why a dispatched event
// does not exercise React 19's reset.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actionMock = vi.fn();
vi.mock("@/src/modules/organizations/actions", () => ({
  updateOrganizationAction: (...args: unknown[]) => actionMock(...args),
}));

import type { Organization } from "@/db";
import { EditOrgForm } from "./EditOrgForm";

const ORG = {
  publicToken: "ORG-TEST-0001",
  displayName: "Refugio Norte",
  legalName: null,
  email: null,
  phone: null,
  website: null,
  description: null,
  personeriaJuridicaNumber: null,
  tier0ShowOriginOrg: false,
  orgType: "shelter",
  capacityDogs: null,
  capacityCats: null,
  capacityOther: null,
  capacityTotal: null,
} as unknown as Pick<
  Organization,
  | "publicToken"
  | "displayName"
  | "legalName"
  | "email"
  | "phone"
  | "website"
  | "description"
  | "personeriaJuridicaNumber"
  | "tier0ShowOriginOrg"
  | "orgType"
  | "capacityDogs"
  | "capacityCats"
  | "capacityOther"
  | "capacityTotal"
>;

beforeEach(() => {
  actionMock.mockReset();
});

afterEach(cleanup);

describe("<EditOrgForm> — survives the React 19 post-error reset", () => {
  it("keeps the toggled checkbox after a rejected submit", async () => {
    actionMock.mockResolvedValue({ error: "No se pudo guardar la organización." });
    const { container } = render(<EditOrgForm organization={ORG} />);

    const checkbox = container.querySelector(
      'input[name="tier0ShowOriginOrg"]',
    ) as HTMLInputElement;
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);

    form.requestSubmit();
    await waitFor(() => expect(actionMock).toHaveBeenCalled());
    await screen.findByText("No se pudo guardar la organización.");

    expect(
      (container.querySelector('input[name="tier0ShowOriginOrg"]') as HTMLInputElement).checked,
    ).toBe(true);
  });
});

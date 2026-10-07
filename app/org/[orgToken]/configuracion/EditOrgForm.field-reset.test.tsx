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

// portal-vet-p0 D13 — the origin toggle speaks the org's kind. It is never
// hidden: an absent checkbox posts false and would switch the setting off.
describe("<EditOrgForm> — the origin toggle follows the org type", () => {
  it("keeps the refugio wording for a shelter (regression)", () => {
    const { container } = render(<EditOrgForm organization={ORG} />);
    expect(container).toHaveTextContent(
      "Mostrar a mi organización como refugio de origen en la credencial pública de las mascotas",
    );
    expect(container).toHaveTextContent(
      "Cuando está activo, la credencial pública muestra el nombre de tu organización como refugio de origen de la mascota.",
    );
  });

  it("does not call a clinic a refugio, and still renders the toggle", () => {
    const clinic = { ...ORG, orgType: "clinic" } as typeof ORG;
    const { container } = render(<EditOrgForm organization={clinic} />);
    expect(container.querySelector('input[name="tier0ShowOriginOrg"]')).not.toBeNull();
    expect(container).toHaveTextContent(
      "Mostrar a mi organización como organización de origen en la credencial pública de las mascotas",
    );
    expect(container).not.toHaveTextContent(/refugio de origen/);
  });
});

// Migration 0283 — the public directory listing is a clinic's setting. A
// shelter is listed on verification alone, so it gets no toggle AND no marker
// (the marker is what makes the action write the column at all).
describe("<EditOrgForm> — the public directory toggle (clinics only)", () => {
  const CLINIC = {
    ...ORG,
    orgType: "clinic",
    publicDirectoryOptIn: false,
    verified: true,
  } as typeof ORG & { publicDirectoryOptIn: boolean; verified: boolean };

  it("renders no toggle and no marker for a shelter", () => {
    const { container } = render(<EditOrgForm organization={ORG} />);
    expect(container.querySelector('input[name="publicDirectoryOptIn"]')).toBeNull();
    expect(container.querySelector('input[name="publicDirectoryOptInPresent"]')).toBeNull();
    expect(container).not.toHaveTextContent("Aparecer en el directorio público de miMAR");
  });

  it("renders the toggle, OFF by default, with what becomes public", () => {
    const { container } = render(<EditOrgForm organization={CLINIC} />);
    const toggle = container.querySelector(
      'input[name="publicDirectoryOptIn"]',
    ) as HTMLInputElement;
    expect(toggle).not.toBeNull();
    expect(toggle.checked).toBe(false);
    expect(container.querySelector('input[name="publicDirectoryOptInPresent"]')).not.toBeNull();
    expect(container).toHaveTextContent("Aparecer en el directorio público de miMAR");
    expect(container).toHaveTextContent(/correo, teléfono, sitio web/);
    // The disclosure matches what the profile serves (lib/infra/org-public-profile.ts):
    // a clinic's legal name and exact location are withheld, so the consent
    // must not list them as public — and says they are not.
    expect(container).toHaveTextContent("No mostramos la razón social ni la dirección exacta.");
    expect(container).not.toHaveTextContent(/ubicación/);
    expect(container).not.toHaveTextContent("Vas a aparecer cuando miMAR verifique");
  });

  it("says an unverified clinic only appears once verified", () => {
    const { container } = render(
      <EditOrgForm organization={{ ...CLINIC, verified: false, publicDirectoryOptIn: true }} />,
    );
    expect(
      (container.querySelector('input[name="publicDirectoryOptIn"]') as HTMLInputElement).checked,
    ).toBe(true);
    expect(container).toHaveTextContent("Vas a aparecer cuando miMAR verifique la organización.");
  });

  it("posts the marker and the toggled value, and keeps it after a rejected submit", async () => {
    actionMock.mockResolvedValue({ error: "No se pudo guardar la organización." });
    const { container } = render(<EditOrgForm organization={CLINIC} />);
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.click(container.querySelector('input[name="publicDirectoryOptIn"]') as Element);
    form.requestSubmit();
    await waitFor(() => expect(actionMock).toHaveBeenCalled());
    const posted = actionMock.mock.calls[0]?.at(-1) as FormData;
    expect(posted.get("publicDirectoryOptInPresent")).toBe("1");
    expect(posted.get("publicDirectoryOptIn")).toBe("true");

    await screen.findByText("No se pudo guardar la organización.");
    expect(
      (container.querySelector('input[name="publicDirectoryOptIn"]') as HTMLInputElement).checked,
    ).toBe(true);
  });
});

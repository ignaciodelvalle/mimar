// @vitest-environment jsdom
//
// OrgCreateForm's `orgType` <select> was controlled with value+onChange —
// which is NEVER enough for a select: it falls back to its FIRST option on
// the reset that follows a rejected submit (measured in
// __tests__/react19-form-reset-contract.test.tsx). The text fields are
// genuinely controlled (value+onChange together) and already survive on
// their own.
//
// Real submit via `form.requestSubmit()` — see
// __tests__/react19-form-reset-contract.test.tsx for why a dispatched event
// does not exercise React 19's reset.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actionMock = vi.fn();
vi.mock("@/app/actions/upgrade", () => ({
  createOrganizationAction: (...args: unknown[]) => actionMock(...args),
}));

vi.mock("@/lib/ui/full-page-action-nav", () => ({
  navigateAfterActionSuccess: vi.fn(),
}));

import { OrgCreateForm } from "./OrgCreateForm";

beforeEach(() => {
  actionMock.mockReset();
});

afterEach(cleanup);

describe("<OrgCreateForm> — survives the React 19 post-error reset", () => {
  it("keeps the chosen org type after a rejected submit", async () => {
    actionMock.mockResolvedValue({ error: "No se pudo crear la organización." });
    const { container } = render(<OrgCreateForm dniVerified={true} />);

    const name = container.querySelector('input[name="name"]') as HTMLInputElement;
    const legalName = container.querySelector('input[name="legalName"]') as HTMLInputElement;
    const orgType = container.querySelector('select[name="orgType"]') as HTMLSelectElement;
    const email = container.querySelector('input[name="email"]') as HTMLInputElement;
    const form = container.querySelector("form") as HTMLFormElement;

    // Every OTHER required field needs a valid value too — jsdom enforces
    // native constraint validation, so a blank required field blocks
    // form.requestSubmit() before the action is ever called, which is
    // unrelated to what this test proves (the select's survival).
    fireEvent.change(name, { target: { value: "Refugio El Campito" } });
    fireEvent.change(legalName, { target: { value: "Asoc. Civil Refugio El Campito" } });
    fireEvent.change(email, { target: { value: "contacto@elcampito.org.ar" } });
    fireEvent.change(orgType, { target: { value: "rescue_network" } });

    form.requestSubmit();
    await waitFor(() => expect(actionMock).toHaveBeenCalled());
    await screen.findByText("No se pudo crear la organización.");

    expect((container.querySelector('select[name="orgType"]') as HTMLSelectElement).value).toBe(
      "rescue_network",
    );
  });
});

// @vitest-environment jsdom
//
// <FoundPetForm> — "¿Encontraste a esta mascota?" on the public credential.
//
// PO 2026-10-01: the contact is REQUIRED (the name stays optional). A report
// with no way back told the owner their pet was found and left them nobody to
// call. The SERVER is the authority (notify-owner-found-pet-action.test.ts pins
// the refusal); this pins that the form says so first, in es-AR, without a
// round trip, and that the field no longer reads "(opcional)".

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockAction } = vi.hoisted(() => ({
  mockAction: vi.fn(async () => ({ ok: false, error: null })),
}));

vi.mock("@/app/actions/public", () => ({
  notifyOwnerOfFoundPetAction: mockAction,
}));

import { FoundPetForm } from "@/app/(public)/p/[publicToken]/FoundPetForm";

const CONTACT_REQUIRED = "Dejá un teléfono o un email para que el dueño pueda contactarte.";

function contactInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector("#finderContact") as HTMLInputElement;
}

function submit(container: HTMLElement): void {
  fireEvent.submit(container.querySelector("form") as HTMLFormElement);
}

beforeEach(() => {
  mockAction.mockClear();
});

afterEach(cleanup);

describe("<FoundPetForm> — a contact is required", () => {
  it("labels the contact as required and the name as optional", () => {
    const { getByLabelText } = render(<FoundPetForm publicToken="DIM-TEST-0001" />);

    expect(getByLabelText("Cómo te contactamos")).toHaveAttribute("aria-required", "true");
    expect(getByLabelText("Tu nombre (opcional)")).not.toHaveAttribute("aria-required");
  });

  it("refuses an empty contact with the es-AR message and never calls the action", () => {
    const { container, getByRole } = render(<FoundPetForm publicToken="DIM-TEST-0001" />);

    submit(container);

    expect(getByRole("alert")).toHaveTextContent(CONTACT_REQUIRED);
    expect(contactInput(container)).toHaveAttribute("aria-invalid", "true");
    expect(mockAction).not.toHaveBeenCalled();
  });

  it("refuses a value that is neither a dialable phone nor an email", () => {
    const { container, getByRole } = render(<FoundPetForm publicToken="DIM-TEST-0001" />);
    fireEvent.change(contactInput(container), { target: { value: "1111" } });

    submit(container);

    expect(getByRole("alert")).toHaveTextContent(CONTACT_REQUIRED);
    expect(mockAction).not.toHaveBeenCalled();
  });

  it("lets a phone through, with no client error shown", () => {
    const { container, queryByRole } = render(<FoundPetForm publicToken="DIM-TEST-0001" />);
    fireEvent.change(contactInput(container), { target: { value: "11-4123-4567" } });

    submit(container);

    expect(queryByRole("alert")).toBeNull();
  });

  it("clears the refusal once a reachable contact is submitted", () => {
    const { container, getByRole, queryByRole } = render(
      <FoundPetForm publicToken="DIM-TEST-0001" />,
    );
    submit(container);
    expect(getByRole("alert")).toHaveTextContent(CONTACT_REQUIRED);

    fireEvent.change(contactInput(container), { target: { value: "ana@example.com" } });
    submit(container);

    expect(queryByRole("alert")).toBeNull();
  });
});

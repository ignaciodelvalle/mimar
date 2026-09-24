// @vitest-environment jsdom
//
// ShareLibretaSheet's "label" was a bare uncontrolled input and "duration" a
// static-defaultChecked radio group — a rejected submit wiped the typed
// label and fell the duration back to its mount default (7 dias),
// discarding whatever the person had actually picked.
//
// Real submit via `form.requestSubmit()` — see
// __tests__/react19-form-reset-contract.test.tsx for why a dispatched event
// does not exercise React 19's reset.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ShareLibretaSheet } from "./ShareLibretaSheet";

afterEach(cleanup);

describe("<ShareLibretaSheet> — survives the React 19 post-error reset", () => {
  it("keeps the typed label and the picked duration after a rejected submit", async () => {
    const createShareAction = vi.fn(async () => ({ error: "No se pudo generar el link." }));
    const { container } = render(
      <ShareLibretaSheet
        petPublicToken="DIM-TEST-0001"
        petName="Firulais"
        createShareAction={createShareAction}
      />,
    );

    const label = container.querySelector('input[name="label"]') as HTMLInputElement;
    const ninety = container.querySelector(
      'input[name="duration"][value="90"]',
    ) as HTMLInputElement;
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.change(label, { target: { value: "Vet de cabecera" } });
    fireEvent.click(ninety);

    form.requestSubmit();
    await waitFor(() => expect(createShareAction).toHaveBeenCalled());
    await screen.findByText("No se pudo generar el link.");

    expect((container.querySelector('input[name="label"]') as HTMLInputElement).value).toBe(
      "Vet de cabecera",
    );
    expect(
      (container.querySelector('input[name="duration"][value="90"]') as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (container.querySelector('input[name="duration"][value="7"]') as HTMLInputElement).checked,
    ).toBe(false);
  });
});

// @vitest-environment jsdom
//
// Step 2's `registry` radio group was controlled via `checked`/`onChange` —
// the exact shape __tests__/react19-form-reset-contract.test.tsx measures as
// vulnerable regardless: React 19 resets the form when the action settles,
// error included, and a controlled radio falls back to its mount value
// (none ticked, since this group ships with nothing pre-selected). A
// required field the person already answered would look unanswered again.
// `useKeptFields` fixes it via `keptChecked`.
//
// Real submit via `form.requestSubmit()`.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DangerousBreedAttestationForm } from "./DangerousBreedAttestationForm";

afterEach(cleanup);

const RESOLVED_REGISTRIES = [{ id: "caba_4078", label: "CABA · Ley 4078", required: true }];

describe("<DangerousBreedAttestationForm> — survives the React 19 post-error reset", () => {
  it("keeps the registry radio pick after a rejected submit", async () => {
    const action = vi.fn(async () => ({ error: "No se pudo registrar la atestación." }));
    const { container } = render(
      <DangerousBreedAttestationForm action={action} resolvedRegistries={RESOLVED_REGISTRIES} />,
    );

    // Step 1 — check every legal acknowledgement to advance.
    for (const checkbox of container.querySelectorAll('input[type="checkbox"]')) {
      fireEvent.click(checkbox);
    }
    fireEvent.click(screen.getByRole("button", { name: "Continuar con la atestación →" }));

    const registryRadio = await screen.findByDisplayValue("caba_4078");
    const attestedAt = container.querySelector('input[name="attestedAt"]') as HTMLInputElement;
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.click(registryRadio);
    expect((registryRadio as HTMLInputElement).checked).toBe(true);
    fireEvent.change(attestedAt, { target: { value: "2026-05-05" } });

    form.requestSubmit();
    await waitFor(() => expect(action).toHaveBeenCalled());
    await screen.findByText("No se pudo registrar la atestación.");

    expect((screen.getByDisplayValue("caba_4078") as HTMLInputElement).checked).toBe(true);
    expect((container.querySelector('input[name="attestedAt"]') as HTMLInputElement).value).toBe(
      "2026-05-05",
    );
  });
});

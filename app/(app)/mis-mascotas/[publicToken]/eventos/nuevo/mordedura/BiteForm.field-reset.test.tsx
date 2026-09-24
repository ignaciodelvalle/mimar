// @vitest-environment jsdom
//
// BiteForm's `victimKind` radio group and `severity` select were controlled
// via `checked`/`value`+`onChange` — the exact pair
// __tests__/react19-form-reset-contract.test.tsx measures as vulnerable
// regardless: React 19 resets the form when the action settles, error
// included, and a controlled select falls back to its first option while a
// controlled radio falls back to its mount value. `useKeptFields` fixes
// both. `confirmObservation` is deliberately NOT kept (a fresh legal
// acknowledgement, not typed work).
//
// Real submit via `form.requestSubmit()`.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/LocationFields", () => ({
  LocationFields: () => null,
}));

import { BiteForm } from "./BiteForm";

afterEach(cleanup);

describe("<BiteForm> — survives the React 19 post-error reset", () => {
  it("keeps the victim-kind radio, the severity select, and every text field after a rejected submit", async () => {
    const action = vi.fn(async () => ({ error: "No se pudo registrar la mordedura." }));
    const { container } = render(<BiteForm action={action} petName="Toby" />);

    const occurredAt = container.querySelector('input[name="occurredAt"]') as HTMLInputElement;
    const animalRadio = container.querySelector(
      'input[name="victimKind"][value="animal"]',
    ) as HTMLInputElement;
    const severity = container.querySelector('select[name="severity"]') as HTMLSelectElement;
    const context = container.querySelector('textarea[name="context"]') as HTMLTextAreaElement;
    const confirmObservation = container.querySelector(
      'input[name="confirmObservation"]',
    ) as HTMLInputElement;
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.change(occurredAt, { target: { value: "2026-08-01" } });
    fireEvent.click(animalRadio);
    expect(animalRadio.checked).toBe(true);
    fireEvent.change(severity, { target: { value: "severe" } });
    fireEvent.change(context, { target: { value: "Pelea con otro perro en la plaza." } });
    // Required by the browser's own constraint validation — without it
    // requestSubmit() never dispatches the action at all.
    fireEvent.click(confirmObservation);

    form.requestSubmit();
    await waitFor(() => expect(action).toHaveBeenCalled());
    await screen.findByText("No se pudo registrar la mordedura.");

    // Re-queried: the select `key` change remounts it, so the earlier node is
    // detached — that remount is the fix, not an artifact to work around.
    expect(
      (container.querySelector('input[name="victimKind"][value="animal"]') as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect((container.querySelector('select[name="severity"]') as HTMLSelectElement).value).toBe(
      "severe",
    );
    expect((container.querySelector('input[name="occurredAt"]') as HTMLInputElement).value).toBe(
      "2026-08-01",
    );
    expect((container.querySelector('textarea[name="context"]') as HTMLTextAreaElement).value).toBe(
      "Pelea con otro perro en la plaza.",
    );
  });
});

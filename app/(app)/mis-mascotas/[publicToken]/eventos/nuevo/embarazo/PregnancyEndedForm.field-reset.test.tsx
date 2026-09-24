// @vitest-environment jsdom
//
// PregnancyEndedForm lost EVERY field on a rejected submit (forms/react19-reset
// -data-loss-inventory, #2 by damage: "pérdida del 100%: ningún campo
// controlado"). React 19 resets a `<form action={…}>` once the action settles
// — including on error — and nothing here survived it: date, outcome, birth
// count, vet and notes.
//
// `useKeptFields` fixes it. See __tests__/react19-form-reset-contract.test.tsx
// for the underlying mechanism this measures against the real component
// (pattern mirrors its `CorrectSpeciesForm` case): a real submit via
// `form.requestSubmit()`, not a mocked useActionState, because only the real
// form-action path triggers React's reset.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PregnancyEndedForm } from "./PregnancyEndedForm";

afterEach(cleanup);

describe("<PregnancyEndedForm> — survives the React 19 post-error reset", () => {
  it("keeps date, outcome radio, birth count, vet and notes after a rejected submit", async () => {
    const action = vi.fn(async () => ({ error: "No se pudo registrar el cierre." }));
    const { container } = render(<PregnancyEndedForm action={action} />);

    const date = container.querySelector('input[name="occurredAt"]') as HTMLInputElement;
    const stillbirth = container.querySelector(
      'input[name="outcome"][value="stillbirth"]',
    ) as HTMLInputElement;
    const liveBirth = container.querySelector(
      'input[name="outcome"][value="live_birth"]',
    ) as HTMLInputElement;
    const vet = container.querySelector('input[name="vetConsulted"]') as HTMLInputElement;
    const notes = container.querySelector('textarea[name="notes"]') as HTMLTextAreaElement;
    const form = container.querySelector("form") as HTMLFormElement;

    // live_birth is the mount default, so liveBirthsCount is present too.
    expect(liveBirth.checked).toBe(true);
    const liveBirthsCount = container.querySelector(
      'input[name="liveBirthsCount"]',
    ) as HTMLInputElement;

    fireEvent.change(date, { target: { value: "2026-05-01" } });
    fireEvent.change(liveBirthsCount, { target: { value: "3" } });
    fireEvent.change(vet, { target: { value: "Dra. Pérez" } });
    fireEvent.change(notes, { target: { value: "Parto en casa, sin complicaciones." } });

    // A real submit — React 19's form-action path does not run on a dispatched
    // event, and without it the reset under test never happens.
    form.requestSubmit();
    await waitFor(() => expect(action).toHaveBeenCalled());
    await screen.findByText("No se pudo registrar el cierre.");

    expect(date.value).toBe("2026-05-01");
    expect(liveBirthsCount.value).toBe("3");
    expect(vet.value).toBe("Dra. Pérez");
    expect(notes.value).toBe("Parto en casa, sin complicaciones.");
    expect(liveBirth.checked).toBe(true);
    expect(stillbirth.checked).toBe(false);
  });

  it("keeps a NON-DEFAULT outcome radio choice after a rejected submit", async () => {
    const action = vi.fn(async () => ({ error: "No se pudo registrar el cierre." }));
    const { container } = render(<PregnancyEndedForm action={action} />);

    const stillbirth = container.querySelector(
      'input[name="outcome"][value="stillbirth"]',
    ) as HTMLInputElement;
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.click(stillbirth);
    expect(stillbirth.checked).toBe(true);

    form.requestSubmit();
    await waitFor(() => expect(action).toHaveBeenCalled());
    await screen.findByText("No se pudo registrar el cierre.");

    // Re-queried: same node, defaultChecked-based radios are not remounted,
    // but the assertion is kept explicit about what it means.
    expect(
      (container.querySelector('input[name="outcome"][value="stillbirth"]') as HTMLInputElement)
        .checked,
    ).toBe(true);
  });
});

// @vitest-environment jsdom
//
// RecordDeathInObservationForm had no reset protection at all: both selects
// (`cause`, `dispositionMethod`) shipped `defaultValue=""`, `deathAtClinic`
// was a bare uncontrolled checkbox, and `causeDetail`/`occurredAt`/`facility`/
// `notes` had no `defaultValue`. React 19 resets the form when the action
// settles, INCLUDING on error, so a professional recording a death during a
// rabies observation lost the cause, the date and the disposition on any
// server-side rejection. `useKeptFields` re-seeds every field from the
// FormData actually submitted. `confirmIrreversible` is deliberately left
// OUT — a fresh acknowledgement of an irreversible write, not typed work.
//
// Real submit via `form.requestSubmit()` — see
// __tests__/react19-form-reset-contract.test.tsx for why a dispatched event
// does not exercise React 19's reset.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ui/full-page-action-nav", () => ({
  navigateAfterActionSuccess: vi.fn(),
}));

import { RecordDeathInObservationForm } from "./RecordDeathInObservationForm";

afterEach(cleanup);

describe("<RecordDeathInObservationForm> — survives the React 19 post-error reset", () => {
  it("keeps both selects, the checkbox, date, text and notes after a rejected submit", async () => {
    const action = vi.fn(async () => ({ error: "No se pudo registrar el fallecimiento." }));
    const { container } = render(
      <RecordDeathInObservationForm action={action} petName="Firulais" />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Registrar muerte durante la observación" }),
    );

    const cause = container.querySelector('select[name="cause"]') as HTMLSelectElement;
    const causeDetail = container.querySelector('input[name="causeDetail"]') as HTMLInputElement;
    const occurredAt = container.querySelector('input[name="occurredAt"]') as HTMLInputElement;
    const deathAtClinic = container.querySelector(
      'input[name="deathAtClinic"]',
    ) as HTMLInputElement;
    const dispositionMethod = container.querySelector(
      'select[name="dispositionMethod"]',
    ) as HTMLSelectElement;
    const facility = container.querySelector('input[name="facility"]') as HTMLInputElement;
    const notes = container.querySelector('textarea[name="notes"]') as HTMLTextAreaElement;
    const confirmIrreversible = container.querySelector(
      'input[name="confirmIrreversible"]',
    ) as HTMLInputElement;
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.change(cause, { target: { value: "natural" } });
    fireEvent.change(causeDetail, { target: { value: "Vejez, paro cardíaco" } });
    fireEvent.change(occurredAt, { target: { value: "2026-09-10" } });
    fireEvent.click(deathAtClinic);
    fireEvent.change(dispositionMethod, { target: { value: "cremation_individual_ashes" } });
    fireEvent.change(facility, { target: { value: "Crematorio Norte" } });
    fireEvent.change(notes, { target: { value: "Familia avisada por teléfono." } });
    fireEvent.click(confirmIrreversible);

    form.requestSubmit();
    await waitFor(() => expect(action).toHaveBeenCalled());
    await screen.findByText("No se pudo registrar el fallecimiento.");

    // Re-queried: the select `key` change remounts it, so the earlier node is
    // detached — that remount is the fix, not an artifact to work around.
    expect((container.querySelector('select[name="cause"]') as HTMLSelectElement).value).toBe(
      "natural",
    );
    expect((container.querySelector('input[name="causeDetail"]') as HTMLInputElement).value).toBe(
      "Vejez, paro cardíaco",
    );
    expect((container.querySelector('input[name="occurredAt"]') as HTMLInputElement).value).toBe(
      "2026-09-10",
    );
    expect(
      (container.querySelector('input[name="deathAtClinic"]') as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (container.querySelector('select[name="dispositionMethod"]') as HTMLSelectElement).value,
    ).toBe("cremation_individual_ashes");
    expect((container.querySelector('input[name="facility"]') as HTMLInputElement).value).toBe(
      "Crematorio Norte",
    );
    expect((container.querySelector('textarea[name="notes"]') as HTMLTextAreaElement).value).toBe(
      "Familia avisada por teléfono.",
    );
  });
});

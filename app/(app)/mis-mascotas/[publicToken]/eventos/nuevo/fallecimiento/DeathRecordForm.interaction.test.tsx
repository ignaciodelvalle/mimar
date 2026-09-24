// @vitest-environment jsdom
//
// Rabies-aware disposal warning (surveillance-disposal slice, S1).
//
// Contract under test — bidirectional:
//   - inRabiesObservation && non-recommended method (owner_burial or
//     household_waste) → the STRONG danger callout renders, citing the
//     observation framework (Ley 22.953), and the generic burial tips do NOT
//     (advising HOW to bury while saying DON'T bury would contradict itself).
//   - inRabiesObservation && recommended method (cremation) → no warning.
//   - !inRabiesObservation && owner_burial → only the pre-existing generic
//     tips ("Si vas a enterrarlo…"), never the rabies callout.
//
// Exercises the REAL useState chain via RTL (same pattern as
// CodeEntryForm.interaction.test.tsx) so the select→callout wiring is covered,
// not just a predicate.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DeathRecordForm } from "./DeathRecordForm";

const RABIES_WARNING_TITLE = "Tu mascota está en observación antirrábica";
const GENERIC_TIPS = "Si vas a enterrarlo, te recomendamos:";

afterEach(() => {
  cleanup();
});

function renderForm(inRabiesObservation: boolean) {
  const action = vi.fn(async () => ({ error: null }));
  render(
    <DeathRecordForm action={action} species="dog" inRabiesObservation={inRabiesObservation} />,
  );
  return screen.getByLabelText(/Método de disposición/i);
}

describe("<DeathRecordForm> — rabies-aware disposal warning", () => {
  it("shows the danger callout for owner_burial during observation, with the legal basis, and hides the generic tips", () => {
    const select = renderForm(true);

    fireEvent.change(select, { target: { value: "owner_burial" } });

    expect(screen.getByText(RABIES_WARNING_TITLE)).toBeInTheDocument();
    expect(screen.getByText(/Ley Nacional 22\.953/)).toBeInTheDocument();
    expect(screen.getByText(/canales autorizados/)).toBeInTheDocument();
    expect(screen.queryByText(GENERIC_TIPS)).toBeNull();
  });

  it("shows the danger callout for household_waste during observation", () => {
    const select = renderForm(true);

    fireEvent.change(select, { target: { value: "household_waste" } });

    expect(screen.getByText(RABIES_WARNING_TITLE)).toBeInTheDocument();
  });

  it("does NOT warn for a recommended method during observation", () => {
    const select = renderForm(true);

    fireEvent.change(select, { target: { value: "cremation_collective" } });

    expect(screen.queryByText(RABIES_WARNING_TITLE)).toBeNull();
    expect(screen.queryByText(GENERIC_TIPS)).toBeNull();
  });

  it("keeps only the generic burial tips for owner_burial when NOT under observation", () => {
    const select = renderForm(false);

    fireEvent.change(select, { target: { value: "owner_burial" } });

    expect(screen.getByText(GENERIC_TIPS)).toBeInTheDocument();
    expect(screen.queryByText(RABIES_WARNING_TITLE)).toBeNull();
  });

  it("does not warn on household_waste when NOT under observation (status quo)", () => {
    const select = renderForm(false);

    fireEvent.change(select, { target: { value: "household_waste" } });

    expect(screen.queryByText(RABIES_WARNING_TITLE)).toBeNull();
    expect(screen.queryByText(GENERIC_TIPS)).toBeNull();
  });

  it("never blocks submission — the CTA stays enabled with the warning visible", () => {
    const select = renderForm(true);
    fireEvent.change(select, { target: { value: "owner_burial" } });

    const cta = screen.getByRole("button", { name: "Registrar fallecimiento" });
    expect(cta).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// A3 datetime wave (2026-08-06) — "Fecha" stopped being a native
// `<input type="date">`, whose visible month/day order follows the BROWSER's
// locale, on the one field that fixes WHEN a pet died. What the server action
// receives is unchanged: `occurredAt` as an ISO yyyy-mm-dd string, which
// createDeathRecordAction parses with parseDateInput.
// ---------------------------------------------------------------------------

describe("<DeathRecordForm> — date of death entry (dd/mm/aaaa, browser-independent)", () => {
  function renderDateField(defaults?: { occurredAt: string | null; notes: string | null }) {
    const action = vi.fn(async () => ({ error: null }));
    const { container } = render(
      <DeathRecordForm action={action} species="dog" defaults={defaults} />,
    );
    return container;
  }

  it("submits ISO yyyy-mm-dd on a hidden occurredAt input, never a native date control", () => {
    const container = renderDateField({ occurredAt: "2026-07-03", notes: null });

    const submitted = container.querySelector<HTMLInputElement>(
      'input[type="hidden"][name="occurredAt"]',
    );
    expect(submitted).not.toBeNull();
    expect(submitted?.value).toBe("2026-07-03");
    expect(container.querySelector('input[type="date"]')).toBeNull();
  });

  it("shows the default date as dd/mm/aaaa in the field the owner actually reads", () => {
    renderDateField({ occurredAt: "2026-07-03", notes: null });

    expect(screen.getByLabelText(/Fecha/i)).toHaveValue("03/07/2026");
  });

  it("keeps the field required — the constraint sits on the visible input", () => {
    renderDateField({ occurredAt: "2026-07-03", notes: null });

    expect(screen.getByLabelText(/Fecha/i)).toBeRequired();
  });

  it("re-typing a date updates the submitted ISO value", () => {
    const container = renderDateField({ occurredAt: "2026-07-03", notes: null });

    fireEvent.change(screen.getByLabelText(/Fecha/i), { target: { value: "12/03/2026" } });

    expect(
      container.querySelector<HTMLInputElement>('input[type="hidden"][name="occurredAt"]')?.value,
    ).toBe("2026-03-12");
  });
});

// ---------------------------------------------------------------------------
// The reset that can write a false permanent fact
// ---------------------------------------------------------------------------

describe("<DeathRecordForm> - an error settle must not silently untick the clinic box", () => {
  // WHY THIS ONE MATTERS MORE THAN "the person retypes": React 19 resets a
  // `<form action>` when the action settles, ERROR INCLUDED, and a controlled
  // checkbox comes back at its mount value. On most forms that costs typing.
  // Here the box says WHERE THE ANIMAL DIED, on a record this same form tells
  // the person cannot be edited, corrected or undone. An unticked box that the
  // person ticked is not a blank - it is a different, false answer, and it
  // looks like an answer.
  //
  // `src/modules/events/actions.ts` has six independent rejection branches
  // this form can trip, so the error settle is not a rare path.
  it("keeps the clinic checkbox and the cause select after the action returns an error", async () => {
    const action = vi.fn(async () => ({ error: "Causa de muerte inválida." }));
    render(<DeathRecordForm action={action} species="dog" inRabiesObservation={false} />);

    // Selected by NAME, not by label: the label carries a required marker, and
    // the name is what actually reaches `FormData` - which is the thing under
    // test.
    const form = document.querySelector("form") as HTMLFormElement;
    const cause = form.querySelector('select[name="cause"]') as HTMLSelectElement;
    fireEvent.change(cause, { target: { value: "natural" } });

    const clinicBox = screen.getByLabelText(
      /Falleció durante una estadía en la veterinaria/i,
    ) as HTMLInputElement;
    fireEvent.click(clinicBox);
    expect(clinicBox.checked).toBe(true);

    // `requestSubmit()`, not `fireEvent.submit`: React 19's form-action path
    // only runs on a real submit, and a dispatched event settles nothing - so
    // the reset under test never happens and the assertions below pass
    // vacuously.
    form.requestSubmit();
    await waitFor(() => expect(action).toHaveBeenCalled());
    await screen.findByText(/Causa de muerte inválida/i);

    // THE ASSERTIONS THE OLD SHAPE FAILED. Read from the DOM, not from React
    // state: state was never what was lost. A reset restores a checkbox from
    // its `checked` ATTRIBUTE and a select from its options' `selected` one,
    // and with the controls controlled neither attribute carried the person's
    // answer.
    expect(
      (screen.getByLabelText(/Falleció durante una estadía en la veterinaria/i) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect((form.querySelector('select[name="cause"]') as HTMLSelectElement).value).toBe("natural");
  });
});

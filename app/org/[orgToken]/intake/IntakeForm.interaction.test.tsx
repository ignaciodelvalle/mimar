// @vitest-environment jsdom
//
// Interaction tests for the intake wizard's STEP CONTRACT (staging validation
// 2026-08-01, bug 3). Two properties were reported broken across three
// wizards: the summary CTA accepting clicks before the final step (doing
// nothing, silently), and radio/checkbox choices not surviving back-navigation
// while textareas did.
//
// Neither reproduced against this component — but nothing asserted either one,
// and IntakeForm had no test file at all. The premature-click gate in
// particular rested entirely on the `inert` attribute added by c5994e62 (a
// WCAG 4.1.2 fix, not a submit guard): remove it, forget it on a new step, or
// run somewhere it is unsupported, and "Crear ingreso" fires from step 1 with
// half-empty state.
//
// jsdom implements neither `inert`'s click blocking nor its focus behaviour, so
// `{ hidden: true }` reaches the inactive step's CTA and clicks it directly —
// which is precisely what lets these tests see the HANDLER guard rather than
// the attribute. A browser-level a11y attribute cannot be the only thing
// holding an intake shut, and now it isn't.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createIntakeMock = vi.fn();

vi.mock("@/app/actions/intake", () => ({
  createIntakeAction: Object.assign((...args: unknown[]) => createIntakeMock(...args), {
    bind:
      () =>
      (...args: unknown[]) =>
        createIntakeMock(...args),
  }),
}));

import { IntakeForm } from "./IntakeForm";

const NAME_LABEL = "Nombre o alias temporal *";

function renderForm() {
  return render(<IntakeForm orgToken="ORG-TEST-0001" />);
}

/**
 * Step 1 → 4, filling the minimum each step gate requires. Only the ACTIVE
 * step is in the accessibility tree (inactive ones are aria-hidden), so an
 * unqualified getByRole always resolves to the step on screen.
 */
function advanceToSummary() {
  fireEvent.click(screen.getByRole("button", { name: "Continuar sin chip" }));
  fireEvent.change(screen.getByLabelText(NAME_LABEL), { target: { value: "Rocío" } });
  // Step 2's own gate is `!name || !species` — both are required to advance.
  fireEvent.change(screen.getByLabelText("Especie *"), { target: { value: "dog" } });
  fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
  fireEvent.click(screen.getByRole("radio", { name: "Rescate" }));
  fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
}

beforeEach(() => {
  createIntakeMock.mockReset();
  createIntakeMock.mockResolvedValue({ error: null });
});

afterEach(() => {
  cleanup();
});

describe("<IntakeForm> — the summary CTA is gated on the step, not only on `inert`", () => {
  it("THE GUARD: a complete form clicked from an earlier step submits nothing", () => {
    renderForm();
    // Fill everything (this walks to step 4), then step BACK. Every required
    // field is now set, so the CTA's field-completeness gate is satisfied and
    // the button is enabled — the only thing left standing between a stray
    // click and a created intake is the step check inside submit().
    advanceToSummary();
    fireEvent.click(screen.getByRole("button", { name: "Paso anterior" }));

    const cta = screen.getByRole("button", { name: "Crear ingreso", hidden: true });
    expect(cta).not.toBeDisabled(); // otherwise this test proves nothing
    fireEvent.click(cta);

    expect(createIntakeMock).not.toHaveBeenCalled();
  });

  it("an empty form on step 1 cannot submit either", () => {
    renderForm();
    fireEvent.click(screen.getByRole("button", { name: "Crear ingreso", hidden: true }));
    expect(createIntakeMock).not.toHaveBeenCalled();
  });

  it("on the final step, with the required fields, the CTA submits", () => {
    renderForm();
    advanceToSummary();
    const cta = screen.getByRole("button", { name: "Crear ingreso" });
    expect(cta).not.toBeDisabled();
    fireEvent.click(cta);
    expect(createIntakeMock).toHaveBeenCalledTimes(1);
  });

  it("the submitted FormData carries the wizard's state, empty optionals omitted", () => {
    // Pins buildIntakeFormData, extracted from submit() to keep it under the
    // cognitive-complexity fence. The extraction was meant to be behaviour-
    // preserving; nothing asserted the payload before, so nothing would have
    // said otherwise.
    renderForm();
    advanceToSummary();
    fireEvent.click(screen.getByRole("button", { name: "Crear ingreso" }));

    const fd = createIntakeMock.mock.calls[0][1] as FormData;
    expect(fd.get("name")).toBe("Rocío");
    expect(fd.get("species")).toBe("dog");
    expect(fd.get("intakeReason")).toBe("rescue");
    // Always-sent fields keep their defaults rather than dropping out.
    expect(fd.get("sex")).toBe("unknown");
    expect(fd.get("custodyRole")).toBe("shelter_custody");
    expect(fd.get("noRedirect")).toBe("1");
    expect(fd.get("clientIdempotencyKey")).toBeTruthy();
    // Untouched optionals are absent, not blank — the action distinguishes.
    expect(fd.has("breed")).toBe(false);
    expect(fd.has("color")).toBe(false);
    expect(fd.has("tattooAckToken")).toBe(false);
  });
});

describe("<IntakeForm> — choices survive leaving a step and coming back", () => {
  it("a RADIO selected on step 3 is still selected after stepping back to it", () => {
    renderForm();
    advanceToSummary();

    // "Rescate" was chosen on step 3 before advancing to the summary.
    fireEvent.click(screen.getByRole("button", { name: "Paso anterior" }));
    expect(screen.getByRole("radio", { name: "Rescate" })).toBeChecked();
  });

  it("a radio changed, left, and revisited keeps the NEW value (not the default)", () => {
    renderForm();
    advanceToSummary();

    fireEvent.click(screen.getByRole("button", { name: "Paso anterior" }));
    fireEvent.click(screen.getByRole("radio", { name: "Entrega del dueño" }));
    // Forward to the summary and back again.
    fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
    fireEvent.click(screen.getByRole("button", { name: "Paso anterior" }));

    expect(screen.getByRole("radio", { name: "Entrega del dueño" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Rescate" })).not.toBeChecked();
  });

  it("a TEXT field on an earlier step survives too (the half that was never broken)", () => {
    renderForm();
    advanceToSummary();

    // Back from the summary (4) to 3, then to 2 where the name lives.
    fireEvent.click(screen.getByRole("button", { name: "Paso anterior" }));
    fireEvent.click(screen.getByRole("button", { name: "Paso anterior" }));
    expect(screen.getByLabelText(NAME_LABEL)).toHaveValue("Rocío");
  });
});

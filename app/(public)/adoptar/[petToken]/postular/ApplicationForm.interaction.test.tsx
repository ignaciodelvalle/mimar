// @vitest-environment jsdom
//
// Interaction tests for the adoption-application wizard's STEP CONTRACT
// (staging validation 2026-08-01, bug 3). Reported across three wizards: a
// summary CTA that accepts clicks before the final step and silently does
// nothing, and radio/checkbox choices that vanish on back-navigation while
// textareas survive.
//
// Neither reproduced here — all five steps stay mounted and every field is a
// controlled useState — but this component had no test file at all, and the
// premature-click gate was one a11y attribute deep: `inert`, added by
// c5994e62 for WCAG 4.1.2, with no step check in submit().
//
// jsdom implements neither `inert`'s click blocking nor aria-hidden filtering
// under `{ hidden: true }`, so these tests reach the CTA the way a client
// without `inert` support would — which is what makes the handler guard, and
// not the attribute, the thing under test.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const submitApplicationMock = vi.fn();

vi.mock("@/src/modules/adoption/actions", () => ({
  submitAdoptionApplicationAction: (...args: unknown[]) => submitApplicationMock(...args),
}));

import { ApplicationForm } from "./ApplicationForm";

const MOTIVATION = "Queremos darle un hogar tranquilo y tenemos patio cerrado.";

function renderForm() {
  return render(
    <ApplicationForm
      petPublicToken="DIM-TEST-0001"
      petName="Rocío"
      applicantEmail="postulante@dim.test"
    />,
  );
}

const next = () => fireEvent.click(screen.getByRole("button", { name: "Continuar →" }));
const back = () => fireEvent.click(screen.getByRole("button", { name: "Paso anterior" }));

/** Walk steps 1 → 5, satisfying each step's own gate, and tick the consent. */
function advanceToSummary() {
  fireEvent.change(screen.getByRole("textbox"), { target: { value: MOTIVATION } });
  next();
  fireEvent.click(screen.getByRole("radio", { name: "Sí, actualmente tengo mascotas" }));
  next();
  fireEvent.click(screen.getByRole("radio", { name: "Casa con patio" }));
  next();
  next();
  fireEvent.click(screen.getByRole("checkbox"));
}

beforeEach(() => {
  submitApplicationMock.mockReset();
  submitApplicationMock.mockResolvedValue({ ok: true, applicationId: "app-1" });
});

afterEach(() => {
  cleanup();
});

describe("<ApplicationForm> — the summary CTA is gated on the step, not only on `inert`", () => {
  it("THE GUARD: a complete application clicked from an earlier step sends nothing", () => {
    renderForm();
    // Consent is ticked (step 5), so the CTA's own `!profileSharingConsent`
    // gate is satisfied and the button is enabled. Stepping back leaves the
    // handler's step check as the only thing between a stray click and a
    // submitted application.
    advanceToSummary();
    back();

    const cta = screen.getByRole("button", { name: "Enviar postulación", hidden: true });
    expect(cta).not.toBeDisabled(); // otherwise this test proves nothing
    fireEvent.click(cta);

    expect(submitApplicationMock).not.toHaveBeenCalled();
  });

  it("on the final step the same click does submit", () => {
    renderForm();
    advanceToSummary();

    fireEvent.click(screen.getByRole("button", { name: "Enviar postulación" }));
    expect(submitApplicationMock).toHaveBeenCalledTimes(1);
  });
});

describe("<ApplicationForm> — choices survive leaving a step and coming back", () => {
  it("a RADIO answered on step 2 is still answered after navigating away and back", () => {
    renderForm();
    advanceToSummary();

    // 5 → 4 → 3 → 2.
    back();
    back();
    back();
    expect(screen.getByRole("radio", { name: "Sí, actualmente tengo mascotas" })).toBeChecked();
  });

  it("a CHECKBOX ticked on the last step stays ticked across a round trip", () => {
    renderForm();
    advanceToSummary();

    back();
    next();
    expect(screen.getByRole("checkbox")).toBeChecked();
  });

  it("a TEXTAREA on step 1 survives too (the half that was never broken)", () => {
    renderForm();
    advanceToSummary();

    back();
    back();
    back();
    back();
    expect(screen.getByRole("textbox")).toHaveValue(MOTIVATION);
  });
});

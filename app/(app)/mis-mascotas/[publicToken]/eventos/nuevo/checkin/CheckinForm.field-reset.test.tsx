// @vitest-environment jsdom
//
// CheckinForm's only field, "notes", was uncontrolled with a STATIC
// `defaultValue={defaults?.notes ?? ""}` — a rejected submit reset it to that
// same static value, wiping whatever the person had actually typed. Lifted to
// local React state (a controlled textarea survives the React 19 post-action
// reset on its own, per react19-form-reset-contract.test.tsx).
//
// Real submit via `form.requestSubmit()` — see that file for why a dispatched
// event does not exercise React 19's reset.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// LocationFields pulls in geocoding fetch/dynamic-import machinery irrelevant
// here (same technique as signup-form-field-state.test.tsx).
vi.mock("@/components/LocationFields", () => ({
  LocationFields: () => React.createElement("div", { "data-testid": "location-fields" }),
}));

import { CheckinForm } from "./CheckinForm";

afterEach(cleanup);

describe("<CheckinForm> — survives the React 19 post-error reset", () => {
  it("keeps the typed notes after a rejected submit", async () => {
    const action = vi.fn(async () => ({ error: "No se pudo enviar el check-in." }));
    const { container } = render(<CheckinForm action={action} />);

    const notes = container.querySelector('textarea[name="notes"]') as HTMLTextAreaElement;
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.change(notes, {
      target: { value: "Come bien, todavía tímida con gente nueva." },
    });

    form.requestSubmit();
    await waitFor(() => expect(action).toHaveBeenCalled());
    await screen.findByText("No se pudo enviar el check-in.");

    expect(notes.value).toBe("Come bien, todavía tímida con gente nueva.");
  });
});

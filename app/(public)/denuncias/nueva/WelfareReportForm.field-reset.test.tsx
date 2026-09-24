// @vitest-environment jsdom
//
// WelfareReportForm carried a hand-rolled `submittedRef` + `kept(name)` pair —
// the same shape `lib/ui/use-kept-fields.ts` generalized from — but it missed
// the `kind`/`severity` SELECTS (forms/react19-reset-data-loss-inventory #3:
// "ya tiene un `kept()` hecho a mano que NO cubre selects"). `defaultValue`
// alone does not move a `<select>` on a React UPDATE, only on a MOUNT — see
// the hook's docblock — so a rejected submit fell back both dropdowns to
// their placeholder despite carrying `kept()`. `subjectKind`'s controlled
// radio group had the matching defect for radios.
//
// Real submit via `form.requestSubmit()` — see
// __tests__/react19-form-reset-contract.test.tsx for why a dispatched event
// does not exercise React 19's reset.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// LocationFields pulls in geocoding fetch/dynamic-import machinery irrelevant
// here (same technique as signup-form-field-state.test.tsx).
vi.mock("@/components/LocationFields", () => ({
  LocationFields: () => React.createElement("div", { "data-testid": "location-fields" }),
}));

import { WelfareReportForm } from "./WelfareReportForm";

afterEach(cleanup);

describe("<WelfareReportForm> — survives the React 19 post-error reset", () => {
  it("keeps both selects, the subject radio, text, textarea and date after a rejected submit", async () => {
    const action = vi.fn(async () => ({ error: "La descripción es demasiado corta." }));
    const { container } = render(
      <WelfareReportForm action={action} isAnonymous={false} descriptionMinLength={20} />,
    );

    const kind = container.querySelector('select[name="kind"]') as HTMLSelectElement;
    const severity = container.querySelector('select[name="severity"]') as HTMLSelectElement;
    const description = container.querySelector(
      'textarea[name="description"]',
    ) as HTMLTextAreaElement;
    const locationRadio = container.querySelector(
      'input[name="subjectKind"][value="location"]',
    ) as HTMLInputElement;
    const occurredAt = container.querySelector('input[name="occurredAt"]') as HTMLInputElement;
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.change(kind, { target: { value: "chained" } });
    fireEvent.change(severity, { target: { value: "high" } });
    fireEvent.change(description, {
      target: { value: "Perro encadenado hace semanas sin agua a la vista." },
    });
    fireEvent.click(locationRadio);
    expect(locationRadio.checked).toBe(true);

    // location subject kind switches the field label but keeps the same
    // `name="subjectDescription"` textarea.
    const subjectDescription = container.querySelector(
      'textarea[name="subjectDescription"]',
    ) as HTMLTextAreaElement;
    fireEvent.change(subjectDescription, {
      target: { value: "Patio trasero de la casa con el número 123." },
    });
    fireEvent.change(occurredAt, { target: { value: "2026-06-10" } });

    form.requestSubmit();
    await waitFor(() => expect(action).toHaveBeenCalled());
    await screen.findByText("La descripción es demasiado corta.");

    // Re-queried: the select `key` change remounts it, so the earlier node is
    // detached — this is the fix, not an artifact to work around.
    expect((container.querySelector('select[name="kind"]') as HTMLSelectElement).value).toBe(
      "chained",
    );
    expect((container.querySelector('select[name="severity"]') as HTMLSelectElement).value).toBe(
      "high",
    );
    expect(description.value).toBe("Perro encadenado hace semanas sin agua a la vista.");
    expect(
      (container.querySelector('input[name="subjectKind"][value="location"]') as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      (container.querySelector('textarea[name="subjectDescription"]') as HTMLTextAreaElement).value,
    ).toBe("Patio trasero de la casa con el número 123.");
    expect(occurredAt.value).toBe("2026-06-10");
  });
});

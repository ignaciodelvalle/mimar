// @vitest-environment jsdom
//
// ClinicalInfoForm's "subKind" <LnSelect> was genuinely controlled
// (`value=`+`onChange=`) — the exact shape react19-form-reset-contract.test.tsx
// measures as unsafe regardless: a rejected submit falls a controlled select
// back to its first option ("Análisis de laboratorio"), silently swapping the
// clinical event's TYPE out from under the title the person already typed for
// a different type. Every other field here is a controlled text-ish input and
// already survives on its own.
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

import { ClinicalInfoForm } from "./ClinicalInfoForm";

afterEach(cleanup);

describe("<ClinicalInfoForm> — survives the React 19 post-error reset", () => {
  it("keeps a NON-DEFAULT subKind pick and the typed fields after a rejected submit", async () => {
    const action = vi.fn(async () => ({ error: "No se pudo guardar la información clínica." }));
    const { container } = render(<ClinicalInfoForm action={action} />);

    const subKind = container.querySelector('select[name="subKind"]') as HTMLSelectElement;
    const title = container.querySelector('input[name="title"]') as HTMLInputElement;
    const details = container.querySelector('textarea[name="details"]') as HTMLTextAreaElement;
    const form = container.querySelector("form") as HTMLFormElement;

    expect(subKind.value).toBe("lab_work"); // mount default

    fireEvent.change(subKind, { target: { value: "surgery" } });
    fireEvent.change(title, { target: { value: "Castración" } });
    fireEvent.change(details, { target: { value: "Sin complicaciones." } });

    form.requestSubmit();
    await waitFor(() => expect(action).toHaveBeenCalled());
    await screen.findByText("No se pudo guardar la información clínica.");

    expect(title.value).toBe("Castración");
    expect(details.value).toBe("Sin complicaciones.");
    // Re-queried: the select's `key` change remounts it, so the earlier node
    // is detached — that remount is the fix, not an artifact to work around.
    expect((container.querySelector('select[name="subKind"]') as HTMLSelectElement).value).toBe(
      "surgery",
    );
  });
});

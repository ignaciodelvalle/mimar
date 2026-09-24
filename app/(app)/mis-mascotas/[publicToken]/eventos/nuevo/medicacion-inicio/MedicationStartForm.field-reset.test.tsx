// @vitest-environment jsdom
//
// MedicationStartForm's "frequency" <LnSelect> was genuinely controlled
// (`value=`+`onChange=`) — the exact shape react19-form-reset-contract.test.tsx
// measures as unsafe regardless: a rejected submit falls a controlled select
// back to its first (empty) option, discarding the dosing frequency the
// person picked — and desyncing `showCustomHours`, which reads the same
// `frequency` state, from what the DOM select shows. Every other field here
// is a controlled text-ish input and already survives on its own.
//
// Real submit via `form.requestSubmit()` — see
// __tests__/react19-form-reset-contract.test.tsx for why a dispatched event
// does not exercise React 19's reset.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MedicationStartForm } from "./MedicationStartForm";

afterEach(cleanup);

describe("<MedicationStartForm> — survives the React 19 post-error reset", () => {
  it("keeps the frequency select and the typed fields after a rejected submit", async () => {
    const action = vi.fn(async () => ({ error: "No se pudo registrar la medicación." }));
    const { container } = render(<MedicationStartForm action={action} species="dog" />);

    const drugName = container.querySelector('input[name="drugName"]') as HTMLInputElement;
    const dose = container.querySelector('input[name="dose"]') as HTMLInputElement;
    const frequency = container.querySelector('select[name="frequency"]') as HTMLSelectElement;
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.change(drugName, { target: { value: "Amoxicilina" } });
    fireEvent.change(dose, { target: { value: "10 mg/kg" } });
    fireEvent.change(frequency, {
      target: { value: frequency.querySelectorAll("option")[1].value },
    });
    const pickedFrequency = frequency.value;

    form.requestSubmit();
    await waitFor(() => expect(action).toHaveBeenCalled());
    await screen.findByText("No se pudo registrar la medicación.");

    expect(drugName.value).toBe("Amoxicilina");
    expect(dose.value).toBe("10 mg/kg");
    // Re-queried: the select's `key` change remounts it, so the earlier node
    // is detached — that remount is the fix, not an artifact to work around.
    expect((container.querySelector('select[name="frequency"]') as HTMLSelectElement).value).toBe(
      pickedFrequency,
    );
  });
});

// @vitest-environment jsdom
//
// MedicationEndForm's "medicationStartedEventId" <LnSelect> was genuinely
// controlled (`value=`+`onChange=`) — the exact shape
// react19-form-reset-contract.test.tsx measures as unsafe regardless: a
// rejected submit falls a controlled select back to its first (disabled)
// option, silently un-picking WHICH open medication the person meant to
// close. `occurredAt`, `reason`, and `notes` are controlled text-ish inputs
// and already survive on their own.
//
// Real submit via `form.requestSubmit()` — see
// __tests__/react19-form-reset-contract.test.tsx for why a dispatched event
// does not exercise React 19's reset.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MedicationEndForm } from "./MedicationEndForm";

afterEach(cleanup);

const OPEN_MEDICATIONS = [
  { id: "med-1", drugName: "Amoxicilina", startedDate: "2026-05-01" },
  { id: "med-2", drugName: "Meloxicam", startedDate: "2026-05-10" },
];

describe("<MedicationEndForm> — survives the React 19 post-error reset", () => {
  it("keeps the medication select, reason, notes, and date after a rejected submit", async () => {
    const action = vi.fn(async () => ({ error: "No se pudo cerrar la medicación." }));
    const { container } = render(
      <MedicationEndForm action={action} openMedications={OPEN_MEDICATIONS} />,
    );

    const med = container.querySelector(
      'select[name="medicationStartedEventId"]',
    ) as HTMLSelectElement;
    const occurredAt = container.querySelector('input[name="occurredAt"]') as HTMLInputElement;
    const reason = container.querySelector('input[name="reason"]') as HTMLInputElement;
    const notes = container.querySelector('textarea[name="notes"]') as HTMLTextAreaElement;
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.change(med, { target: { value: "med-2" } });
    fireEvent.change(occurredAt, { target: { value: "2026-06-01" } });
    fireEvent.change(reason, { target: { value: "Tratamiento completo" } });
    fireEvent.change(notes, { target: { value: "Sin efectos adversos." } });

    form.requestSubmit();
    await waitFor(() => expect(action).toHaveBeenCalled());
    await screen.findByText("No se pudo cerrar la medicación.");

    expect(occurredAt.value).toBe("2026-06-01");
    expect(reason.value).toBe("Tratamiento completo");
    expect(notes.value).toBe("Sin efectos adversos.");
    // Re-queried: the select's `key` change remounts it, so the earlier node
    // is detached — that remount is the fix, not an artifact to work around.
    expect(
      (container.querySelector('select[name="medicationStartedEventId"]') as HTMLSelectElement)
        .value,
    ).toBe("med-2");
  });
});

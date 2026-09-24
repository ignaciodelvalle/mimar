// @vitest-environment jsdom
//
// SymptomForm's "severity" <LnSelect> was genuinely controlled
// (`value=`+`onChange=`) — the exact shape react19-form-reset-contract.test.tsx
// measures as unsafe regardless: a rejected submit falls a controlled select
// back to its first option, discarding how bad the person thought the
// symptom was. `freeText` and `onsetAt` are controlled text-ish inputs and
// already survive on their own.
//
// Real submit via `form.requestSubmit()` — see
// __tests__/react19-form-reset-contract.test.tsx for why a dispatched event
// does not exercise React 19's reset.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SymptomForm } from "./SymptomForm";

afterEach(cleanup);

describe("<SymptomForm> — survives the React 19 post-error reset", () => {
  it("keeps the severity select and the typed fields after a rejected submit", async () => {
    const action = vi.fn(async () => ({ error: "No se pudo registrar el síntoma." }));
    const { container } = render(<SymptomForm action={action} petName="Pampa" />);

    const freeText = container.querySelector('textarea[name="freeText"]') as HTMLTextAreaElement;
    const severity = container.querySelector('select[name="severity"]') as HTMLSelectElement;
    const onsetAt = container.querySelector('input[name="onsetAt"]') as HTMLInputElement;
    const form = container.querySelector("form") as HTMLFormElement;

    expect(severity.value).toBe(""); // mount default

    fireEvent.change(freeText, { target: { value: "Vomita hace dos días y está decaída." } });
    fireEvent.change(severity, { target: { value: "severe" } });
    fireEvent.change(onsetAt, { target: { value: "2026-06-01" } });

    form.requestSubmit();
    await waitFor(() => expect(action).toHaveBeenCalled());
    await screen.findByText("No se pudo registrar el síntoma.");

    expect(freeText.value).toBe("Vomita hace dos días y está decaída.");
    expect(onsetAt.value).toBe("2026-06-01");
    // Re-queried: the select's `key` change remounts it, so the earlier node
    // is detached — that remount is the fix, not an artifact to work around.
    expect((container.querySelector('select[name="severity"]') as HTMLSelectElement).value).toBe(
      "severe",
    );
  });
});

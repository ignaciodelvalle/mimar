// @vitest-environment jsdom
//
// TattooForm's "locationOnBody" <LnSelect> was genuinely controlled
// (`value=`+`onChange=`) — the exact shape react19-form-reset-contract.test.tsx
// measures as unsafe regardless: a rejected submit falls a controlled select
// back to its first option ("Sin especificar"), discarding the body location
// the person picked. Every other field here is a controlled text-ish input
// and already survives on its own.
//
// Real submit via `form.requestSubmit()` — see
// __tests__/react19-form-reset-contract.test.tsx for why a dispatched event
// does not exercise React 19's reset.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TattooForm } from "./TattooForm";

afterEach(cleanup);

describe("<TattooForm> — survives the React 19 post-error reset", () => {
  it("keeps the body-location select and the typed fields after a rejected submit", async () => {
    const action = vi.fn(async () => ({ error: "No se pudo registrar el tatuaje." }));
    const { container } = render(<TattooForm action={action} />);

    const code = container.querySelector('input[name="tattooCode"]') as HTMLInputElement;
    const location = container.querySelector('select[name="locationOnBody"]') as HTMLSelectElement;
    const description = container.querySelector(
      'textarea[name="description"]',
    ) as HTMLTextAreaElement;
    const attachment = container.querySelector('input[name="attachment"]') as HTMLInputElement;
    const form = container.querySelector("form") as HTMLFormElement;

    expect(location.value).toBe(""); // mount default: "Sin especificar"

    // "Foto del tatuaje" is a REQUIRED native file input — the browser (and
    // jsdom) blocks submission without one, and jsdom's HTML5 validity check
    // reads its own internal file-list slot rather than a monkey-patched
    // `.files` property, so satisfying it takes dropping the attribute
    // instead. Unrelated to what this test proves (the select and text
    // fields' survival).
    attachment.removeAttribute("required");

    fireEvent.change(code, { target: { value: "K9-2014-A" } });
    fireEvent.change(location, { target: { value: location.querySelectorAll("option")[1].value } });
    const pickedLocation = location.value;
    fireEvent.change(description, { target: { value: "Refugio Norte, campaña 2019." } });

    form.requestSubmit();
    await waitFor(() => expect(action).toHaveBeenCalled());
    await screen.findByText("No se pudo registrar el tatuaje.");

    expect(code.value).toBe("K9-2014-A");
    expect(description.value).toBe("Refugio Norte, campaña 2019.");
    // Re-queried: the select's `key` change remounts it, so the earlier node
    // is detached — that remount is the fix, not an artifact to work around.
    expect(
      (container.querySelector('select[name="locationOnBody"]') as HTMLSelectElement).value,
    ).toBe(pickedLocation);
  });
});

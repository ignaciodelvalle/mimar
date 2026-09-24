// @vitest-environment jsdom
//
// NoteForm's "category" <LnSelect> was genuinely controlled (`value=`+
// `onChange=`) — the exact shape react19-form-reset-contract.test.tsx measures
// as unsafe regardless: a rejected submit falls a controlled select back to
// its first option ("No especificar"), silently discarding the category the
// person picked. `text` and `occurredAt` are also controlled but ARE safe —
// React keeps a controlled text/textarea's DOM default in sync on every
// update, which is why this fix touches only the select.
//
// Real submit via `form.requestSubmit()` — see
// __tests__/react19-form-reset-contract.test.tsx for why a dispatched event
// does not exercise React 19's reset.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NoteForm } from "./NoteForm";

beforeEach(() => {
  // The note text has `autoFocus`, and LnField's onFocus checks
  // `window.matchMedia` (mobile-focus-scroll) — jsdom has no implementation
  // of it (same stub as SheetHost.interaction.test.tsx).
  window.matchMedia =
    window.matchMedia ??
    ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    }));
});

afterEach(cleanup);

describe("<NoteForm> — survives the React 19 post-error reset", () => {
  it("keeps the category select, the note text, and the date after a rejected submit", async () => {
    const action = vi.fn(async () => ({ error: "No se pudo guardar la nota." }));
    const { container } = render(<NoteForm action={action} />);

    const text = container.querySelector('textarea[name="text"]') as HTMLTextAreaElement;
    const category = container.querySelector('select[name="category"]') as HTMLSelectElement;
    const occurredAt = container.querySelector('input[name="occurredAt"]') as HTMLInputElement;
    const form = container.querySelector("form") as HTMLFormElement;

    expect(category.value).toBe(""); // mount default: "No especificar"

    fireEvent.change(text, { target: { value: "Empezó a comer distinto esta semana." } });
    fireEvent.change(category, { target: { value: "dieta" } });
    fireEvent.change(occurredAt, { target: { value: "2026-06-01" } });

    form.requestSubmit();
    await waitFor(() => expect(action).toHaveBeenCalled());
    await screen.findByText("No se pudo guardar la nota.");

    expect(text.value).toBe("Empezó a comer distinto esta semana.");
    expect(occurredAt.value).toBe("2026-06-01");
    // Re-queried: the select's `key` change remounts it, so the earlier node
    // is detached — that remount is the fix, not an artifact to work around.
    expect((container.querySelector('select[name="category"]') as HTMLSelectElement).value).toBe(
      "dieta",
    );
  });
});

// @vitest-environment jsdom
//
// WeightForm's "kg"/"occurredAt"/"notes" all had a STATIC defaultValue
// derived from `defaults` — a rejected submit put back the ORIGINAL
// defaults, discarding whatever the owner had just typed.
//
// Real submit via `form.requestSubmit()` — see
// __tests__/react19-form-reset-contract.test.tsx for why a dispatched event
// does not exercise React 19's reset.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ui/use-action-redirect", () => ({
  useActionRedirect: vi.fn(),
}));
vi.mock("@/lib/ui/use-idempotency-key", () => ({
  useIdempotencyKey: () => ({ key: "test-idempotency-key" }),
}));

import { WeightForm } from "./WeightForm";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("<WeightForm> — survives the React 19 post-error reset", () => {
  it("keeps the typed weight, date, and notes after a rejected submit", async () => {
    const action = vi.fn(async () => ({ error: "No se pudo registrar el peso." }));
    const { container } = render(<WeightForm action={action} />);

    const kg = container.querySelector('input[name="kg"]') as HTMLInputElement;
    const occurredAt = container.querySelector('input[name="occurredAt"]') as HTMLInputElement;
    const notes = container.querySelector('textarea[name="notes"]') as HTMLTextAreaElement;
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.change(kg, { target: { value: "14.2" } });
    fireEvent.change(occurredAt, { target: { value: "2026-01-15" } });
    fireEvent.change(notes, { target: { value: "Pesada en la veterinaria del barrio." } });

    form.requestSubmit();
    await waitFor(() => expect(action).toHaveBeenCalled());
    await screen.findByText("No se pudo registrar el peso.");

    expect((container.querySelector('input[name="kg"]') as HTMLInputElement).value).toBe("14.2");
    expect((container.querySelector('input[name="occurredAt"]') as HTMLInputElement).value).toBe(
      "2026-01-15",
    );
    expect((container.querySelector('textarea[name="notes"]') as HTMLTextAreaElement).value).toBe(
      "Pesada en la veterinaria del barrio.",
    );
  });
});

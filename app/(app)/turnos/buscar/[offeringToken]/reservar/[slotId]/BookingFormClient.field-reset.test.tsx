// @vitest-environment jsdom
//
// BookingFormClient's "petId" is an uncontrolled <select> — a rejected
// submit (e.g. "Sin cupo disponible.") falls it back to its first (empty)
// option, discarding whichever pet was chosen.
//
// Real submit via `form.requestSubmit()` — see
// __tests__/react19-form-reset-contract.test.tsx for why a dispatched event
// does not exercise React 19's reset.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bookSlotMock = vi.fn();
vi.mock("@/app/actions/booking", () => ({
  bookSlotAction: (...args: unknown[]) => bookSlotMock(...args),
}));

vi.mock("@/lib/ui/use-action-redirect", () => ({
  useActionRedirect: vi.fn(),
}));

import { BookingFormClient } from "./BookingFormClient";

const USER_PETS = [
  { id: "pet-1", name: "Firulais", species: "dog" },
  { id: "pet-2", name: "Michi", species: "cat" },
];

beforeEach(() => {
  bookSlotMock.mockReset();
});

afterEach(cleanup);

describe("<BookingFormClient> — survives the React 19 post-error reset", () => {
  it("keeps the picked pet after a rejected submit", async () => {
    bookSlotMock.mockResolvedValue({ error: "Sin cupo disponible." });
    const { container } = render(<BookingFormClient slotId="slot-test-1" userPets={USER_PETS} />);

    const petSelect = container.querySelector('select[name="petId"]') as HTMLSelectElement;
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.change(petSelect, { target: { value: "pet-2" } });

    form.requestSubmit();
    await waitFor(() => expect(bookSlotMock).toHaveBeenCalled());
    await screen.findByText("Sin cupo disponible.");

    expect((container.querySelector('select[name="petId"]') as HTMLSelectElement).value).toBe(
      "pet-2",
    );
  });
});

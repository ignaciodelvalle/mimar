// @vitest-environment jsdom
//
// A booked slot must land on the appointment even when the action's own
// refresh has already replaced the booking form (2026-10-06).
//
// bookSlotAction revalidates, so its response re-renders this route, and the
// reservar page calls notFound() once bookingsCount >= capacity. Capacity
// defaults to 1, so a successful booking is exactly what fills the slot: the
// form is unmounted by the 404 render. Its navigation used to be an effect on
// the action state (useActionRedirect), which an unmounted form never runs —
// the booking went through and the owner saw a 404. The test lands the
// unmount BEFORE the action result, the order that lost the navigation.
//
// Real submit via `form.requestSubmit()` (see BookingFormClient.field-reset).

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bookSlotAction: vi.fn(),
  navigateAfterActionSuccess: vi.fn(),
}));

vi.mock("@/app/actions/booking", () => ({
  bookSlotAction: (...args: unknown[]) => mocks.bookSlotAction(...args),
}));
vi.mock("@/lib/ui/full-page-action-nav", () => ({
  navigateAfterActionSuccess: mocks.navigateAfterActionSuccess,
}));

import { BookingFormClient } from "./BookingFormClient";

const USER_PETS = [{ id: "pet-1", name: "Firulais", species: "dog" }];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function submit(container: HTMLElement) {
  fireEvent.change(container.querySelector('select[name="petId"]') as HTMLSelectElement, {
    target: { value: "pet-1" },
  });
  (container.querySelector("form") as HTMLFormElement).requestSubmit();
}

describe("<BookingFormClient> — success is a navigation that survives the 404 re-render", () => {
  it("navigates to the appointment after the refresh unmounted the form", async () => {
    let resolveResult!: (value: unknown) => void;
    mocks.bookSlotAction.mockImplementation(
      () =>
        new Promise((r) => {
          resolveResult = r;
        }),
    );
    const view = render(<BookingFormClient slotId="slot-1" userPets={USER_PETS} />);
    submit(view.container);
    await waitFor(() => expect(mocks.bookSlotAction).toHaveBeenCalledWith("slot-1", "pet-1"));

    // The slot is full now: the page's re-render is a 404 and the form is gone…
    view.unmount();
    // …then the action's result arrives.
    await act(async () => {
      resolveResult({ ok: true, appointmentToken: "APT-1", redirectTo: "/mis-turnos/APT-1" });
    });

    expect(mocks.navigateAfterActionSuccess).toHaveBeenCalledWith("/mis-turnos/APT-1");
  });

  it("does not navigate when the slot is taken, and says so", async () => {
    mocks.bookSlotAction.mockResolvedValue({ error: "Sin cupo disponible." });
    const view = render(<BookingFormClient slotId="slot-1" userPets={USER_PETS} />);
    submit(view.container);
    await screen.findByText("Sin cupo disponible.");
    expect(mocks.navigateAfterActionSuccess).not.toHaveBeenCalled();
  });
});

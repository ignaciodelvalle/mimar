// @vitest-environment jsdom
//
// FutureLedgerList — the libreta face's PRÓXIMO section (tarjeta-todo).
// Reminder rows carry the actions that used to live in the under-card
// RemindersSection: "Posponer 7 días" (snoozeReminderAction, row hides on
// success, stays with an inline error otherwise) and "Registrar" (the
// canonical reminder-linked vaccine form URL). "Ver turno" / "Programar
// turno" behavior is unchanged. The server actions are mocked — this file
// exercises the wiring, not the actions themselves.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { snooze } = vi.hoisted(() => ({ snooze: vi.fn() }));
vi.mock("@/app/actions/reminders", () => ({ snoozeReminderAction: snooze }));
vi.mock("@/src/modules/events/actions", () => ({
  markMedicationDoseTakenAction: vi.fn(),
}));

import { FutureLedgerList } from "./FutureLedgerList";
import type { FutureLedgerItem } from "./libreta-future.helpers";

const PET_TOKEN = "DIM-AAAA-BBBB";

function reminderItem(overrides: Partial<FutureLedgerItem> = {}): FutureLedgerItem {
  return {
    id: "reminder-r1",
    kind: "reminder",
    label: "Antirrábica",
    dueAt: new Date("2026-08-01T12:00:00Z"),
    reminderId: "r1",
    ...overrides,
  };
}

function appointmentItem(): FutureLedgerItem {
  return {
    id: "appt-apt1",
    kind: "appointment",
    label: "Control clínico",
    dueAt: new Date("2026-08-05T12:00:00Z"),
    action: { type: "reschedule", href: "/mis-turnos/apt1" },
  };
}

afterEach(() => {
  cleanup();
  snooze.mockReset();
});

describe("FutureLedgerList — reminder row actions (moved from the under-card blocks)", () => {
  it("renders Posponer 7 días and a reminder-linked Registrar on reminder rows", () => {
    render(<FutureLedgerList items={[reminderItem()]} petPublicToken={PET_TOKEN} />);

    expect(screen.getByRole("button", { name: "Posponer 7 días" })).toBeInTheDocument();
    const registrar = screen.getByRole("link", { name: "Registrar" });
    // The canonical reminder-linked path — closes the reminder on submit.
    expect(registrar).toHaveAttribute(
      "href",
      `/mis-mascotas/${PET_TOKEN}/eventos/nuevo/vacuna?reminderId=r1`,
    );
  });

  it("keeps Programar turno on a due rabies reminder row, alongside the new actions", () => {
    render(
      <FutureLedgerList
        items={[reminderItem({ action: { type: "programar-turno" } })]}
        petPublicToken={PET_TOKEN}
      />,
    );

    expect(screen.getByRole("link", { name: "Programar turno" })).toHaveAttribute(
      "href",
      `/mis-mascotas/${PET_TOKEN}?sheet=turno-antirrabica`,
    );
    expect(screen.getByRole("button", { name: "Posponer 7 días" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Registrar" })).toBeInTheDocument();
  });

  it("keeps appointment rows unchanged — Ver turno only, no reminder actions", () => {
    render(<FutureLedgerList items={[appointmentItem()]} petPublicToken={PET_TOKEN} />);

    expect(screen.getByRole("link", { name: /Ver turno/ })).toHaveAttribute(
      "href",
      "/mis-turnos/apt1",
    );
    expect(screen.queryByRole("button", { name: "Posponer 7 días" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Registrar" })).toBeNull();
  });

  it("hides the row after a successful snooze (optimistic-terminal, no re-fetch)", async () => {
    snooze.mockResolvedValue({ ok: true, snoozedUntil: "2026-08-08", snoozeCount: 1 });
    render(
      <FutureLedgerList items={[reminderItem(), appointmentItem()]} petPublicToken={PET_TOKEN} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Posponer 7 días" }));

    await waitFor(() => {
      expect(screen.queryByText("Antirrábica")).toBeNull();
    });
    expect(snooze).toHaveBeenCalledWith("r1");
    // The other rows survive.
    expect(screen.getByText("Control clínico")).toBeInTheDocument();
  });

  it("keeps the row and surfaces the error when the snooze fails", async () => {
    snooze.mockResolvedValue({ ok: false, error: "No se pudo posponer el recordatorio." });
    render(<FutureLedgerList items={[reminderItem()]} petPublicToken={PET_TOKEN} />);

    fireEvent.click(screen.getByRole("button", { name: "Posponer 7 días" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("No se pudo posponer el recordatorio.");
    });
    expect(screen.getByText("Antirrábica")).toBeInTheDocument();
  });

  it("renders nothing once every row is snoozed away", async () => {
    snooze.mockResolvedValue({ ok: true, snoozedUntil: "2026-08-08", snoozeCount: 1 });
    const { container } = render(
      <FutureLedgerList items={[reminderItem()]} petPublicToken={PET_TOKEN} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Posponer 7 días" }));

    await waitFor(() => {
      expect(container.querySelector("[data-section='future-ledger']")).toBeNull();
    });
  });
});

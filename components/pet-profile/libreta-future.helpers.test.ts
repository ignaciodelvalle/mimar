import { describe, expect, it } from "vitest";
import { REMINDER_SURFACE_WINDOW_DAYS, mergeFutureLedger } from "./libreta-future.helpers";

describe("mergeFutureLedger", () => {
  it("interleaves reminders, appointments, and doses ascending by dueAt", () => {
    const result = mergeFutureLedger(
      [
        {
          reminderId: "r1",
          title: "Antiparasitario",
          dueAt: new Date("2026-08-10"),
          variant: "upcoming",
        },
      ],
      [
        {
          publicToken: "apt1",
          offeringDisplayName: "Control clínico",
          slotStartsAt: new Date("2026-08-05"),
        },
      ],
      [{ reminderId: "m1", drugName: "Amoxicilina", dueAt: new Date("2026-08-01") }],
    );

    expect(result.map((r) => r.id)).toEqual(["med-m1", "appt-apt1", "reminder-r1"]);
  });

  it("keeps ties stable — original append order (reminders, appointments, doses)", () => {
    const sameDate = new Date("2026-08-01T10:00:00Z");
    const result = mergeFutureLedger(
      [{ reminderId: "r1", title: "Antiparasitario", dueAt: sameDate, variant: "upcoming" }],
      [{ publicToken: "apt1", offeringDisplayName: "Control clínico", slotStartsAt: sameDate }],
      [{ reminderId: "m1", drugName: "Amoxicilina", dueAt: sameDate }],
    );

    expect(result.map((r) => r.id)).toEqual(["reminder-r1", "appt-apt1", "med-m1"]);
  });

  it("returns an empty array when all sources are empty", () => {
    expect(mergeFutureLedger([], [], [])).toEqual([]);
  });

  it("a due rabies reminder row carries the programar-turno action", () => {
    const [item] = mergeFutureLedger(
      [
        {
          reminderId: "r1",
          title: "Vacuna antirrábica",
          dueAt: new Date("2026-08-01"),
          variant: "due_soon",
        },
      ],
      [],
      [],
    );
    expect(item?.action).toEqual({ type: "programar-turno" });
  });

  it("an overdue rabies reminder row carries the programar-turno action", () => {
    const [item] = mergeFutureLedger(
      [
        {
          reminderId: "r1",
          title: "Antirrábica",
          dueAt: new Date("2026-08-01"),
          variant: "overdue_critical",
        },
      ],
      [],
      [],
    );
    expect(item?.action).toEqual({ type: "programar-turno" });
  });

  it("a non-due rabies reminder row does not carry the programar-turno action", () => {
    const [item] = mergeFutureLedger(
      [
        {
          reminderId: "r1",
          title: "Vacuna antirrábica",
          dueAt: new Date("2026-08-01"),
          variant: "upcoming",
        },
      ],
      [],
      [],
    );
    expect(item?.action).toBeUndefined();
  });

  it("a non-rabies reminder never carries the programar-turno action", () => {
    const [item] = mergeFutureLedger(
      [
        {
          reminderId: "r1",
          title: "Antiparasitario",
          dueAt: new Date("2026-08-01"),
          variant: "overdue",
        },
      ],
      [],
      [],
    );
    expect(item?.action).toBeUndefined();
  });

  it("reminder rows carry their source reminderId (powers Posponer/Registrar)", () => {
    const result = mergeFutureLedger(
      [
        {
          reminderId: "r1",
          title: "Antiparasitario",
          dueAt: new Date("2026-08-01"),
          variant: "upcoming",
        },
      ],
      [
        {
          publicToken: "apt1",
          offeringDisplayName: "Control clínico",
          slotStartsAt: new Date("2026-08-05"),
        },
      ],
      [{ reminderId: "m1", drugName: "Amoxicilina", dueAt: new Date("2026-08-10") }],
    );
    const reminder = result.find((r) => r.kind === "reminder");
    expect(reminder?.reminderId).toBe("r1");
    // Non-reminder rows never carry it — Posponer/Registrar are reminder-only.
    expect(result.find((r) => r.kind === "appointment")?.reminderId).toBeUndefined();
    expect(result.find((r) => r.kind === "medication")?.reminderId).toBeUndefined();
  });

  it("medication doses carry a mark-dose action", () => {
    const [item] = mergeFutureLedger(
      [],
      [],
      [{ reminderId: "m1", drugName: "Amoxicilina", dueAt: new Date("2026-08-01") }],
    );
    expect(item?.action).toEqual({ type: "mark-dose", reminderId: "m1" });
  });

  it("appointments carry a reschedule action", () => {
    const [item] = mergeFutureLedger(
      [],
      [
        {
          publicToken: "apt1",
          offeringDisplayName: "Control",
          slotStartsAt: new Date("2026-08-01"),
        },
      ],
      [],
    );
    expect(item?.action).toEqual({ type: "reschedule", href: "/mis-turnos/apt1" });
  });
});

// medianos-sesión-2 finding #2: a freshly-created reminder due ~365 days out
// (the next annual dose, just registered) showed up as an active pendiente
// with "Posponer 7 días" — noise a year early. Only reminders within
// REMINDER_SURFACE_WINDOW_DAYS are useful/actionable TODAY; farther-out
// reminders are real data (their dueAt is untouched) but don't belong in this
// section yet. Appointments/medication doses are untouched by this gate.
describe("mergeFutureLedger — reminder surface window (display-only gate)", () => {
  const now = new Date("2026-07-18T12:00:00Z");

  function daysFromNow(days: number): Date {
    return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  }

  it("a reminder ~365 days out is not surfaced", () => {
    const result = mergeFutureLedger(
      [{ reminderId: "r1", title: "Antirrábica", dueAt: daysFromNow(365), variant: "upcoming" }],
      [],
      [],
      now,
    );
    expect(result).toEqual([]);
  });

  it("a reminder ~20 days out is surfaced (within the window)", () => {
    const result = mergeFutureLedger(
      [{ reminderId: "r1", title: "Antirrábica", dueAt: daysFromNow(20), variant: "upcoming" }],
      [],
      [],
      now,
    );
    expect(result.map((r) => r.id)).toEqual(["reminder-r1"]);
    // reminderId (powers the "Posponer 7 días" action) survives the gate.
    expect(result[0]?.reminderId).toBe("r1");
  });

  it("a reminder exactly at the window boundary is surfaced; one day past is not", () => {
    const atBoundary = mergeFutureLedger(
      [
        {
          reminderId: "r1",
          title: "Antiparasitario",
          dueAt: daysFromNow(REMINDER_SURFACE_WINDOW_DAYS),
          variant: "upcoming",
        },
      ],
      [],
      [],
      now,
    );
    expect(atBoundary).toHaveLength(1);

    const pastBoundary = mergeFutureLedger(
      [
        {
          reminderId: "r1",
          title: "Antiparasitario",
          dueAt: daysFromNow(REMINDER_SURFACE_WINDOW_DAYS + 1),
          variant: "upcoming",
        },
      ],
      [],
      [],
      now,
    );
    expect(pastBoundary).toEqual([]);
  });

  it("an overdue reminder is always surfaced, however far in the past", () => {
    const result = mergeFutureLedger(
      [
        {
          reminderId: "r1",
          title: "Antirrábica",
          dueAt: daysFromNow(-400),
          variant: "overdue_critical",
        },
      ],
      [],
      [],
      now,
    );
    expect(result.map((r) => r.id)).toEqual(["reminder-r1"]);
  });

  it("appointments and medication doses far in the future are unaffected by the reminder gate", () => {
    const result = mergeFutureLedger(
      [],
      [
        {
          publicToken: "apt1",
          offeringDisplayName: "Control anual",
          slotStartsAt: daysFromNow(365),
        },
      ],
      [{ reminderId: "m1", drugName: "Amoxicilina", dueAt: daysFromNow(365) }],
      now,
    );
    expect(result.map((r) => r.id).sort()).toEqual(["appt-apt1", "med-m1"]);
  });
});

// Pure helper for Face 2 (Libreta)'s PRÓXIMO section — merges active
// reminders, confirmed appointments, and pending medication doses into a
// single ascending-by-dueAt ledger. Uncapped variant of
// components/PetUpcomingCareSection.helpers.ts's mergeUpcomingItems (that one
// caps at 5 + hasMore for the old Resumen tab widget; Face 2's PRÓXIMO section
// shows every future item, so no cap here).
import { isRabiesVaccineName } from "@/lib/reference/lookups";

export type FutureLedgerAction =
  | { type: "mark-dose"; reminderId: string }
  | { type: "reschedule"; href: string }
  | { type: "programar-turno" };

export type FutureLedgerItem = {
  id: string;
  kind: "reminder" | "appointment" | "medication";
  label: string;
  dueAt: Date;
  action?: FutureLedgerAction;
  /**
   * The source reminder id — present on `kind: "reminder"` rows only. Powers
   * the per-row "Posponer 7 días" / "Registrar" actions (tarjeta-todo: the
   * libreta's PRÓXIMO section absorbed the actions of the deleted under-card
   * RemindersSection, so reminder rows must reach the same server action and
   * the canonical reminder-linked vaccine URL).
   */
  reminderId?: string;
  /**
   * `kind: "medication"` rows only: how many doses of this course are still
   * pending, the one this row names included. One course is ONE row (see
   * `collapseMedicationCourses`), so this is what is left of the course's
   * flood of per-dose rows.
   */
  remainingDoses?: number;
  /**
   * `kind: "medication"` rows only: how many of `remainingDoses` were due
   * before `now` and never marked. "quedan 5 dosis" alone read as five doses
   * AHEAD when three of them were already late.
   */
  overdueDoses?: number;
};

export type FutureReminderInput = {
  reminderId: string;
  title: string;
  dueAt: Date;
  /** Reminder urgency variant (from getReminderVariant) — used to detect a due/over rabies row. */
  variant: string;
};

export type FutureAppointmentInput = {
  publicToken: string;
  offeringDisplayName: string;
  slotStartsAt: Date;
};

export type FutureMedicationDoseInput = {
  reminderId: string;
  /** The drug's own name — NOT the reminder's stored "<drug> – Dosis" title. */
  drugName: string;
  dueAt: Date;
  /**
   * The course this dose belongs to: the `medication_started` event that
   * scheduled it (`reminders.source_event_id`). Null or absent means the dose
   * cannot be tied to a course, and it stays a row of its own.
   */
  courseId?: string | null;
};

// Rabies is recognised by THE shared matcher (isRabiesVaccineName, folded for
// accents and case) — one rule across every surface (surface audit 2026-10-07).
const DUE_OR_OVER_VARIANTS = new Set(["due_soon", "overdue", "overdue_critical"]);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Horizon (days) within which a reminder is a USEFUL, actionable pendiente in
 * the libreta's PRÓXIMO section. A freshly-registered annual dose's reminder
 * is due ~365 days out — real data, but showing it as an active pendiente
 * with "Posponer 7 días" is noise a year early (medianos-sesión-2 finding #2:
 * a fresh reminder read "vence en 365 días" right next to the snooze action).
 * Overdue reminders (negative days) always count as within window — they are
 * the most urgent, never "too far out". This gate is DISPLAY-ONLY: the
 * reminder's `dueAt` is untouched, and a reminder outside the window is still
 * a real reminder — it simply doesn't clutter this section until it becomes
 * useful. Distinct from `PROXIMOS_HORIZON_DAYS` (vaccine-reminder-state.ts,
 * 60 days) — that constant gates the /inicio greeting's "N vencimientos
 * próximos" COUNTER, a different surface with a different design call.
 */
export const REMINDER_SURFACE_WINDOW_DAYS = 30;

/**
 * ONE ROW PER MEDICATION COURSE, not one per dose.
 *
 * A course scheduled every 12 hours for ten days writes twenty dose reminders,
 * and the PRÓXIMO section used to list all twenty — the same drug name twenty
 * times, burying the reminder and the turno around it (seen on a real phone,
 * 2026-10-07). What the owner can act on is the NEXT dose; the rest of the
 * course is a count.
 *
 * The row is the course's EARLIEST pending dose, overdue or not: a dose that
 * was due yesterday and never marked is exactly the one to surface, and its
 * "Marcar dada" closes it and promotes the next. Doses without a course id
 * cannot be grouped honestly and each stays a row of its own.
 *
 * Done HERE, in the helper both the web page and `/api/v1/.../libreta` read, so
 * every client — including a phone already in people's hands, which renders
 * the server's rows as they come — gets the collapsed list.
 */
export function collapseMedicationCourses(
  doses: FutureMedicationDoseInput[],
  now: Date = new Date(),
): Array<{ next: FutureMedicationDoseInput; remaining: number; overdue: number }> {
  const courses = new Map<string, FutureMedicationDoseInput[]>();
  for (const dose of doses) {
    const key = dose.courseId ? `course:${dose.courseId}` : `dose:${dose.reminderId}`;
    const course = courses.get(key);
    if (course) course.push(dose);
    else courses.set(key, [dose]);
  }
  return [...courses.values()].map((course) => {
    const next = course.reduce((earliest, dose) =>
      dose.dueAt.getTime() < earliest.dueAt.getTime() ? dose : earliest,
    );
    // An INSTANT comparison, not a calendar-day one: a dose every 8 hours that
    // was due this morning is late by this afternoon, even though its day is
    // still "today".
    const overdue = course.filter((dose) => dose.dueAt.getTime() < now.getTime()).length;
    return { next, remaining: course.length, overdue };
  });
}

/**
 * Merges reminders, confirmed appointments, and pending medication doses into
 * one ascending-by-dueAt ledger. Medication doses arrive collapsed to one row
 * per course (`collapseMedicationCourses`). Sort is stable — ties preserve the order in
 * which items were appended (reminders, then appointments, then doses).
 *
 * `now` gates reminders to `REMINDER_SURFACE_WINDOW_DAYS` (see above) —
 * appointments and medication doses are left untouched, their own queries
 * already bound them to near-term/pending rows.
 */
export function mergeFutureLedger(
  reminders: FutureReminderInput[],
  appointments: FutureAppointmentInput[],
  medicationDoses: FutureMedicationDoseInput[],
  now: Date = new Date(),
): FutureLedgerItem[] {
  const reminderItems: FutureLedgerItem[] = reminders
    .filter((r) => {
      const daysUntilDue = Math.round((r.dueAt.getTime() - now.getTime()) / MS_PER_DAY);
      return daysUntilDue <= REMINDER_SURFACE_WINDOW_DAYS;
    })
    .map((r) => {
      const isRabiesDueOrOver = isRabiesVaccineName(r.title) && DUE_OR_OVER_VARIANTS.has(r.variant);
      return {
        id: `reminder-${r.reminderId}`,
        kind: "reminder" as const,
        label: r.title,
        dueAt: r.dueAt,
        action: isRabiesDueOrOver ? ({ type: "programar-turno" } as const) : undefined,
        reminderId: r.reminderId,
      };
    });

  const appointmentItems: FutureLedgerItem[] = appointments.map((a) => ({
    id: `appt-${a.publicToken}`,
    kind: "appointment",
    label: a.offeringDisplayName,
    dueAt: a.slotStartsAt,
    action: { type: "reschedule", href: `/mis-turnos/${a.publicToken}` },
  }));

  const medicationItems: FutureLedgerItem[] = collapseMedicationCourses(medicationDoses, now).map(
    ({ next, remaining, overdue }) => ({
      id: `med-${next.reminderId}`,
      kind: "medication",
      label: next.drugName,
      dueAt: next.dueAt,
      action: { type: "mark-dose", reminderId: next.reminderId },
      remainingDoses: remaining,
      overdueDoses: overdue,
    }),
  );

  return [...reminderItems, ...appointmentItems, ...medicationItems].sort(
    (a, b) => a.dueAt.getTime() - b.dueAt.getTime(),
  );
}

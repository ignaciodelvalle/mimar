// Pure helper for Face 2 (Libreta)'s PRÓXIMO section — merges active
// reminders, confirmed appointments, and pending medication doses into a
// single ascending-by-dueAt ledger. Uncapped variant of
// components/PetUpcomingCareSection.helpers.ts's mergeUpcomingItems (that one
// caps at 5 + hasMore for the old Resumen tab widget; Face 2's PRÓXIMO section
// shows every future item, so no cap here).

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
  drugName: string;
  dueAt: Date;
};

const RABIES_TITLE_RE = /antirr[aá]b|rabi/i;
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
 * Merges reminders, confirmed appointments, and pending medication doses into
 * one ascending-by-dueAt ledger. Sort is stable — ties preserve the order in
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
      const isRabiesDueOrOver =
        RABIES_TITLE_RE.test(r.title) && DUE_OR_OVER_VARIANTS.has(r.variant);
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

  const medicationItems: FutureLedgerItem[] = medicationDoses.map((d) => ({
    id: `med-${d.reminderId}`,
    kind: "medication",
    label: d.drugName,
    dueAt: d.dueAt,
    action: { type: "mark-dose", reminderId: d.reminderId },
  }));

  return [...reminderItems, ...appointmentItems, ...medicationItems].sort(
    (a, b) => a.dueAt.getTime() - b.dueAt.getTime(),
  );
}

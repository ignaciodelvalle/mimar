// Client-input contract for the vaccine reminder pair —
// `POST /api/v1/pets/{publicToken}/reminders`.
//
// THE OTHER HALF OF A CAPABILITY THE APP COULD ONLY READ. `OwnerPetRemindersSection`
// (owner-pet-detail.ts) already lists a pet's open vaccine reminders; this door
// is what schedules one and what cancels one. Both commands reach the IDENTICAL
// use-cases the web calls — `createVaccineReminder` and `deleteVaccineReminder`
// under `src/modules/pets/application/reminders/` — rather than a parallel
// implementation, so a phone and a browser scheduling the same booster cannot
// drift into two notions of what counts as a duplicate.
//
// ONE COMMAND SET, TWO OPERATIONS ON ONE ROW — the shape `share.ts` and
// `pet-move.ts` already use for a create/cancel pair on a single URL rather
// than two routes each re-declaring their own guard and limiter.
//
// WHO MAY RUN EITHER COMMAND is the web's own door, read verbatim rather than
// narrowed: `createVaccineReminderAction` and `deleteVaccineReminderAction`
// (app/actions/reminders.ts) both guard with `requireOwnedPetByToken`, which
// resolves to `requirePetAccess` — EVERY current holder (owner, co-owner,
// foster or caretaker on the person path; any org member on the org path),
// with no capability probe and no alive-only gate. A caretaker who can
// schedule a booster on the web must be able to do the same from the phone.
//
// NO CAP ON `vaccineName` / `description`, matching `record-event.ts`'s own
// free-text fields (vaccination, deworming, notes …) — none of them invent a
// length limit the web's own `<input>`/`<textarea>` does not have.

import { z } from "zod";
import { isRealArDay } from "./ar-calendar-day.ts";

/** `"YYYY-MM-DD"` — what `<input type="date">` posts. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const VACCINE_REMINDER_COMMAND_INPUT_CODES = [
  "COMMAND_REQUIRED",
  "VACCINE_NAME_REQUIRED",
  "DUE_AT_REQUIRED",
  "DUE_AT_MALFORMED",
  "DUE_AT_INVALID",
  "REMINDER_ID_REQUIRED",
] as const;
export type VaccineReminderCommandInputCode = (typeof VACCINE_REMINDER_COMMAND_INPUT_CODES)[number];

/** An optional free-text field: absent, blank and `null` all mean "not stated". */
const optionalDescription = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v ? v : null));

/**
 * Schedule a vaccine reminder.
 *
 * `dueAt` IS HELD TO THE SAME CALENDAR `record-event.ts` uses for `occurredAt` —
 * a regex alone accepts `"2026-02-31"` and `new Date` rolls it over to 3 March
 * with nothing reporting a substitution (see `ar-calendar-day.ts`'s header). The
 * web's own `createVaccineReminder` use-case does not catch that (`parseDateInput`
 * accepts it silently); refusing it at this edge is a narrowing in the SAFE
 * direction, the same one `record-event.ts`'s own schema already makes over its
 * writers' looser parsing.
 */
const createVaccineReminder = z.object({
  command: z.literal("create_vaccine_reminder"),
  vaccineName: z
    .string({ error: "VACCINE_NAME_REQUIRED" })
    .trim()
    .min(1, { error: "VACCINE_NAME_REQUIRED" }),
  dueAt: z
    .string({ error: "DUE_AT_REQUIRED" })
    .trim()
    .min(1, { error: "DUE_AT_REQUIRED" })
    .regex(ISO_DATE_RE, { error: "DUE_AT_MALFORMED" })
    .refine(isRealArDay, { error: "DUE_AT_INVALID" }),
  description: optionalDescription,
});

/**
 * Cancel a vaccine reminder, by the ROW id — the same handle
 * `deleteVaccineReminderAction` takes off the web's own delete button.
 */
const cancelVaccineReminder = z.object({
  command: z.literal("cancel_vaccine_reminder"),
  reminderId: z.uuid({ error: "REMINDER_ID_REQUIRED" }),
});

export const vaccineReminderCommandInputSchema = z.discriminatedUnion("command", [
  createVaccineReminder,
  cancelVaccineReminder,
]);

export type VaccineReminderCommandInput = z.infer<typeof vaccineReminderCommandInputSchema>;
export type VaccineReminderCommand = VaccineReminderCommandInput["command"];

/**
 * The FIRST input code in a failed parse, for a client that wants to show one
 * message. Mirrors `firstPetMoveCommandInputCode` — same shape, same reason.
 */
export function firstVaccineReminderCommandInputCode(
  error: z.ZodError<unknown>,
): VaccineReminderCommandInputCode | null {
  for (const issue of error.issues) {
    const code = issue.message;
    if ((VACCINE_REMINDER_COMMAND_INPUT_CODES as readonly string[]).includes(code)) {
      return code as VaccineReminderCommandInputCode;
    }
  }
  for (const issue of error.issues) {
    if (issue.code === "invalid_union" || issue.path.length === 0 || issue.path[0] === "command") {
      return "COMMAND_REQUIRED";
    }
  }
  return null;
}

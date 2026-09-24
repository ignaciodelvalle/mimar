// P4 plausibility layer — shared IMPOSSIBLE-date guard for event writers.
//
// PO-approved semantics (2026-07-08):
//   IMPOSSIBLE → reject (this helper):
//     - occurred_at in the future, beyond a small clock-skew tolerance.
//     - occurred_at before the pet's known date_of_birth.
//   SUSPICIOUS → warn-but-allow (NOT this helper — see the same-day duplicate
//     check in src/modules/events/actions.ts for vaccination/deworming).
//
// Pure function — no DB access. Callers (the events action edge) map the
// returned error code to es-AR copy consistent with their own action's
// existing error strings, and are responsible for fetching pet.dateOfBirth.
// `checkOccurredAtPlausible` below is the shared date-only wrapper every
// action edge wires (owner, atender, pregnancy/tattoo/microchip shims,
// intake) so the copy cannot drift between surfaces.

import { isoDateInAr, todayIsoInAr } from "@/lib/utils/format";

/** Tolerance for client/server clock skew — a device a few minutes fast must
 * not bounce a legitimate "just now" submission. */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

export type PlausibilityErrorCode = "FUTURE_DATE" | "BEFORE_BIRTH";

export type AssertOccurredAtPlausibleInput = {
  occurredAt: Date;
  /**
   * Set when `occurredAt` came from a date-only input (`<input type="date">`
   * parsed via `parseDateInput`, which anchors the day at NOON UTC = 09:00 AR).
   * A date-only value carries no wall-clock intent, so the future check must
   * compare ARGENTINE CALENDAR DAYS, not instants: comparing the noon-UTC
   * anchor against `now` rejects every same-day submission made before
   * 09:05 AR ("La fecha no puede ser futura" for TODAY's date). The
   * BEFORE_BIRTH branch is unaffected — both sides use the same noon anchor.
   */
  isDateOnly?: boolean;
  /** pets.date_of_birth — "YYYY-MM-DD" (Drizzle `date` column, string mode) or null/undefined when unknown. */
  petDateOfBirth?: string | null;
  /** Injectable for tests; defaults to the real wall clock. */
  now?: Date;
};

export type AssertOccurredAtPlausibleResult =
  | { ok: true }
  | { ok: false; error: PlausibilityErrorCode };

export function assertOccurredAtPlausible(
  input: AssertOccurredAtPlausibleInput,
): AssertOccurredAtPlausibleResult {
  const { occurredAt, isDateOnly = false, petDateOfBirth, now = new Date() } = input;

  if (isDateOnly) {
    // Calendar-day comparison in AR: "YYYY-MM-DD" strings sort lexically, so a
    // plain string compare is a correct date compare. Same-day is always
    // plausible regardless of the hour the form is submitted.
    if (isoDateInAr(occurredAt) > todayIsoInAr(now)) {
      return { ok: false, error: "FUTURE_DATE" };
    }
  } else if (occurredAt.getTime() - now.getTime() > CLOCK_SKEW_TOLERANCE_MS) {
    return { ok: false, error: "FUTURE_DATE" };
  }

  if (petDateOfBirth) {
    // Parsed the same way parseDateInput (lib/utils/format.ts) treats a plain
    // "YYYY-MM-DD" input: noon UTC, so a same-day event never trips this on a
    // TZ boundary technicality.
    const dob = new Date(`${petDateOfBirth}T12:00:00Z`);
    if (!Number.isNaN(dob.getTime()) && occurredAt.getTime() < dob.getTime()) {
      return { ok: false, error: "BEFORE_BIRTH" };
    }
  }

  return { ok: true };
}

/** Canonical es-AR copy for the two plausibility rejections — shared by every
 * action edge so the strings stay identical across owner/professional/admin
 * surfaces. */
export function plausibilityErrorMessage(error: PlausibilityErrorCode): string {
  return error === "FUTURE_DATE"
    ? "La fecha no puede ser futura."
    : "La fecha es anterior a la fecha de nacimiento registrada de la mascota.";
}

/**
 * Date-only convenience wrapper for action edges whose occurred-at input is an
 * `<input type="date">` parsed via `parseDateInput` (noon-UTC anchor). Runs the
 * guard in `isDateOnly` mode (Argentine calendar-day compare) and maps the
 * error code to the shared es-AR copy. Returns null when the date is plausible.
 */
export function checkOccurredAtPlausible(
  occurredAt: Date,
  petDateOfBirth: string | null,
): { error: string } | null {
  const result = assertOccurredAtPlausible({ occurredAt, isDateOnly: true, petDateOfBirth });
  return result.ok ? null : { error: plausibilityErrorMessage(result.error) };
}

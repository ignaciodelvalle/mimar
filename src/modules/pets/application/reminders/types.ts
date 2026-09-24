// Types for the reminders use-cases (strangler migration 42/61).

export type ReminderFormState = {
  error: string | null;
  /**
   * Nav contract N3: on success the use-case RETURNS the destination and the
   * calling form performs the navigation (useActionRedirect). It does not call
   * redirect() — the App Router drops a Server Action's own redirect and the
   * user watches nothing happen. See lib/ui/use-action-redirect.ts.
   */
  redirectTo?: string;
  /**
   * The row's id on success — new, or the existing row the idempotency guard
   * recognised. Absent on failure. Added for `POST /api/v1/pets/{token}/reminders`
   * (`app/api/v1/pets/[publicToken]/reminders/commands.ts`), which has no
   * `redirectTo` to navigate and needs the id instead — the web form ignores
   * this field, the same way `enableTier2Public`'s FormData caller ignores
   * fields it did not ask for.
   */
  reminderId?: string;
};

// ---------------------------------------------------------------------------
// snoozeReminderAction — posponer un recordatorio (spec §E)
// ---------------------------------------------------------------------------
// Snooze cap: 3 × 7 days, then a single 30-day snooze (no further increment).
//   snooze_count < 3  → snoozed_until = now + 7d, snooze_count++
//   snooze_count >= 3 → snoozed_until = now + 30d, snooze_count stays at 3

export type SnoozeReminderResult =
  | { ok: true; snoozedUntil: string; snoozeCount: number }
  | { ok: false; error: string };

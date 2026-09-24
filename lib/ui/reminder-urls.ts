// Canonical URL builders for vaccine reminders.
//
// The reminder-linked vaccine form is the single target every reminder CTA
// must open (notification, /inicio ReminderActions, pet-profile
// PetReminders): the full form pre-fills the vaccine name from the reminder
// and closes the reminder on submit. It was hand-rolled at three call sites
// with inconsistent encoding (code review 2026-07-03) — this is the one
// builder they share so the route + param stay in lock-step.

/**
 * URL of the vaccine form linked to a specific reminder. `reminderId` is a
 * uuid so encoding is a no-op, but we encode anyway to stay correct if the
 * id shape ever changes. The target page (eventos/nuevo/vacuna) guards the
 * param with isUuid before querying.
 */
export function buildReminderVaccineUrl(petToken: string, reminderId: string): string {
  return `/mis-mascotas/${petToken}/eventos/nuevo/vacuna?reminderId=${encodeURIComponent(reminderId)}`;
}

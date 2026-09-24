"use server";

// reminders.ts — thin shim (strangler migration 42/61).
//
// Business logic moved to:
//   src/modules/pets/application/reminders/
//
// Auth guards are resolved here and the authenticated context is forwarded to
// the use-cases so they don't need their own session calls.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { requireLiveUser } from "@/lib/infra/live-user";
import { requireOwnedPetByToken } from "@/lib/infra/pets";
import { createVaccineReminder as _create } from "@/src/modules/pets/application/reminders/create-vaccine-reminder";
import { deleteVaccineReminder as _delete } from "@/src/modules/pets/application/reminders/delete-vaccine-reminder";
import { snoozeReminder as _snooze } from "@/src/modules/pets/application/reminders/snooze-reminder";
import type {
  ReminderFormState,
  SnoozeReminderResult,
} from "@/src/modules/pets/application/reminders/types";

// ---------------------------------------------------------------------------
// Type re-exports (erased at runtime — allowed in "use server" files)
// ---------------------------------------------------------------------------

export type { ReminderFormState, SnoozeReminderResult };

// ---------------------------------------------------------------------------
// Action wrappers — auth guard here, use-cases receive authenticated context
// ---------------------------------------------------------------------------

export async function createVaccineReminderAction(
  publicToken: string,
  _previous: ReminderFormState,
  formData: FormData,
): Promise<ReminderFormState> {
  const session = await requireOwnedPetByToken(publicToken);
  if (!session) return { error: "Sesión expirada." };
  return _create(session.user.id, session.pet.id, publicToken, _previous, formData);
}

// Nav contract N3: RETURNS `redirectTo` and `DeleteReminderInlineForm` navigates —
// the App Router can drop an action's own redirect() (check-action-redirect.ts).
// A replayed cancel (row already gone) is still a success (`changed` flag).
export async function deleteVaccineReminderAction(
  publicToken: string,
  reminderId: string,
  _previous: ReminderFormState,
  _formData: FormData,
): Promise<ReminderFormState> {
  const session = await requireOwnedPetByToken(publicToken);
  if (!session) return { error: "Sesión expirada." };
  await _delete(session.pet.id, reminderId);
  return { error: null, redirectTo: `/mis-mascotas/${publicToken}` };
}

export async function snoozeReminderAction(reminderId: string): Promise<SnoozeReminderResult> {
  const live = await requireLiveUser();
  if (!live.ok) return { ok: false, error: live.error };
  const user = live.user;
  return _snooze(reminderId, user.id);
}

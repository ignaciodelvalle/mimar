// Use-case: deleteVaccineReminder — cancel a vaccine reminder (strangler
// migration 42/61).
//
// Auth guard (requireOwnedPetByToken) is enforced by the caller. This
// use-case receives the already-resolved petId, never the public token — nav
// contract N3 (see `types.ts`'s `ReminderFormState`): the destination the web
// navigates to after a successful cancel is `app/actions/reminders.ts`'s own
// concern, and `POST /api/v1/pets/{token}/reminders` has no page to navigate
// to at all. This use-case used to call redirect() itself; moving that call
// out is what let it become the SAME use-case both doors reach — the shape
// `record-post-adoption-checkin.ts`'s header describes as "the remedy the
// other six kinds took".
//
// SCOPED BY petId ONLY, matching the web's own query exactly: this refactor
// changes nothing about who a delete reaches.
//
// IDEMPOTENT BY CONSTRUCTION, and the flag says so rather than the caller
// having to assume it. Deleting an id that matches nothing — because this is
// a retried request, or because it was already cancelled — is a SUCCESS
// (`changed: false`), never "there is no reminder to cancel": a replayed
// cancel must answer the same way as the first.

import { db, reminders } from "@/db";
import { and, eq } from "drizzle-orm";

export type DeleteVaccineReminderResult = {
  /** `false` when no row matched this (petId, reminderId) pair. */
  changed: boolean;
};

export async function deleteVaccineReminder(
  petId: string,
  reminderId: string,
): Promise<DeleteVaccineReminderResult> {
  const deleted = await db
    .delete(reminders)
    .where(and(eq(reminders.id, reminderId), eq(reminders.petId, petId)))
    .returning({ id: reminders.id });

  return { changed: deleted.length > 0 };
}

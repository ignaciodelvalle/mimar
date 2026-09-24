// Use-case: createVaccineReminder — create a vaccine reminder for a pet
// (strangler migration 42/61).
//
// Auth guard (requireOwnedPetByToken) is enforced by the caller (shim). This
// use-case receives the already-resolved userId, petId, and publicToken.

import { db, reminders } from "@/db";
import { parseDateInput } from "@/lib/utils/format";
import { and, eq, isNull } from "drizzle-orm";

import type { ReminderFormState } from "./types";

export async function createVaccineReminder(
  userId: string,
  petId: string,
  publicToken: string,
  _previous: ReminderFormState,
  formData: FormData,
): Promise<ReminderFormState> {
  const vaccineName = String(formData.get("vaccineName") ?? "").trim();
  const dueAtRaw = String(formData.get("dueAt") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim() || null;

  if (!vaccineName) return { error: "Falta el nombre de la vacuna." };
  if (!dueAtRaw) return { error: "Falta la fecha estimada." };

  const dueAt = parseDateInput(dueAtRaw);
  if (!dueAt) return { error: "Fecha inválida." };

  let reminderId: string;
  try {
    // Idempotency guard (projection-writes audit §6): a double-submit posts
    // the identical reminder twice. If an open (not completed) reminder with
    // the same vaccine + due date already exists for this pet and user, the
    // second submit is a no-op — redirect to the same success surface, and
    // hand back the SAME id rather than a fresh one, so a caller that asked
    // for this reminder to exist gets back the reminder it asked for.
    const [existing] = await db
      .select({ id: reminders.id })
      .from(reminders)
      .where(
        and(
          eq(reminders.petId, petId),
          eq(reminders.userId, userId),
          eq(reminders.reminderType, "vaccine"),
          eq(reminders.title, vaccineName),
          eq(reminders.dueAt, dueAt),
          isNull(reminders.completedAt),
        ),
      )
      .limit(1);

    if (existing) {
      reminderId = existing.id;
    } else {
      const [inserted] = await db
        .insert(reminders)
        .values({
          petId,
          userId,
          reminderType: "vaccine",
          dueAt,
          title: vaccineName,
          description,
        })
        .returning({ id: reminders.id });
      reminderId = inserted.id;
    }
  } catch (err) {
    return {
      error: `No se pudo crear el recordatorio: ${
        err instanceof Error ? err.message : "error desconocido"
      }`,
    };
  }

  // Nav contract N3: RETURN the destination; the form navigates (useActionRedirect).
  return { error: null, redirectTo: `/mis-mascotas/${publicToken}`, reminderId };
}

// Use-case: markMedicationDoseTaken
//
// Migrated from app/actions/events.ts::markMedicationDoseTakenAction.
// Auth (PARITY QUIRK): reminder-keyed, NOT requirePetAccess/requireAlivePetAccess.
//
// Auth steps (performed inside this use-case, not at edge):
//   1. findReminderForUser(reminderId, userId) — verifies reminder.userId = user.id
//   2. reminderType must be "medication"
//   3. completedAt must be null (not already done)
//   4. findOwnedAlivePetByReminder(petId, userId) — verifies pet owned + alive
//   5. pet.status must not be "deceased"
//
// Idempotency: PLAIN insertEvent (NOT insertEventIdempotent) — non-idempotent.
// authorRole HARD-CODED "owner" — NOT spread from eventAuthorship.
// authorOrganizationId and authorVerified NOT set.
// No outbox. No audit_log.

import { validateEventPayload } from "@/lib/events/event-schemas";

import type { EventsRepository } from "../../infrastructure/events-repository";
import type { UseCaseResult } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MarkMedicationDoseTakenInput = {
  reminderId: string;
  userId: string;
};

type Deps = {
  repo: Pick<
    EventsRepository,
    "findReminderForUser" | "findOwnedAlivePetByReminder" | "insertEvent" | "completeReminder"
  >;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function markMedicationDoseTaken(
  input: MarkMedicationDoseTakenInput,
  deps: Deps,
): Promise<UseCaseResult<{ petPublicToken: string }>> {
  const { reminderId, userId } = input;
  const { repo, transaction } = deps;

  // --- Auth step 1: reminder belongs to this user ---
  const reminderRow = await repo.findReminderForUser(reminderId, userId);
  if (!reminderRow) {
    return { ok: false, error: "Recordatorio no encontrado o sin permisos." };
  }

  // --- Auth step 2: must be medication type ---
  if (reminderRow.reminderType !== "medication") {
    return { ok: false, error: "Tipo de recordatorio inválido." };
  }

  // --- Auth step 3: not already completed ---
  if (reminderRow.completedAt) {
    return { ok: false, error: "Esta dosis ya fue marcada." };
  }

  // --- Auth step 4+5: pet owned and alive ---
  const petRow = await repo.findOwnedAlivePetByReminder(reminderRow.petId, userId);
  if (!petRow) {
    return { ok: false, error: "Mascota no encontrada o sin permisos." };
  }
  if (petRow.status === "deceased") {
    return { ok: false, error: "Esta mascota está registrada como fallecida." };
  }

  const now = new Date();

  await transaction(async (tx) => {
    // Mark reminder as completed.
    await repo.completeReminder(
      reminderId,
      reminderRow.petId,
      now,
      tx as Parameters<typeof repo.completeReminder>[3],
    );

    // Dual-write: insert medication_dose_taken event for full audit trail.
    // authorRole HARD-CODED "owner" — reminder-keyed, stays owner-authored.
    // No eventAuthorship spread (no authorOrganizationId, no authorVerified).
    const eventPayload = validateEventPayload("medication_dose_taken", {
      medication_started_event_id: reminderRow.sourceEventId ?? null,
      scheduled_for: reminderRow.dueAt.toISOString(),
      reminder_id: reminderId,
    });

    await repo.insertEvent(
      {
        petId: reminderRow.petId,
        eventType: "medication_dose_taken",
        occurredAt: now,
        recordedAt: now,
        recordedByUserId: userId,
        authorRole: "owner",
        payload: eventPayload,
      },
      tx as Parameters<typeof repo.insertEvent>[1],
    );
  });

  return { ok: true, value: { petPublicToken: petRow.publicToken }, notifications: [] };
}

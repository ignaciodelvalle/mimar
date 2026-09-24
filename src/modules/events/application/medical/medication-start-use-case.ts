// Use-case: createMedicationStart
//
// Migrated from app/actions/events.ts::createMedicationStartAction (inner tx block).
// Auth (requireAlivePetAccess) handled by caller (actions.ts).
//
// Parity:
//   - Caller (action) resolves parseFrequencyFields + generateDoseSchedule + findDrugByLabel
//     and passes the pre-computed results into this use-case.
//   - Uses insertEventIdempotent; wasNoop=true → skip ALL side-effects incl. dose reminders.
//   - Attachment inserted when uploadedPath provided.
//   - Dose reminders inserted when schedule is non-empty.
//   - No outbox. No audit_log.

import { validateEventPayload } from "@/lib/events/event-schemas";
import type { FrequencyKind } from "@/lib/reference/medication-schedule";

import type { EventsRepository } from "../../infrastructure/events-repository";
import type { RecordedEvent, UseCaseResult } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CreateMedicationStartInput = {
  pet: { id: string; name: string };
  user: { id: string };
  eventAuthorship: {
    authorRole: string;
    authorOrganizationId: string | null;
    authorVerified: boolean;
  };
  drugName: string;
  dose: string;
  prescribedBy: string | null;
  occurredAt: Date;
  notes: string | null;
  uploadedPath: string | null;
  uploadedMimeType: string | null;
  uploadedSize: number | null;
  clientIdempotencyKey: string | null;
  // Pre-computed by caller from parseFrequencyFields / generateDoseSchedule
  frequency: FrequencyKind;
  customHours: number | null;
  durationDays: number | null;
  firstDoseAt: Date;
  schedule: Date[];
  matchedDrugCode: string | null;
  frequencyLabel: string;
};

type Deps = {
  repo: Pick<EventsRepository, "insertEventIdempotent" | "insertAttachment" | "insertReminders">;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function createMedicationStart(
  input: CreateMedicationStartInput,
  deps: Deps,
): Promise<UseCaseResult<RecordedEvent>> {
  const {
    pet,
    user,
    eventAuthorship,
    drugName,
    dose,
    prescribedBy,
    occurredAt,
    notes,
    uploadedPath,
    uploadedMimeType,
    uploadedSize,
    clientIdempotencyKey,
    frequency,
    customHours,
    durationDays,
    firstDoseAt,
    schedule,
    matchedDrugCode,
    frequencyLabel,
  } = input;
  const { repo, transaction } = deps;

  const now = new Date();
  const committed = await transaction(async (tx) => {
    const eventPayload = validateEventPayload("medication_started", {
      drug_name: drugName,
      dose,
      frequency,
      prescribed_by: prescribedBy,
      drug_code: matchedDrugCode ?? null,
      first_dose_at: firstDoseAt.toISOString(),
      duration_days: durationDays,
      custom_hours: frequency === "custom" ? customHours : null,
      schedule_count: schedule.length,
    });

    const { event, wasNoop } = await repo.insertEventIdempotent(
      {
        petId: pet.id,
        eventType: "medication_started",
        occurredAt,
        recordedAt: now,
        recordedByUserId: user.id,
        ...eventAuthorship,
        payload: eventPayload,
        notes,
        clientIdempotencyKey,
      } as Parameters<typeof repo.insertEventIdempotent>[0],
      tx as Parameters<typeof repo.insertEventIdempotent>[1],
    );

    if (wasNoop) return { eventId: event.id, wasDuplicate: true };

    if (uploadedPath) {
      await repo.insertAttachment(
        {
          petId: pet.id,
          eventId: event.id,
          uploadedByUserId: user.id,
          storagePath: uploadedPath,
          mimeType: uploadedMimeType ?? "image/jpeg",
          fileSize: uploadedSize ?? 0,
        },
        tx as Parameters<typeof repo.insertAttachment>[1],
      );
    }

    if (schedule.length > 0) {
      await repo.insertReminders(
        schedule.map((dueAt) => ({
          petId: pet.id,
          userId: user.id,
          reminderType: "medication" as const,
          dueAt,
          title: `${drugName} – Dosis`,
          description: `${dose}${frequencyLabel ? ` · ${frequencyLabel}` : ""}`,
          sourceEventId: event.id,
        })),
        tx as Parameters<typeof repo.insertReminders>[1],
      );
    }

    return { eventId: event.id, wasDuplicate: false };
  });

  return { ok: true, value: committed, notifications: [] };
}

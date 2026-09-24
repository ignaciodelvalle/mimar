import { db, notifications, petEvents, reminders } from "@/db";
import { insertEventIdempotent } from "@/lib/events/event-idempotency";
import { validateEventPayload } from "@/lib/events/event-schemas";

import { rederivePregnancyStatus } from "./rederive-pregnancy-status";
import type { RecordPregnancyResult, RecordPregnancyStartedParams } from "./types";

// Species-specific gestation window, in DAYS. Spec PR6 + §9 reminders.
//
// IT WAS IN WEEKS UNTIL 2026-09-07, and the unit is the reason this changed
// rather than a preference. The table held three species at "9 weeks"; opening
// it to the rest of the app's catalogue (PO decision, same day) is what broke
// the unit, because a RABBIT gestates about 32 days — 4.6 weeks. Whole weeks
// can only say 28 or 35, which is three days early or three days late on a
// pregnancy that lasts a month: a ~10% error where the same slip on a dog is
// ~5%. `expectedBirthAt` is shown to an owner as the probable birth date and
// drives the checkup reminder schedule, so the unit has to be able to express
// the animal.
//
// Values are the veterinary averages, checked 2026-09-07 rather than recalled:
// dog 62-64, cat 58-65, rabbit 30-35, guinea pig 56-74, ferret ~42. The number
// taken is the middle of each range; every one of these is a RANGE in the
// source, which is exactly why the field is called "probable".
//
// `other` KEEPS A DOG'S NUMBER, and that is a known lie rather than an
// oversight. It is the pre-existing behaviour (`other: 9` weeks = 63 days) and
// it is left alone deliberately: the honest answer for a species this build
// cannot name is "no probable date", and that means a nullable
// `expectedBirthAt` in `OwnerPetPregnancyV1` plus a reminder schedule with
// nothing to schedule against — a contract change, not a table row. Flagged to
// the PO 2026-09-07; until it is decided, an `other` pregnancy predicts like a
// dog and says so nowhere.
export const PREGNANCY_DURATION_DAYS: Record<string, number> = {
  dog: 63,
  cat: 64,
  rabbit: 32,
  guinea_pig: 68,
  ferret: 42,
  other: 63,
};

export async function recordPregnancyStartedWriter(
  params: RecordPregnancyStartedParams,
): Promise<RecordPregnancyResult> {
  if (params.pet.sex !== "female") {
    return {
      ok: false,
      error: "Solo se pueden registrar embarazos en hembras.",
      notAllowed: "not_applicable",
    };
  }
  if (!Object.hasOwn(PREGNANCY_DURATION_DAYS, params.pet.species)) {
    return {
      ok: false,
      error: "Especie no soportada para embarazos.",
      notAllowed: "not_applicable",
    };
  }
  if (params.pet.pregnancyStatus === "in_progress") {
    return {
      ok: false,
      error:
        "Esta mascota ya tiene un embarazo en seguimiento. Cerralo primero antes de registrar uno nuevo.",
      notAllowed: "already_open",
    };
  }

  const now = params.now ?? new Date();
  const speciesDays = PREGNANCY_DURATION_DAYS[params.pet.species];
  // `weeksAtDiagnosis` stays in WEEKS — it is what the form asks a person, and
  // "¿de cuántas semanas?" is how a vet says it. Only the table changed unit, so
  // the conversion happens here, once.
  //
  // The clamp at 0 is load-bearing for the short species: the form bounds the
  // answer at 12 weeks, which is longer than a rabbit's ENTIRE gestation, so an
  // impossible answer would otherwise produce a birth date in the past. Clamped,
  // the worst case is "probable birth today" and a schedule with no reminders in
  // it — degenerate but harmless. A species-aware bound on the form is the real
  // fix and belongs with the form, not here.
  const daysRemaining =
    params.weeksAtDiagnosis !== null
      ? Math.max(speciesDays - params.weeksAtDiagnosis * 7, 0)
      : speciesDays;
  const expectedBirthAt = new Date(params.occurredAt.getTime() + daysRemaining * 86400000);

  let eventId = "";
  let reminderCount = 0;
  let wasDuplicate = false;
  try {
    await db.transaction(async (tx) => {
      const payload = validateEventPayload("clinical_info_logged", {
        sub_kind: "pregnancy",
        pregnancy_phase: "started",
        title: "Embarazo en seguimiento",
        details: null,
        performed_by: params.vetConsulted,
        weeks_at_diagnosis: params.weeksAtDiagnosis,
        vet_consulted: params.vetConsulted,
      });
      // IDEMPOTENT WHEN A KEY IS GIVEN, PLAIN WHEN NOT — added 2026-09-08 with
      // the v1 endpoint, and the split is the same one the PPP attestation made
      // three days earlier. The web's two forms carry no key (pregnancy.ts:45-48
      // and :90-94 read no such field), so their path is unchanged;
      // `POST /api/v1/pets/{token}/events` REQUIRES one and promises it is
      // honoured, and this writer was excluded from that endpoint on exactly
      // the grounds that it could not honour it. The endpoint's own header said
      // so and called it "one file away". This is that file.
      const values = {
        petId: params.pet.id,
        eventType: "clinical_info_logged" as const,
        occurredAt: params.occurredAt,
        recordedAt: now,
        recordedByUserId: params.recordedByUserId,
        ...params.eventAuthorship,
        payload,
        notes: params.notes,
        ...(params.clientIdempotencyKey
          ? { clientIdempotencyKey: params.clientIdempotencyKey }
          : {}),
      };

      let event: { id: string };
      if (params.clientIdempotencyKey) {
        const inserted = await insertEventIdempotent(
          values as Parameters<typeof insertEventIdempotent>[0],
          tx as Parameters<typeof insertEventIdempotent>[1],
        );
        event = inserted.event;
        wasDuplicate = inserted.wasNoop;
      } else {
        const [row] = await tx.insert(petEvents).values(values).returning();
        event = row;
      }
      eventId = event.id;

      // EVERY SIDE EFFECT BELOW IS SKIPPED ON A REPLAY, and the two that matter
      // are the reason this early return exists rather than a comment asking
      // for care. A second run would insert the biweekly checkup reminders a
      // SECOND time — the same schedule twice on one gestation — and tell the
      // person again that their animal is pregnant. `rederivePregnancyStatus`
      // would be harmless to repeat (it re-reads the spine), and it is skipped
      // anyway: the first attempt already ran it against the same rows.
      if (wasDuplicate) return;

      // Re-derive rather than assert "in_progress": a back-dated start recorded
      // after this pregnancy already ended must not overwrite the terminal
      // status the spine holds.
      await rederivePregnancyStatus(tx, params.pet.id);

      // Biweekly checkup reminders until expected birth date.
      const reminderRows: (typeof reminders.$inferInsert)[] = [];
      const TWO_WEEKS_MS = 14 * 86400000;
      let cursor = new Date(params.occurredAt.getTime() + TWO_WEEKS_MS);
      while (cursor < expectedBirthAt) {
        reminderRows.push({
          petId: params.pet.id,
          userId: params.recordedByUserId,
          reminderType: "custom",
          dueAt: cursor,
          title: "Control veterinario de embarazo",
          description: "Recordatorio quincenal sugerido durante la gestación.",
          sourceEventId: event.id,
        });
        cursor = new Date(cursor.getTime() + TWO_WEEKS_MS);
      }
      if (reminderRows.length > 0) {
        await tx.insert(reminders).values(reminderRows);
        reminderCount = reminderRows.length;
      }

      await tx.insert(notifications).values({
        userId: params.recordedByUserId,
        notificationType: "pregnancy_started_owner",
        severity: "info",
        title: "Embarazo en seguimiento",
        body: "Te recomendamos llevar a tu mascota a controles veterinarios regulares durante la gestación.",
        relatedPetId: params.pet.id,
        relatedEventId: event.id,
        ctaLabel: "Ver mascota",
        ctaUrl: `/mis-mascotas/${params.pet.publicToken}`,
      });
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "error desconocido" };
  }

  // `reminderCount` is 0 on a replay and that is honest: this call scheduled
  // nothing. The first attempt's reminders are already in the table.
  return { ok: true, eventId, reminderCount, wasDuplicate };
}

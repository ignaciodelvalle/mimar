// Writer: recordPregnancyEndedWriter (strangler migration 18/61).

import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";

import { db, notifications, petEvents, reminders } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";

import { insertEventIdempotent } from "@/lib/events/event-idempotency";
import { rederivePregnancyStatus } from "./rederive-pregnancy-status";
import type { RecordPregnancyEndedParams, RecordPregnancyResult } from "./types";

// statusFromOutcome (`completed_${outcome}`) lived here until 2026-08-12. The
// status now comes from replayPetPregnancy via rederivePregnancyStatus, which
// owns that same mapping — keeping a second copy here would be a rule with two
// definitions free to drift apart.

export async function recordPregnancyEndedWriter(
  params: RecordPregnancyEndedParams,
): Promise<RecordPregnancyResult> {
  if (params.pet.pregnancyStatus !== "in_progress") {
    return {
      ok: false,
      error: "Esta mascota no tiene un embarazo activo para cerrar.",
      notAllowed: "none_open",
    };
  }
  if (params.outcome !== "live_birth" && params.liveBirthsCount !== null) {
    return {
      ok: false,
      error: "live_births_count solo es válido si el resultado es parto exitoso.",
      notAllowed: "births_mismatch",
    };
  }
  if (params.outcome === "live_birth" && (params.liveBirthsCount ?? 0) < 1) {
    return {
      ok: false,
      error: "Indicá la cantidad de crías nacidas vivas (mínimo 1).",
      notAllowed: "births_mismatch",
    };
  }

  const now = params.now ?? new Date();
  let eventId = "";
  let wasDuplicate = false;
  try {
    await db.transaction(async (tx) => {
      const payload = validateEventPayload("clinical_info_logged", {
        sub_kind: "pregnancy",
        pregnancy_phase: "ended",
        title: "Fin del embarazo",
        details: null,
        performed_by: params.vetConsulted,
        outcome: params.outcome,
        live_births_count: params.outcome === "live_birth" ? params.liveBirthsCount : null,
        vet_consulted: params.vetConsulted,
      });
      // Idempotent when a key is given, plain when not — see the started
      // writer's twin of this block for why the split exists.
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

      // SKIPPED ON A REPLAY. The cancellation of the open checkup reminders is
      // idempotent by nature — cancelling a cancelled row changes nothing — but
      // the NOTIFICATION is not: a person would be told twice that the
      // pregnancy ended, which on `stillbirth` or `miscarriage` is a message
      // nobody should receive a second time.
      if (wasDuplicate) return;

      // Re-derive rather than assert the outcome: latest-by-occurredAt wins, so
      // a back-dated end cannot clobber a later pregnancy's status.
      await rederivePregnancyStatus(tx, params.pet.id);

      // Cancel future pregnancy checkup reminders tied to the open
      // pregnancy_started event(s) of this pet. Filter on payload.sub_kind
      // so unrelated clinical_info_logged rows don't get touched.
      const startedEvents = await tx
        .select({ id: petEvents.id })
        .from(petEvents)
        .where(
          and(
            eq(petEvents.petId, params.pet.id),
            eq(petEvents.eventType, "clinical_info_logged"),
            sql`${petEvents.payload}->>'sub_kind' = 'pregnancy'`,
            sql`${petEvents.payload}->>'pregnancy_phase' = 'started'`,
          ),
        );
      const startedIds = startedEvents.map((r) => r.id);
      if (startedIds.length > 0) {
        await tx
          .update(reminders)
          .set({ completedAt: now })
          .where(
            and(
              inArray(reminders.sourceEventId, startedIds),
              isNull(reminders.completedAt),
              gt(reminders.dueAt, now),
            ),
          );
      }

      // Owner notification — copy varies by outcome (spec §5.2 step 5-6).
      const owner = params.recordedByUserId;
      let title = "";
      let body = "";
      if (params.outcome === "live_birth") {
        title = `¡Felicitaciones! Quedó registrado el parto de ${params.pet.name}`;
        body = "Acabás de desbloquear el logro 'Tuve crías' en el perfil de tu mascota.";
      } else if (params.outcome === "stillbirth" || params.outcome === "miscarriage") {
        title = `Cierre del embarazo de ${params.pet.name}`;
        body =
          "Lamentamos la pérdida. Te recomendamos un seguimiento veterinario en los próximos días.";
      } else {
        title = `Cierre del embarazo de ${params.pet.name}`;
        body = "Quedó registrado en la libreta.";
      }
      await tx.insert(notifications).values({
        userId: owner,
        notificationType: "pregnancy_ended_owner",
        severity: params.outcome === "live_birth" ? "success" : "info",
        title,
        body,
        relatedPetId: params.pet.id,
        relatedEventId: event.id,
        ctaLabel: "Ver mascota",
        ctaUrl: `/mis-mascotas/${params.pet.publicToken}`,
      });
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "error desconocido" };
  }
  return { ok: true, eventId, reminderCount: 0, wasDuplicate };
}

// Use-case: sweep rabies observations whose statutory window has elapsed
// (cron — spec §E).
//
// Migrated from lib/rabies-observation-closer.ts::closeEligibleRabiesObservations.
// No user auth — cron actor (x-cron-secret header checked at route level).
//
// ---------------------------------------------------------------------------
// THIS SWEEP NO LONGER CLOSES ANYTHING (PO decision 2026-08-17, engram
// roadmap/decisiones-legales-flujos-2026-08-17 item 1)
// ---------------------------------------------------------------------------
// It used to insert `rabies_observation_ended` with outcome='negative',
// closed_by_role='system', recordedByUserId=null, authorVerified=false and the
// note "Auto-cerrado tras 10 días sin síntomas escalables". That row is the
// State's own document asserting that the animal which bit somebody was
// clinically clear — written by a scheduled job, with no clinical author, on the
// strength of the OWNER not having self-reported a symptom. If the exposed
// person later develops rabies, that row is what our registry says.
//
// The sweep now moves the observation to `window_expired_unclosed`: a factual,
// verifiable state that asserts NOTHING in either direction, keeps the bite case
// OPEN as work for the sanitary authority, and is visible on every surface that
// already read the status column. Only professionalCloseObservation can put an
// outcome in the record.
//
// Parity quirks that SURVIVE:
//   - Owner notification INSIDE the tx (not post-tx).
//   - Escalating symptom → skip the transition, notify authorities urgent, and
//     leave the pet `in_progress` ON PURPOSE: symptoms compatible with rabies
//     ARE an ongoing danger, the public banner must keep saying so, and the
//     daily re-notification is the nag that keeps the case in front of somebody.
//   - Per-pet try/catch isolates failures (one failure doesn't stop the batch).
//   - AUDIT_LOG: NONE — no operator acts here; the professional close is the
//     act that now carries an audit row.
//
// Parity quirk DELETED: repo.autoExpireBiteCase (closed_reason='auto_expired').
// Closing the bite expediente was downstream of asserting a negative outcome.
// With no outcome asserted there is nothing resolved, so the case stays open.

import type { CreateNotificationInput } from "@/lib/infra/notification-service";
import { AR_TIME_ZONE, pluralizeEs } from "@/lib/utils/format";
import {
  resolveObservationDeadline,
  resolveObservationWindowDays,
} from "../domain/rabies-observation";
import type { SurveillanceRepository } from "../infrastructure/surveillance-repository";
import type { NewNotification } from "./types";

/**
 * es-AR fragment naming the window that was actually applied — " de 14 días" —
 * or "" when the observation predates `observation_days`. Never substitutes the
 * national baseline: quoting "10 días" inside a 14-day jurisdiction is the exact
 * copy defect this fragment exists to end.
 */
function windowPhrase(days: number | null): string {
  return days === null ? "" : ` de ${days} ${pluralizeEs(days, "día")}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CloseRabiesObservationsStats = {
  scanned: number;
  /**
   * Observations whose window elapsed with no professional closure and were
   * moved to `window_expired_unclosed`. Was `closedNegative` until 2026-08-17,
   * when the sweep stopped asserting a clinical outcome — the rename is
   * deliberate so no dashboard keeps reading "closed negative" off a counter
   * that no longer means it.
   */
  windowExpiredUnclosed: number;
  flaggedForReview: number;
  skippedNotYetDue: number;
  errors: { petId: string; reason: string }[];
  /**
   * Keyset resume point (review 23 fleet extension): the last pet id on this
   * page when a FULL page was returned (more may remain), else null when the
   * in_progress set was drained. The cron route persists this in
   * cron_runs.details and passes it back as `afterId` next run, so a registry
   * with more concurrent observations than one page is swept fairly across runs.
   */
  nextCursor: string | null;
};

export type CloseEligibleObservationsOptions = {
  now?: Date;
  /** Keyset cursor: process in_progress pets whose id sorts after this value. */
  afterId?: string | null;
  /** Max pets to scan this run. Defaults to the repo's page size (500). */
  limit?: number;
};

type Deps = {
  repo: Pick<
    SurveillanceRepository,
    | "findPetsInProgress"
    | "findLatestObservationStarted"
    | "findEscalatingSymptom"
    | "findOpenBiteCase"
    | "closeObservationIfOpen"
    | "findActiveOwnerUserIds"
    | "insertNotifications"
  >;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
  /**
   * The durable write path (lib/infra/notification-service.ts): dedupe key +
   * dead-letter. The owners' notice goes through it; injected so the use case
   * stays testable without a database.
   */
  createNotificationsBulk: (inputs: CreateNotificationInput[]) => Promise<unknown>;
  findAuthoritiesForJurisdiction: (jurisdiction: {
    province: string;
    locality: string;
  }) => Promise<string[]>;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function closeEligibleObservations(
  options: CloseEligibleObservationsOptions,
  deps: Deps,
): Promise<CloseRabiesObservationsStats> {
  const { repo, transaction, findAuthoritiesForJurisdiction, createNotificationsBulk } = deps;
  const now = options.now ?? new Date();

  const stats: CloseRabiesObservationsStats = {
    scanned: 0,
    windowExpiredUnclosed: 0,
    flaggedForReview: 0,
    skippedNotYetDue: 0,
    errors: [],
    nextCursor: null,
  };

  const PAGE_LIMIT = options.limit ?? 500;
  const eligible = await repo.findPetsInProgress({
    afterId: options.afterId ?? null,
    limit: PAGE_LIMIT,
  });
  stats.scanned = eligible.length;
  // A full page means more in_progress pets may remain past this cursor — the
  // route resumes AFTER the last id next run. A partial page means drained →
  // null wraps the sweep back to the top.
  stats.nextCursor =
    eligible.length >= PAGE_LIMIT ? (eligible[eligible.length - 1]?.id ?? null) : null;

  for (const pet of eligible) {
    try {
      // 1. Find started event.
      const startedEvent = await repo.findLatestObservationStarted(pet.id);
      if (!startedEvent) {
        stats.errors.push({
          petId: pet.id,
          reason: "in_progress but no rabies_observation_started event found",
        });
        continue;
      }

      const startedPayload = startedEvent.payload as Record<string, unknown>;
      // Fallback deadline (T4.13 extracted this into the shared domain
      // helper, 2026-08-01): when the started payload has no (or an invalid)
      // observation_until, derive it from when the observation started + the
      // statutory national window. Older/seed observations without the field
      // would otherwise stay EN CURSO forever — the deadline is always
      // computable. Reused verbatim by /admin/observaciones's "Cierre
      // estimado" fallback.
      const observationUntil = resolveObservationDeadline(
        startedPayload.observation_until,
        startedEvent.occurredAt,
      );
      // The window this observation ACTUALLY ran under (null on rows written
      // before 2026-08-17). Every message below quotes it or says nothing —
      // never the national 10 as a stand-in.
      const windowDays = resolveObservationWindowDays(startedPayload.observation_days);
      const window = windowPhrase(windowDays);
      const deadlineLabel = observationUntil.toLocaleDateString("es-AR", {
        timeZone: AR_TIME_ZONE,
      });

      // 2. Not yet due — skip.
      if (observationUntil > now) {
        stats.skippedNotYetDue += 1;
        continue;
      }

      // 3. Check for escalating symptom during observation period.
      const escalating = await repo.findEscalatingSymptom(pet.id, startedEvent.occurredAt);
      if (escalating) {
        // Escalation requires a human professional — and the pet DELIBERATELY
        // stays `in_progress` rather than moving to `window_expired_unclosed`:
        // symptoms compatible with rabies are an ongoing danger, so the public
        // banner must keep saying so and this sweep must keep nagging the
        // authority every day (the notification's related_event_id dedupes the
        // repeats against the same started event).
        stats.flaggedForReview += 1;
        try {
          // Null jurisdiction is coerced, not skipped (2026-08-17): the guard it
          // replaces meant a pet with no geocoded home never reached the admin
          // fallback, so an observation with rabies-compatible symptoms nagged
          // nobody, every day, forever.
          const authorityIds = await findAuthoritiesForJurisdiction({
            province: pet.jurisdictionProvince ?? "",
            locality: pet.jurisdictionLocality ?? "",
          });
          if (authorityIds.length > 0) {
            const authNotifications: NewNotification[] = authorityIds.map((authorityId) => ({
              userId: authorityId,
              notificationType: "rabies_observation_pending_review",
              severity: "urgent" as const,
              title: `Observación vencida pendiente de revisión — ${pet.name}`,
              body: `El período de observación antirrábica${window} venció el ${deadlineLabel} y hubo síntomas compatibles con rabia durante la observación. Cierre profesional requerido (negativo o positivo).`,
              relatedPetId: pet.id,
              relatedEventId: startedEvent.id,
              // Authority recipient: surveillance hub (cannot open /mis-mascotas).
              ctaLabel: "Ver vigilancia",
              ctaUrl: "/gob/vigilancia",
            }));
            await repo.insertNotifications(
              authNotifications as Parameters<typeof repo.insertNotifications>[0],
            );
          }
        } catch (notifyErr) {
          console.error(
            `[close-eligible-observations] authority notification failed for pet ${pet.publicToken}:`,
            notifyErr,
          );
        }
        continue;
      }

      // 4. Window elapsed, no escalating symptom, no professional closure.
      //    NOTHING is asserted about the animal: the status moves to
      //    `window_expired_unclosed` and the bite case stays OPEN. No
      //    rabies_observation_ended event is written — nobody acted.
      const biteCase = await repo.findOpenBiteCase(pet.id);

      // The owners to tell, read under the same transaction as the transition;
      // null when the guard lost the race and nothing transitioned.
      const ownerIds = await transaction(async (tx): Promise<string[] | null> => {
        // Guarda adentro del UPDATE: si un veterinario ya asento un resultado
        // clinico entre el escaneo y esta transaccion, la observacion dejo de
        // estar abierta y el cron no debe tocarla. Marcar la ventana vencida
        // encima de un cierre profesional borraria el resultado.
        //
        // Ojo con la asimetria: window_expired_unclosed SIGUE siendo un estado
        // abierto --el cron no afirma ningun resultado, solo constata que la
        // ventana paso sin que nadie cerrara-- asi que la guarda lo admite y
        // solo bloquea contra un cierre real.
        const marco = await repo.closeObservationIfOpen(
          pet.id,
          "window_expired_unclosed",
          now,
          tx as Parameters<typeof repo.closeObservationIfOpen>[3],
        );
        if (!marco) return null;

        // EVERY active owner and co-owner (2026-09-18). This read
        // `findActiveOwnership` — a single `role = 'owner'` row — so a co-owner
        // never heard that the window on their animal was over and that the
        // observation was still open; the professional close was fixed the
        // same way the same day.
        return repo.findActiveOwnerUserIds(
          pet.id,
          tx as Parameters<typeof repo.findActiveOwnerUserIds>[1],
        );
      });

      // 5. Owner notification, AFTER the transition committed, through the
      //    durable service. It was a raw `repo.insertNotifications` with no
      //    dedupe key and no dead-letter: a failed write threw into the
      //    per-pet catch AFTER the status had already moved, the pet left the
      //    in_progress scan, and the owner was never told — by this run or any
      //    later one. Keyed on the started event, which is one observation, so
      //    a replay cannot tell the same owner twice.
      //
      //    It states the window is over and that the observation is STILL
      //    OPEN. The message it replaced ("terminó automáticamente sin
      //    incidentes. {pet} sigue normal.") was an all-clear nobody was
      //    entitled to give.
      if (ownerIds && ownerIds.length > 0) {
        const notificationType = "rabies_observation_window_expired_owner";
        await createNotificationsBulk(
          [...new Set(ownerIds)].map((ownerUserId) => ({
            userId: ownerUserId,
            notificationType,
            severity: "info" as const,
            title: `Período de observación cumplido — ${pet.name}`,
            body: `Se cumplió el período de observación antirrábica${window} de ${pet.name} (vencía el ${deadlineLabel}). La observación sigue abierta: el resultado clínico solo puede registrarlo un veterinario matriculado o la autoridad sanitaria. Llevá a ${pet.name} con su credencial a tu veterinario para que lo registre, o presentate ante la autoridad sanitaria de tu localidad.`,
            relatedPetId: pet.id,
            relatedCaseId: biteCase?.id ?? null,
            relatedEventId: startedEvent.id,
            ctaLabel: "Ver mascota",
            ctaUrl: `/mis-mascotas/${pet.publicToken}`,
            dedupeKey: `event:${startedEvent.id}:${ownerUserId}:${notificationType}`,
          })),
        );
      }

      // 6. Authority hand-off (post-tx, best-effort): the expired observation is
      //    actionable work for whoever can actually close it. A routing miss
      //    never undoes the state transition.
      try {
        // Null jurisdiction coerced, not skipped — same reason as the escalating
        // branch above.
        const authorityIds = await findAuthoritiesForJurisdiction({
          province: pet.jurisdictionProvince ?? "",
          locality: pet.jurisdictionLocality ?? "",
        });
        if (authorityIds.length > 0) {
          const authNotifications: NewNotification[] = authorityIds.map((authorityId) => ({
            userId: authorityId,
            notificationType: "rabies_observation_pending_review",
            severity: "warning" as const,
            title: `Observación vencida sin cierre profesional — ${pet.name}`,
            body: `El período de observación antirrábica${window} venció el ${deadlineLabel} sin síntomas escalables reportados y sin cierre profesional. No hay resultado clínico registrado: hace falta que un profesional cierre la observación.`,
            relatedPetId: pet.id,
            relatedEventId: startedEvent.id,
            relatedCaseId: biteCase?.id ?? null,
            // Authority recipient: surveillance hub (cannot open /mis-mascotas).
            ctaLabel: "Ver observaciones",
            ctaUrl: "/admin/observaciones",
          }));
          await repo.insertNotifications(
            authNotifications as Parameters<typeof repo.insertNotifications>[0],
          );
        }
      } catch (notifyErr) {
        console.error(
          `[close-eligible-observations] authority notification failed for pet ${pet.publicToken}:`,
          notifyErr,
        );
      }

      stats.windowExpiredUnclosed += 1;
    } catch (err) {
      console.error(
        `[close-eligible-observations] pet ${pet.publicToken} window-expiry sweep failed:`,
        err,
      );
      stats.errors.push({
        petId: pet.id,
        reason: err instanceof Error ? err.message : "unknown error",
      });
    }
  }

  return stats;
}

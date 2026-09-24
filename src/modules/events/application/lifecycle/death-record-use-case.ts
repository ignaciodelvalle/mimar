// Use-case: createDeathRecord (multi-cascade)
//
// Migrated from app/actions/events.ts::createDeathRecordAction.
//
// AUTH: requirePetAccess (accepts deceased/lost) at the action layer.
//   This writer is auth-agnostic — exported for tests.
//
// Parity:
//   - IDEMPOTENT insert (insertEventIdempotent). On noop: ALL cascades SKIPPED.
//   - pets projection: status=deceased + deceasedAt (via updateDeceased).
//   - CASCADE A: auto-end active fosters → foster_ended events + pendingNotifications
//                + close foster_placement case (if fosterCaseId provided).
//   - CASCADE B: close custody_episode if custodyEpisodeCaseId provided.
//   - CASCADE D (rehome-by-titular): a SPONSORED pet's death ends the rehome
//                sponsorship — custody row closed by id, listing cleared,
//                `rehome_sponsorship_ended{pet_deceased}` on the spine, the
//                listing / request / application cases closed, the org's admins
//                and the applicants told (lib/infra/rehome-death-cascade.ts).
//   - CASCADE C: wasInObservation → findLatestRabiesObservationStarted →
//                insert rabies_observation_ended (system) + close bite_incident case +
//                updateRabiesObservationStatus(completed_dead).
//   - Post-tx: flushNotifications + signalAuthorityReport (if reportable + diseaseCode) +
//              urgent authority fan-out (if rabiesObservationClosed AND jurisdiction set).
//   - Result: { ok: true, eventId, wasDuplicate, insertedEventId,
//               rabiesObservationClosed, diseaseCode, authoritySignal }
//   - CRITICAL: all cascades SKIP on idempotency noop.
//   - VETERINARY CLOSER (PO decision D8, 2026-09-18): with `observationCloser`
//     the death is recorded FROM THE CLINIC during a rabies observation. CASCADE
//     C then signs the `rabies_observation_ended` as that vet (closed_by_role
//     'vet', matrícula-verified, their organization), closes the observation
//     through the GUARDED update (a concurrent close aborts the whole tx, death
//     included), and writes the same accountability audit row as the
//     professional close — all in this transaction. A vet death outside an open
//     observation is refused inside the tx, never recorded half-way.
//   - LOCK FIRST (WU6/7 review, M-1): the transaction's first statement is the
//     pet advisory lock (`lockPetForDeathRecord`) — CASCADE A closes foster
//     rows and the projection touches the pets row, the same rows an adoption
//     finalize or a titular's withdraw hold under that lock. A serialization
//     failure Postgres still raises (40P01 / 40001) is mapped to a refusal
//     the recorder can retry, like the withdraw does; nothing was written.

import { type AuthoritySignalResult, signalAuthorityReport } from "@/lib/domain/authority";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { findAuthoritiesForJurisdiction } from "@/lib/infra/approval-routing";
import { closeCase } from "@/lib/infra/case-helpers";
import { pgErrorCode } from "@/lib/infra/db-errors";
import { activeHumanInstitutionalAdminIds } from "@/lib/infra/notification-recipients";
import { createNotificationsBulk } from "@/lib/infra/notification-service";
import {
  endSponsorshipForDeceasedPet,
  lockPetForDeathRecord,
} from "@/lib/infra/rehome-death-cascade";
import { dispositionMethodLabel } from "@/lib/utils/format";

type CaseExecutor = Parameters<typeof closeCase>[1];

/**
 * SQLSTATEs Postgres raises when it had to pick a loser between two
 * transactions on the same rows: 40P01 deadlock_detected, 40001
 * serialization_failure. Nothing was written; the recorder simply tries
 * again. Every other failure keeps its message — a refusal must not hide a
 * real bug. (Same mapping as src/modules/rehome/application/withdraw-rehome-sponsorship.ts.)
 */
const SERIALIZATION_CODES = new Set(["40P01", "40001"]);

function serializationRefusal(petName: string): string {
  return `Otra acción sobre ${petName} se estaba registrando al mismo tiempo y el fallecimiento no se registró. No cambió nada. Volvé a intentar en unos segundos.`;
}

import type { EventsRepository } from "../../infrastructure/events-repository";
import type { NewNotification } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CreateDeathRecordInput = {
  pet: {
    id: string;
    name: string;
    status: string;
    rabiesObservationStatus: string | null;
    jurisdictionProvince: string | null;
    jurisdictionLocality: string | null;
  };
  recordedByUserId: string;
  eventAuthorship: {
    authorRole: string;
    authorOrganizationId: string | null;
    authorVerified: boolean;
  };
  cause: string;
  causeDetail: string | null;
  confirmedByVet: boolean;
  vetName: string | null;
  dispositionMethod: string | null;
  facility: string | null;
  occurredAt: Date;
  notes: string | null;
  deathAtClinic: boolean;
  clinicName: string | null;
  vetContactedOwner: string | null;
  vetDecidedAlone: boolean;
  ownerToPrivateCrematorium: boolean;
  diseaseCode: string | null;
  confirmedByLab: boolean;
  /** Pre-computed by caller: isReportable(diseaseCode). Avoids importing diseases lib here. */
  isReportable?: boolean;
  uploadedPath: string | null;
  uploadedMimeType: string | null;
  uploadedSize: number | null;
  clientIdempotencyKey: string | null;
  /** caseId from findOpenCaseForPetAndKind(pet.id, "custody_episode") — null if no intake. */
  custodyEpisodeCaseId: string | null;
  /** caseId from the open foster_placement case — caller resolves inside tx. */
  fosterCaseId?: string | null;
  /** caseId from the open bite_incident case — caller resolves inside tx for cascade C. */
  biteCaseId?: string | null;
  /**
   * PO decision D8 (2026-09-18): the death is recorded by the matriculated vet
   * attending the animal during its rabies observation (Atender). Requires the
   * pet to be IN observation, and deps.closeObservationIfOpen +
   * deps.insertObservationCloseAuditLog. See the header.
   */
  observationCloser?: {
    role: "vet";
    userId: string;
    organizationId: string;
    petPublicToken: string;
  };
  now?: Date;
};

/** The audit row the veterinary closer writes — the professional close's own action. */
export type ObservationCloseAuditEntry = {
  action: "rabies_observation_closed_professional";
  actorUserId: string;
  payload: Record<string, unknown>;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
};

/** What the closure notes say when a vet records the death (spine + audit). */
export const VET_DEATH_CLOSURE_NOTES =
  "Fallecimiento durante la observación, registrado por un veterinario matriculado desde la clínica.";

export type CreateDeathRecordResult =
  | {
      ok: true;
      /**
       * The event this write RESOLVED TO — the row inserted, or the row a
       * replayed `clientIdempotencyKey` found. Always present on success.
       *
       * ADDED 2026-09-08, ALONGSIDE `insertedEventId` RATHER THAN REPLACING IT,
       * and the distinction is load-bearing. `insertedEventId` answers "did I
       * insert something", which is the question `announceCaretakerDeathRecord`
       * (caretaker-activity-alert.ts:137) correctly asks before notifying a
       * titular a second time about one death. This field answers a different
       * one — "which event is this" — and `POST /api/v1/pets/{token}/events`
       * cannot honour its `{eventId, wasDuplicate}` contract without it.
       * Collapsing them would have made the web re-notify on every retry.
       */
      eventId: string;
      /** `true` when the key resolved to an event that already existed. */
      wasDuplicate: boolean;
      /** `null` on a replay: nothing was inserted, so no cascade ran. */
      insertedEventId: string | null;
      rabiesObservationClosed: boolean;
      diseaseCode: string | null;
      /**
       * Honest authority-transmission state for reportable deaths (G7):
       * `{ delivered: false, v1_noop: true, ... }` until the SNVS 2.0 API
       * exists. Null when no report obligation applied (non-reportable death
       * or idempotency noop). Callers must never render this as "sent".
       */
      authoritySignal: AuthoritySignalResult | null;
    }
  | { ok: false; error: string };

type Deps = {
  repo: Pick<
    EventsRepository,
    | "insertEventIdempotent"
    | "insertEvent"
    | "insertAttachment"
    | "updateDeceased"
    | "findActiveFosters"
    | "endFoster"
    | "findLatestRabiesObservationStarted"
    | "updateRabiesObservationStatus"
    | "updateStatusProjection"
  >;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
  flushNotifications: (pendingNotifications: NewNotification[]) => Promise<void>;
  /**
   * Veterinary closer only (D8): the guarded status update — true when THIS
   * transaction moved the observation out of an open state. The surveillance
   * repository's method, the same guard the professional close uses.
   */
  closeObservationIfOpen?: (
    petId: string,
    status: "completed_dead",
    now: Date,
    tx: unknown,
  ) => Promise<boolean>;
  /** Veterinary closer only (D8): the accountability row, inside the transaction. */
  insertObservationCloseAuditLog?: (
    entry: ObservationCloseAuditEntry,
    tx: unknown,
  ) => Promise<void>;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

/**
 * Record the death of a pet with full multi-cascade side-effects.
 * Exported for integration tests — action layer handles auth + form parsing.
 */
export async function createDeathRecord(
  input: CreateDeathRecordInput,
  deps: Deps,
): Promise<CreateDeathRecordResult> {
  const {
    pet,
    recordedByUserId,
    eventAuthorship,
    cause,
    causeDetail,
    confirmedByVet,
    vetName,
    dispositionMethod,
    facility,
    occurredAt,
    notes,
    deathAtClinic,
    clinicName,
    vetContactedOwner,
    vetDecidedAlone,
    ownerToPrivateCrematorium,
    diseaseCode,
    confirmedByLab,
    isReportable = false,
    uploadedPath,
    uploadedMimeType,
    uploadedSize,
    clientIdempotencyKey,
    custodyEpisodeCaseId,
    fosterCaseId = null,
    biteCaseId = null,
    observationCloser,
    now = new Date(),
  } = input;

  let insertedEventId: string | null = null;
  // Captured BEFORE the noop return below, which is the whole point: the
  // transaction knows which event the key resolved to even when it inserts
  // nothing, and that fact used to die at the `return`.
  let resolvedEventId: string | null = null;
  let wasDuplicate = false;
  let rabiesObservationClosed = false;
  const pendingNotifications: NewNotification[] = [];

  try {
    await deps.transaction(async (tx) => {
      // FIRST: the pet advisory lock, before any row of this pet is touched
      // (header, "lock first"). The idempotent insert below takes its own
      // key lock after it; the pets row, the foster rows and the custody row
      // all come later.
      await lockPetForDeathRecord(pet.id, tx as Parameters<typeof lockPetForDeathRecord>[1]);

      const wasInObservation = pet.rabiesObservationStatus === "in_progress";

      const eventPayload = validateEventPayload("death_recorded", {
        cause,
        cause_detail: causeDetail,
        confirmed_by_vet: confirmedByVet || null,
        vet_name: vetName,
        disposition_method: dispositionMethod,
        facility,
        death_at_clinic: deathAtClinic || null,
        clinic_name: clinicName,
        vet_contacted_owner: vetContactedOwner,
        vet_decided_alone: vetDecidedAlone || null,
        owner_to_private_crematorium: ownerToPrivateCrematorium || null,
        disease_code: diseaseCode,
        confirmed_by_lab: diseaseCode ? confirmedByLab : null,
        is_reportable: isReportable,
        ...(wasInObservation ? { during_rabies_observation: true } : {}),
      });

      const { event, wasNoop: deathNoop } = await deps.repo.insertEventIdempotent(
        {
          petId: pet.id,
          eventType: "death_recorded",
          occurredAt,
          recordedAt: now,
          recordedByUserId,
          ...eventAuthorship,
          payload: eventPayload,
          notes,
          clientIdempotencyKey,
          caseId: custodyEpisodeCaseId ?? null,
        } as Parameters<typeof deps.repo.insertEventIdempotent>[0],
        tx as Parameters<typeof deps.repo.insertEventIdempotent>[1],
      );

      resolvedEventId = event.id;
      wasDuplicate = deathNoop;

      // CRITICAL: all cascades skip on noop (idempotency guard).
      if (deathNoop) return;

      insertedEventId = event.id;

      // Attachment (if any).
      if (uploadedPath) {
        await deps.repo.insertAttachment(
          {
            petId: pet.id,
            eventId: event.id,
            uploadedByUserId: recordedByUserId,
            storagePath: uploadedPath,
            mimeType: uploadedMimeType ?? "image/jpeg",
            fileSize: uploadedSize ?? 0,
          },
          tx as Parameters<typeof deps.repo.insertAttachment>[1],
        );
      }

      // Status projection: deceased + deceasedAt.
      await deps.repo.updateDeceased(
        pet.id,
        occurredAt,
        now,
        tx as Parameters<typeof deps.repo.updateDeceased>[3],
      );

      // CASCADE A: auto-end active foster ownerships.
      const activeFosters = await deps.repo.findActiveFosters(
        pet.id,
        tx as Parameters<typeof deps.repo.findActiveFosters>[1],
      );

      for (const f of activeFosters) {
        if (!f.ownerUserId) continue;
        await deps.repo.endFoster(f.id, now, tx as Parameters<typeof deps.repo.endFoster>[2]);

        const endedPayload = validateEventPayload("foster_ended", {
          foster_user_id: f.ownerUserId,
          reason: "pet_died",
          death_event_id: event.id,
        });

        await deps.repo.insertEvent(
          {
            petId: pet.id,
            eventType: "foster_ended",
            occurredAt: now,
            recordedAt: now,
            recordedByUserId,
            authorRole: eventAuthorship.authorRole,
            authorOrganizationId: eventAuthorship.authorOrganizationId,
            authorVerified: eventAuthorship.authorVerified,
            payload: endedPayload,
            caseId: fosterCaseId ?? null,
          } as Parameters<typeof deps.repo.insertEvent>[0],
          tx as Parameters<typeof deps.repo.insertEvent>[1],
        );

        pendingNotifications.push({
          userId: f.ownerUserId,
          notificationType: "foster_ended_by_death",
          severity: "info",
          title: `${pet.name} falleció`,
          body: `Lamentamos avisarte que ${pet.name} falleció. Gracias por el tiempo que le diste como tránsito.`,
          relatedPetId: pet.id,
          relatedEventId: event.id,
          relatedCaseId: fosterCaseId ?? null,
          // no-cta: terminal condolence to the ex-foster; the foster relationship
          // ended with the death, so there is no actionable destination.
        });
      }

      // Close foster_placement case only when there were active fosters.
      if (fosterCaseId && activeFosters.length > 0) {
        await closeCase(
          { caseId: fosterCaseId, reason: "resolved", closedByUserId: recordedByUserId },
          tx as CaseExecutor,
        );
      }

      // CASCADE B: close custody_episode if the pet was intaked.
      if (custodyEpisodeCaseId) {
        await closeCase(
          { caseId: custodyEpisodeCaseId, reason: "resolved", closedByUserId: recordedByUserId },
          tx as CaseExecutor,
        );
      }

      // CASCADE D: a sponsored pet's death ends the sponsorship, in THIS
      // transaction, under the lock taken above, signed by whoever recorded
      // the death (the titular, an org member, a vet) on behalf of the
      // SPONSORING org — the cascade stamps that org itself. Null for the
      // overwhelmingly common case of a pet never sponsored nor requested.
      const sponsorshipEnd = await endSponsorshipForDeceasedPet(
        {
          petId: pet.id,
          petName: pet.name,
          recordedByUserId,
          authorRole: eventAuthorship.authorRole,
          authorVerified: eventAuthorship.authorVerified,
          now,
        },
        tx as Parameters<typeof endSponsorshipForDeceasedPet>[1],
      );
      if (sponsorshipEnd) {
        const orgTitle = sponsorshipEnd.ownershipId
          ? `${pet.name} falleció; el acompañamiento de adopción terminó`
          : `${pet.name} falleció; la solicitud de nuevo hogar quedó sin efecto`;
        const orgBody = sponsorshipEnd.ownershipId
          ? `Se registró el fallecimiento de ${pet.name}. El acompañamiento de adopción terminó: la publicación se retiró de la búsqueda de hogar y la custodia registral de tu organización quedó cerrada. No hay nada que hacer.`
          : `Se registró el fallecimiento de ${pet.name}; la solicitud de acompañamiento quedó cerrada. No hay nada que hacer.`;
        // UI-2: "nothing to do" still needs somewhere to look. The case the
        // cascade just closed stays readable by the org's members (the
        // adoption_listing / rehome_request branches of canReadCase key on
        // the org columns, not on the custody row this cascade ended); the
        // org's case queue is the fallback when a lost close left no case.
        const orgCaseCode =
          sponsorshipEnd.listingCasePublicCode ?? sponsorshipEnd.requestCasePublicCode;
        const orgCtaUrl = orgCaseCode
          ? `/casos/${orgCaseCode}`
          : sponsorshipEnd.sponsoringOrganizationPublicToken
            ? `/org/${sponsorshipEnd.sponsoringOrganizationPublicToken}/casos`
            : null;
        for (const userId of sponsorshipEnd.orgRecipientUserIds) {
          pendingNotifications.push({
            userId,
            notificationType: "rehome_sponsorship_ended_by_death",
            severity: "info",
            title: orgTitle,
            body: orgBody,
            ctaLabel: orgCtaUrl ? (orgCaseCode ? "Ver caso" : "Ver casos") : null,
            ctaUrl: orgCtaUrl,
            relatedPetId: pet.id,
            relatedEventId: event.id,
            relatedCaseId: sponsorshipEnd.listingCaseId ?? sponsorshipEnd.requestCaseId,
            category: "custody",
          });
        }
        for (const userId of sponsorshipEnd.strandedApplicantUserIds) {
          pendingNotifications.push({
            userId,
            notificationType: "adoption_application_closed",
            severity: "info",
            title: `Tu postulación por ${pet.name} quedó cerrada`,
            body: `Lamentamos avisarte que ${pet.name} falleció. Tu postulación quedó cerrada. No hace falta que hagas nada. Hay otras mascotas buscando hogar.`,
            ctaLabel: "Ver otras en adopción",
            ctaUrl: "/adoptar",
            relatedPetId: pet.id,
            relatedEventId: event.id,
            category: "adoption",
          });
        }
      }

      // CASCADE C: death-during-observation hook.
      if (wasInObservation) {
        const startedEvent = await deps.repo.findLatestRabiesObservationStarted(
          pet.id,
          tx as Parameters<typeof deps.repo.findLatestRabiesObservationStarted>[1],
        );
        if (startedEvent) {
          const startedPayload = startedEvent.payload as Record<string, unknown>;

          const endedPayload = validateEventPayload("rabies_observation_ended", {
            // Coalesced like the professional close: an observation may lack a
            // linked bite event, and the schema accepts null.
            bite_event_id: (startedPayload.bite_event_id as string | undefined) ?? null,
            observation_started_event_id: startedEvent.id,
            outcome: "dead",
            closed_by_role: observationCloser ? "vet" : "system",
            closure_notes: observationCloser
              ? VET_DEATH_CLOSURE_NOTES
              : "Cierre automático por fallecimiento durante observación",
            death_event_id: event.id,
          });

          await deps.repo.insertEvent(
            {
              petId: pet.id,
              eventType: "rabies_observation_ended",
              occurredAt: now,
              recordedAt: now,
              // D8: the vet who recorded the death also closed the observation,
              // and signs it as the professional close does. The owner's own
              // record keeps the system signature it always had.
              ...(observationCloser
                ? {
                    recordedByUserId: observationCloser.userId,
                    authorRole: "vet",
                    authorOrganizationId: observationCloser.organizationId,
                    authorVerified: true,
                  }
                : {
                    recordedByUserId: null,
                    authorRole: "system",
                    authorOrganizationId: null,
                    authorVerified: false,
                  }),
              payload: endedPayload,
              caseId: biteCaseId ?? null,
            } as Parameters<typeof deps.repo.insertEvent>[0],
            tx as Parameters<typeof deps.repo.insertEvent>[1],
          );

          if (observationCloser) {
            // The GUARDED close: `pet` was read before this transaction, so a
            // close that landed in between (another vet, the State, the sweep)
            // would otherwise leave two contradictory outcomes on the spine.
            // Throwing rolls back the death with it — nothing half-recorded.
            const closed = deps.closeObservationIfOpen
              ? await deps.closeObservationIfOpen(pet.id, "completed_dead", now, tx)
              : false;
            if (!closed) {
              throw new Error(
                "otra persona cerró esta observación mientras tanto — recargá para ver el resultado asentado",
              );
            }
            if (!deps.insertObservationCloseAuditLog) {
              throw new Error("createDeathRecord: veterinary closer without an audit writer");
            }
            await deps.insertObservationCloseAuditLog(
              {
                action: "rabies_observation_closed_professional",
                actorUserId: observationCloser.userId,
                payload: {
                  pet_id: pet.id,
                  pet_public_token: observationCloser.petPublicToken,
                  case_id: biteCaseId ?? null,
                  observation_started_event_id: startedEvent.id,
                  outcome: "dead",
                  closed_by_role: "vet",
                  closure_notes: VET_DEATH_CLOSURE_NOTES,
                  death_event_id: event.id,
                },
                before: { rabies_observation_status: pet.rabiesObservationStatus },
                after: { rabies_observation_status: "completed_dead" },
              },
              tx,
            );
          } else {
            await deps.repo.updateRabiesObservationStatus(
              pet.id,
              "completed_dead",
              now,
              tx as Parameters<typeof deps.repo.updateRabiesObservationStatus>[3],
            );
          }

          if (biteCaseId) {
            await closeCase(
              {
                caseId: biteCaseId,
                reason: "resolved",
                ...(observationCloser ? { closedByUserId: observationCloser.userId } : {}),
              },
              tx as CaseExecutor,
            );
          }

          rabiesObservationClosed = true;
        }
      }

      // D8: the veterinary door exists ONLY to close an observation with a
      // death. Anything else — no longer in observation, no started event — is
      // refused here, inside the transaction, so the death is not recorded
      // without the close it was meant to carry.
      if (observationCloser && !rabiesObservationClosed) {
        throw new Error("esta mascota no tiene una observación antirrábica en curso");
      }
    });
  } catch (err) {
    const code = pgErrorCode(err);
    if (code !== null && SERIALIZATION_CODES.has(code)) {
      return { ok: false, error: serializationRefusal(pet.name) };
    }
    return { ok: false, error: err instanceof Error ? err.message : "unknown error" };
  }

  // Post-tx: flush notifications (best-effort).
  await deps.flushNotifications(pendingNotifications);

  // Post-tx: signal authority report when disease is reportable.
  // G7: no longer a silent no-op — signalAuthorityReport durably records the
  // pending-transmission obligation (audit_log, v1_noop marker) and returns
  // the honest { delivered: false } state surfaced in this use-case's result.
  let authoritySignal: AuthoritySignalResult | null = null;
  if (isReportable && diseaseCode && insertedEventId) {
    authoritySignal = await signalAuthorityReport({
      eventId: insertedEventId,
      petId: pet.id,
      diseaseCode,
      confirmedByLab,
      occurredAt,
      jurisdictionProvince: pet.jurisdictionProvince ?? null,
      jurisdictionLocality: pet.jurisdictionLocality ?? null,
      reportedByUserId: recordedByUserId,
    });
  }

  // Post-tx: urgent authority fan-out when rabies observation was auto-closed by this death.
  //
  // THROUGH THE DURABLE SERVICE (2026-09-18). This was a raw
  // `db.insert(notifications)` whose catch only logged: no dedupe key, no
  // dead-letter. One transient error and the single most urgent thing this
  // module emits — an animal dead INSIDE a rabies observation window, whose
  // body the authority must sample — vanished, while the death itself stood
  // recorded. `createNotificationsBulk` dead-letters a failed write for the
  // retry cron and keys each row `event:{deathEventId}:{userId}:{type}`, so the
  // replay cannot double-alert.
  //
  // And a lookup that THROWS is not "nobody to tell": it falls back to the
  // national administrators — the set the resolver itself falls back to when a
  // jurisdiction has no authority — instead of skipping the alert.
  if (rabiesObservationClosed && insertedEventId) {
    const deathEventId: string = insertedEventId;
    // Null jurisdiction coerced, not skipped (2026-08-17): a death INSIDE a
    // rabies observation window is the single most urgent thing this module
    // emits, and the old guard dropped it silently whenever the animal's home
    // had never been geocoded.
    let authorityIds: string[] = [];
    try {
      authorityIds = await findAuthoritiesForJurisdiction(
        {
          province: pet.jurisdictionProvince ?? "",
          locality: pet.jurisdictionLocality ?? "",
        },
        { route: "rabies_observation_completed_dead_authority" },
      );
    } catch (lookupErr) {
      console.error(
        "[death] rabies-observation authority lookup failed; falling back to national admins:",
        lookupErr,
      );
      try {
        authorityIds = await activeHumanInstitutionalAdminIds();
      } catch (fallbackErr) {
        console.error(
          "[death] national-admin fallback failed too; death-in-observation alert has no recipient:",
          fallbackErr,
        );
      }
    }
    if (authorityIds.length > 0) {
      // The disposal is always named (compliant or not): the authority's
      // first question after a death-in-observation is whether the body
      // remains analyzable — "sin registrar" is itself signal.
      const dispositionSentence = `Disposición declarada: ${
        dispositionMethod ? dispositionMethodLabel(dispositionMethod) : "sin registrar"
      }${facility ? ` (${facility})` : ""}.`;
      const notificationType = "rabies_observation_completed_dead_authority";
      // Never throws: a failed write lands in notification_dead_letter.
      await createNotificationsBulk(
        [...new Set(authorityIds)].map((authorityId) => ({
          userId: authorityId,
          notificationType,
          severity: "urgent" as const,
          title: `URGENTE — fallecimiento durante observación antirrábica (${pet.name})`,
          body: `La mascota falleció dentro del período de 10 días de observación post-mordedura. Causa declarada: ${cause}. ${dispositionSentence} Requiere revisión inmediata por riesgo de rabia.`,
          relatedPetId: pet.id,
          relatedEventId: deathEventId,
          // Authority recipient: surveillance hub (cannot open /mis-mascotas).
          ctaLabel: "Ver vigilancia",
          ctaUrl: "/gob/vigilancia",
          dedupeKey: `event:${deathEventId}:${authorityId}:${notificationType}`,
        })),
      );
    }
  }

  // `resolvedEventId` is non-null on every path that reaches here: the
  // transaction either inserted a row or found the one the key already wrote.
  // A null would mean the transaction returned without touching the spine,
  // which the catch above has already turned into an error result.
  if (resolvedEventId === null) {
    return { ok: false, error: "createDeathRecord: the transaction resolved no event." };
  }

  return {
    ok: true,
    eventId: resolvedEventId,
    wasDuplicate,
    insertedEventId,
    rabiesObservationClosed,
    diseaseCode,
    authoritySignal,
  };
}

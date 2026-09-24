// Owner-facing alert for third-party clinical signatures.
//
// WHY (PO decision + QA, 2026-07-16): when a vet or an org member signs a
// clinical event (vaccination, deworming, clinical info, medication start,
// clinical note) on a pet whose owner is someone else — the QA-proven case is
// the Atender walk-in path — the owner previously got NOTHING. Lost/found
// alerts arrive instantly; a vaccination signed via Atender arrived silently.
//
// This helper closes that gap by mirroring the owner-alert path (see
// lib/infra/owner-disease-alerts.ts: resolve current human owners/co-owners,
// then enqueue one notification each) but routing through the canonical
// notification SERVICE (createNotification — idempotent + dead-lettered) as
// scripts/check-notifications-service.ts requires of all NEW code.
//
// Rules:
//   - THIRD-PARTY ONLY: an owner who signs on their own pet (authorUserId is
//     among the owners) is never notified about their own signature.
//   - Org-held pets with no human owner (ownerUserId=null) have no recipient.
//   - Best-effort: this runs POST-transaction; a failure here never rolls back
//     or blocks the clinical write that already committed.

import "server-only";

import { and, eq, inArray, isNull } from "drizzle-orm";

import { type EventType, db, ownerships } from "@/db";
import { createNotification } from "@/lib/infra/notification-service";
import { eventTypeLabel, formatDate } from "@/lib/utils/format";

export type ClinicalEventNotifyInput = {
  petId: string;
  petName: string;
  /** Public DIM token — used to build the owner's deep link into the record. */
  petPublicToken: string;
  eventId: string;
  eventType: EventType;
  /**
   * The clinical date the signer declared. Carried into the body because it is
   * the one fact the notification list cannot show on its own: the row's own
   * createdAt says WHEN IT WAS RECORDED, and a walk-in signature whose declared
   * date sits far from that is exactly what an owner needs to see.
   */
  occurredAt: Date;
  /** The signer's user id — never notified about their own signature. */
  authorUserId: string;
  /** How the signer is named to the owner (e.g. the clinic / refugio name). */
  authorLabel: string;
  /**
   * OPTIONAL — the words, when "a new record in the libreta" is not the whole
   * truth. See ClinicalEventOwnerNotice. Omitted by every clinical writer.
   */
  notice?: ClinicalEventOwnerNotice;
};

/**
 * The notice itself, for the one walk-in act whose news is not "a new record":
 * the close of a rabies observation (Ley 22.953). Its owner notice has to carry
 * the RESULT, has to be urgent for a confirmed rabies, and cannot promise "abrí
 * el registro para corregirlo" — a rabies close is not an event the owner can
 * amend. It also needs its own notificationType: under the shared
 * `clinical_event_recorded` the inbox would fold a confirmed rabies behind
 * "+ N más del mismo tipo" with the vaccines of the same consultation.
 *
 * ONLY THE WORDS CHANGE. Who receives it (every active owner and co-owner), the
 * third-party rule, the deep link to the event and the durable write with a
 * deterministic dedupe key stay this helper's — which is the point of routing
 * the close through here instead of beside it. The body is the caller's, so the
 * caller is the one who must name the clinic; the veterinary close does, and
 * its action test pins it.
 */
export type ClinicalEventOwnerNotice = {
  notificationType: string;
  severity: "info" | "urgent";
  title: string;
  body: string;
  relatedCaseId: string | null;
  /**
   * Where the notice sends the owner. Omitted: the event's own page, the
   * default every clinical notice uses. A caller whose event is terminal (a
   * death) points at the pet instead, and states it at the call site so the
   * CTA-fitness fence can see an urgent notice's destination.
   */
  ctaLabel?: string;
  ctaUrl?: string;
};

export type ClinicalEventNotifyDeps = {
  /** Resolve current human owner/co-owner user ids for a pet. */
  findOwnerUserIds: (petId: string) => Promise<string[]>;
  createNotification: typeof createNotification;
};

/** Default deps: real ownerships query + the canonical notification service. */
const defaultDeps: ClinicalEventNotifyDeps = {
  findOwnerUserIds: async (petId: string) => {
    const rows = await db
      .select({ userId: ownerships.ownerUserId })
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petId),
          inArray(ownerships.role, ["owner", "co_owner"]),
          isNull(ownerships.endedAt),
        ),
      );
    return rows
      .map((r) => r.userId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  },
  createNotification,
};

export type ClinicalEventNotifyResult = { delivered: number };

/**
 * Enqueue an owner notification for a clinical event authored by a third
 * party. Idempotent (dedupeKey per owner+event) and best-effort — it swallows
 * its own errors so the already-committed clinical write is never affected.
 */
export async function notifyOwnersOfClinicalEvent(
  input: ClinicalEventNotifyInput,
  deps: ClinicalEventNotifyDeps = defaultDeps,
): Promise<ClinicalEventNotifyResult> {
  try {
    const ownerIds = await deps.findOwnerUserIds(input.petId);
    // Third-party rule: drop the author (and dedupe co-owner rows).
    const recipients = [...new Set(ownerIds)].filter((id) => id !== input.authorUserId);
    if (recipients.length === 0) return { delivered: 0 };

    // Reuse the shared event vocabulary rather than inventing labels. Lower the
    // first letter so it reads naturally mid-sentence ("registró vacuna…").
    const label = eventTypeLabel(input.eventType);
    const eventLabelInline = label.charAt(0).toLowerCase() + label.slice(1);

    let delivered = 0;
    for (const userId of recipients) {
      if (input.notice) {
        const res = await deps.createNotification({
          userId,
          notificationType: input.notice.notificationType,
          category: "health",
          severity: input.notice.severity,
          title: input.notice.title,
          body: input.notice.body,
          ctaLabel: input.notice.ctaLabel ?? "Ver el registro",
          ctaUrl:
            input.notice.ctaUrl ?? `/mis-mascotas/${input.petPublicToken}/eventos/${input.eventId}`,
          relatedPetId: input.petId,
          relatedEventId: input.eventId,
          relatedCaseId: input.notice.relatedCaseId,
          // Keyed on the event AND the type, so it can never collide with the
          // generic notice's key for the same event.
          dedupeKey: `event:${input.eventId}:${userId}:${input.notice.notificationType}`,
        });
        if (res.status === "inserted") delivered += 1;
        continue;
      }
      const res = await deps.createNotification({
        userId,
        // NOISE: one notification per event, deliberately — the inbox already
        // owns the collapsing. groupNotifications() (app/(app)/notificaciones/
        // notification-ordering.ts) buckets by `relatedPetId|notificationType`
        // and folds ≥3 of a bucket behind "+ N más del mismo tipo". A vet who
        // loads five vaccines in one consultation therefore renders as ONE card
        // plus a disclosure, WITHOUT a bespoke digest here — but only while both
        // of these stay CONSTANT across event types. Varying notificationType
        // per event (e.g. "vaccination_recorded") would silently unfold the
        // group back into five cards; notify-owners-of-clinical-event.test.ts
        // pins that against the real grouper.
        notificationType: "clinical_event_recorded",
        category: "health",
        // info, not warning: the overwhelming majority of these are legitimate
        // care. It also keeps the row out of the urgent-only Web Push leg.
        severity: "info",
        title: `Nuevo registro en la libreta de ${input.petName}`,
        body: `${input.authorLabel} registró ${eventLabelInline} con fecha ${formatDate(
          input.occurredAt,
        )}. Si no reconocés esta atención, abrí el registro para revisarlo o corregirlo.`,
        ctaLabel: "Ver el registro",
        // Deep-link to the EVENT, not the libreta: that page is where the
        // owner's "Corregir registro" affordance lives, so the recourse the body
        // promises is one tap away.
        ctaUrl: `/mis-mascotas/${input.petPublicToken}/eventos/${input.eventId}`,
        relatedPetId: input.petId,
        relatedEventId: input.eventId,
        dedupeKey: `event:${input.eventId}:${userId}:clinical_recorded`,
      });
      if (res.status === "inserted") delivered += 1;
    }
    return { delivered };
  } catch (err) {
    console.error("[notifyOwnersOfClinicalEvent] failed (clinical event did persist):", err);
    return { delivered: 0 };
  }
}

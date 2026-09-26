// The amendment's legal-queue leg (PO S9, 2026-09-26): after a correction is
// appended, re-read the corrected record BEFORE and AFTER it and let the
// outbox rules decide whether the legal queue must create or tighten a record
// (lib/events/event-outbox-reevaluate.ts). Inside the correction's
// transaction; a no-op for every event type with no outbox rule.

import { and, eq, sql } from "drizzle-orm";

import { type db, petEvents, pets } from "@/db";
import { reevaluateOutboxAfterAmendment } from "@/lib/events/event-outbox-reevaluate";
import { OUTBOX_RULES } from "@/lib/events/event-outbox-rules";
import { overlayAmendments } from "@/lib/infra/amendment";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function reevaluateLegalQueueAfterAmendment(
  tx: Tx,
  input: { petId: string; rootEventId: string; amendmentEventId: string; actorUserId: string },
): Promise<void> {
  const [root] = await tx
    .select({
      id: petEvents.id,
      petId: petEvents.petId,
      eventType: petEvents.eventType,
      occurredAt: petEvents.occurredAt,
      recordedAt: petEvents.recordedAt,
      payload: petEvents.payload,
      authorRole: petEvents.authorRole,
      authorVerified: petEvents.authorVerified,
    })
    .from(petEvents)
    .where(and(eq(petEvents.id, input.rootEventId), eq(petEvents.petId, input.petId)))
    .limit(1);
  if (!root || !(root.eventType in OUTBOX_RULES)) return;

  const amendments = await tx
    .select({
      id: petEvents.id,
      petId: petEvents.petId,
      eventType: petEvents.eventType,
      occurredAt: petEvents.occurredAt,
      recordedAt: petEvents.recordedAt,
      payload: petEvents.payload,
    })
    .from(petEvents)
    .where(
      and(
        eq(petEvents.petId, input.petId),
        eq(petEvents.eventType, "event_amended"),
        sql`${petEvents.payload}->>'target_event_id' = ${input.rootEventId}`,
      ),
    );

  const effective = (stream: typeof amendments) =>
    overlayAmendments([root, ...stream]).find((e) => e.id === root.id)?.payload as Record<
      string,
      unknown
    >;
  const before = effective(amendments.filter((a) => a.id !== input.amendmentEventId));
  const after = effective(amendments);

  const [pet] = await tx
    .select({
      jurisdictionProvince: pets.jurisdictionProvince,
      jurisdictionLocality: pets.jurisdictionLocality,
      localityId: pets.localityId,
      placeMethod: pets.placeMethod,
    })
    .from(pets)
    .where(eq(pets.id, input.petId))
    .limit(1);

  await reevaluateOutboxAfterAmendment(tx, {
    root: {
      id: root.id,
      petId: root.petId,
      eventType: root.eventType,
      occurredAt: root.occurredAt,
      author: { authorRole: root.authorRole, authorVerified: root.authorVerified },
    },
    before,
    after,
    amendmentEventId: input.amendmentEventId,
    actorUserId: input.actorUserId,
    pet: pet ?? {},
  });
}

// Re-derive pets.pregnancyStatus from the spine, inside the caller's tx.
//
// WHY (cowork audit finding #4 sibling, 2026-08-12). Both pregnancy writers used
// to set the column to the value implied by the event they had just inserted:
// "started" → in_progress, "ended" → completed_{outcome}. The canonical
// projection (replayPetPregnancy) is LATEST-BY-occurredAt, and both writers take
// `occurredAt` from the caller — so recording a start with a back-dated
// occurredAt after a pregnancy had already ended left the cache saying
// "in_progress" while the event log said "completed_live_birth".
//
// pregnancyStatus IS covered by detect-pet-cache-drift.ts, so that drift was at
// least visible — but Invariant #3's promise is that normal operation does not
// CREATE drift, not merely that we can find it afterwards. Deriving costs one
// indexed read per pregnancy write and makes the cache a function of the log.
//
// Mirrors EventsRepository.updateWeightProjection, which was fixed the same way
// in the same commit.

import { and, asc, eq, inArray } from "drizzle-orm";

import { type db, petEvents, pets } from "@/db";
import { overlayAmendments } from "@/lib/infra/amendment";
import { replayPetPregnancy } from "@/lib/projections/pet-pregnancy";
import type { ProjectionEvent } from "@/lib/projections/types";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function rederivePregnancyStatus(tx: Tx, petId: string): Promise<void> {
  // Only clinical_info_logged carries pregnancy phases (replayPetPregnancy skips
  // everything else), so narrowing the read keeps the result identical — PLUS
  // `event_amended`, which the overlay needs to fold a corrected outcome
  // (A08-G2). Replaying the raw rows here reverted an amended pregnancy result
  // on the next pregnancy write, exactly as refreshPregnancy had just fixed it.
  const events = await tx
    .select({
      id: petEvents.id,
      eventType: petEvents.eventType,
      occurredAt: petEvents.occurredAt,
      recordedAt: petEvents.recordedAt,
      payload: petEvents.payload,
    })
    .from(petEvents)
    .where(
      and(
        eq(petEvents.petId, petId),
        inArray(petEvents.eventType, ["clinical_info_logged", "event_amended"]),
      ),
    )
    .orderBy(asc(petEvents.occurredAt), asc(petEvents.recordedAt), asc(petEvents.id));

  const { pregnancyStatus } = replayPetPregnancy(overlayAmendments(events as ProjectionEvent[]));

  await tx.update(pets).set({ pregnancyStatus }).where(eq(pets.id, petId));
}

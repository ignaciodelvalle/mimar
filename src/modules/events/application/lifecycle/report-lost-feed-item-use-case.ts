// Use-case: reportLostFeedItem
//
// Backs "Reportar" on a lost-mode feed row — the affordance that answers YES to
// Google Play's IARC question "can users report content".
//
// WHAT IT WRITES AND WHAT IT REFUSES TO WRITE
// ---------------------------------------------------------------------------
// It appends ONE `content_reported` event naming the reported row in
// `payload.target_event_id`. It does NOT touch the reported row — invariant #2
// makes that unavailable, and the design is better for it: the message and the
// objection to it are two facts, both true, both kept. The item leaves the feed
// because every read subtracts the reported ids
// (`lib/infra/lost-mode.ts::notReportedClause`), so "ocultar" is a derivation
// and never a mutation.
//
// WHAT THE FINDER EXPERIENCES: NOTHING, and a future reader should not have to
// guess. The two reportable kinds are written by anonymous members of the public
// through `/p/{token}/sighting` and `/p/{token}/encontre`. They hold no account,
// there is no surface on which they could see their own submission again, and
// nothing here notifies them. That is not an omission to fix later — it is the
// same fact that makes "block this user" meaningless on this surface: there is
// no user. The report is a control the OWNER holds over their OWN cockpit.
//
// WHY IT IS IDEMPOTENT WITHOUT AN `Idempotency-Key`
// ---------------------------------------------------------------------------
// Reporting the same item twice is not two facts. The writer probes for an
// existing report on the same target and returns `alreadyReported` without
// appending — the same shape `setPetDisclosurePrefs` uses for a preference
// already set to the requested value. The endpoint therefore demands no header,
// which is the rule its contract states: the split is "idempotent on the STATE",
// never "appends or not".
//
// THE PROBE RACES, AND THE RACE IS BENIGN. Two concurrent reports of one item
// can both see "not reported" and both append. The result is two rows saying the
// same true thing and ONE hidden item, because the exclusion is a set membership
// and not a count. A unique index would cost a migration to prevent a duplicate
// nobody reads; this comment is cheaper and the outcome is identical.
//
// THE TARGET GUARD IS THE AUTHORIZATION BOUNDARY'S SECOND HALF. The caller was
// already resolved against THIS pet by `resolvePetHolderAccess`; this checks the
// target belongs to the same pet and is one of the two authored kinds. Without
// it, a holder of pet A could name an event of pet B and hide a row from a feed
// that is not theirs — the guard on the door says nothing about the id in the
// body.

import { and, eq, sql } from "drizzle-orm";

import { db, petEvents } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import type { ContentReportCategory } from "@dim/contract/events";
import { CONTENT_REPORT_TARGET_KINDS } from "@dim/contract/events";

import type { EventsRepository } from "../../infrastructure/events-repository";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReportLostFeedItemParams = {
  petId: string;
  /** The `pet_events.id` the person tapped — a feed item's `id`. */
  targetEventId: string;
  category: ContentReportCategory;
  /** The reporter's own words, or null. Stored under the key `reason`. */
  reason: string | null;
  recordedByUserId: string;
  eventAuthorship: {
    authorRole: string;
    authorOrganizationId: string | null;
    authorVerified: boolean;
  };
  now?: Date;
};

export type ReportLostFeedItemResult = {
  /** `"TARGET_INVALID"`, or null on success. */
  error: "TARGET_INVALID" | null;
  /** True when this exact item was already reported; nothing was appended. */
  alreadyReported: boolean;
};

type Deps = {
  repo: Pick<EventsRepository, "insertEvent">;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

/** What the target row has to be before anything is written about it. */
type TargetRow = {
  id: string;
  caseId: string | null;
  kind: string | null;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function reportLostFeedItem(
  params: ReportLostFeedItemParams,
  deps: Deps,
): Promise<ReportLostFeedItemResult> {
  const {
    petId,
    targetEventId,
    category,
    reason,
    recordedByUserId,
    eventAuthorship,
    now = new Date(),
  } = params;

  // ONE QUERY FOR THREE REFUSALS. The row must exist, belong to THIS pet, be a
  // `note_added`, and carry one of the two authored kinds. Anything else is
  // `TARGET_INVALID` — the endpoint maps all of it to one code on purpose, so
  // this command cannot be used to learn which event ids are real.
  const [target] = await db
    .select({
      id: petEvents.id,
      caseId: petEvents.caseId,
      kind: sql<string | null>`${petEvents.payload}->>'kind'`,
    })
    .from(petEvents)
    .where(
      and(
        eq(petEvents.id, targetEventId),
        eq(petEvents.petId, petId),
        eq(petEvents.eventType, "note_added"),
      ),
    )
    .limit(1);

  const targetRow = target as TargetRow | undefined;
  if (!targetRow) return { error: "TARGET_INVALID", alreadyReported: false };

  const targetKind = (CONTENT_REPORT_TARGET_KINDS as readonly string[]).includes(
    targetRow.kind ?? "",
  )
    ? (targetRow.kind as (typeof CONTENT_REPORT_TARGET_KINDS)[number])
    : null;
  if (targetKind === null) return { error: "TARGET_INVALID", alreadyReported: false };

  // Already reported? Scoped to the PET and not only to the target id, so the
  // probe cannot be satisfied by a report somebody else's animal carries.
  const [existing] = await db
    .select({ id: petEvents.id })
    .from(petEvents)
    .where(
      and(
        eq(petEvents.petId, petId),
        eq(petEvents.eventType, "content_reported"),
        sql`${petEvents.payload}->>'target_event_id' = ${targetEventId}`,
      ),
    )
    .limit(1);

  if (existing) return { error: null, alreadyReported: true };

  const payload = validateEventPayload("content_reported", {
    surface: "lost_feed",
    target_event_id: targetEventId,
    target_kind: targetKind,
    category,
    reason,
  });

  await deps.transaction((tx) =>
    deps.repo.insertEvent(
      {
        petId,
        eventType: "content_reported",
        occurredAt: now,
        recordedAt: now,
        recordedByUserId,
        ...eventAuthorship,
        payload,
        // THE TARGET'S OWN CASE, copied rather than looked up. The reported row
        // was already scoped to the episode whose feed carried it, so this files
        // the objection beside the thing objected to — and it stays right even
        // if the episode has since closed, which a fresh `findOpenCase` would
        // not.
        caseId: targetRow.caseId,
      } as Parameters<typeof deps.repo.insertEvent>[0],
      tx as Parameters<typeof deps.repo.insertEvent>[1],
    ),
  );

  return { error: null, alreadyReported: false };
}

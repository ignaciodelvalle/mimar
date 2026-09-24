// Use-case: loadPetEventDetail — ONE asiento, with its correction history and
// its files.
//
// WHY IT EXISTS
// ---------------------------------------------------------------------------
// The web's event detail screen
// (`app/(app)/mis-mascotas/[publicToken]/eventos/[eventId]/page.tsx`) does this
// work inline in a page body: four queries, an amendment overlay, and a signed
// URL per attachment, interleaved with the JSX. That is fine for exactly one
// consumer and impossible for two — and the native client is the second.
//
// SCOPED BY PET, NOT BY EVENT ID ALONE, and that is security rather than
// tidiness. The caller authorizes a PET; the event id arrives from a client.
// Every query below carries `pet_id`, so a caller holding pet A cannot read (or
// sign the attachments of) pet B's clinical record by passing B's event id. It
// is the same fence `sign-timeline-attachments.ts` writes about at length, kept
// here because this reader has the same shape and the same exposure.
//
// THE CORRECTED PAYLOAD AND THE ORIGINAL BOTH COME BACK, and the naming is
// deliberate: `payload` is what is TRUE about the animal now, `originalPayload`
// is what was written the first time. A caller that renders `originalPayload`
// as if it were current has undone the whole point of an append-only
// correction; it is here so a caller can show what CHANGED, which is the one
// thing the corrected value alone cannot say.
//
// NO AUTH HERE. The caller resolves pet access first — the web page through
// `requireOwnedPetByToken`, the native endpoint through
// `resolvePetHolderAccess`. This reader takes an already-resolved `petId`.
//
// AND NO SIGNED URL. Attachments come back as storage paths. Minting a signed
// URL is equivalent to handing out the file (lib/infra/storage.ts), so the
// decision to hand one over lives at the boundary that also decided the caller
// may see it — not inside a reader that any future caller might reach for.

import { and, asc, eq, sql } from "drizzle-orm";

import { attachments, db, organizations, petEvents } from "@/db";
import type { EventType } from "@/db/schema";
import { upcastPayload } from "@/lib/events/event-upcasters";
import { type ChangeEntry, applyAmendments } from "@/lib/infra/amendment";
import { notReportedClause } from "@/lib/infra/content-reports";

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** One correction, oldest-first within `PetEventDetailRead.amendments`. */
export type PetEventAmendmentStep = {
  amendmentId: string;
  occurredAt: Date;
  reason: string | null;
  actorRole: string;
  /**
   * The correction's signing columns — who wrote it, for the authorship rule
   * (PO decision 3B): an owner may not overwrite a correction a professional
   * made. Never put on a wire; the payload builder reads them to decide
   * `amend.canAmend` and nothing else.
   */
  authorRole: string;
  authorVerified: boolean;
  recordedByUserId: string | null;
  recordedAt: Date;
  changes: ChangeEntry[];
};

/** One file on the event. A PATH, never a URL — see the module header. */
export type PetEventAttachmentRow = {
  id: string;
  mimeType: string;
  storagePath: string;
};

export type PetEventDetailRead = {
  id: string;
  eventType: string;
  /** Upcast and fully corrected — what is true about the animal NOW. */
  payload: Record<string, unknown>;
  /** Upcast, pre-correction. Never render this as current; see the header. */
  originalPayload: Record<string, unknown>;
  occurredAt: Date;
  recordedAt: Date;
  notes: string | null;
  authorRole: string;
  authorVerified: boolean;
  authorOrganizationId: string | null;
  /** Display name of the signing organization. NEVER an individual's name. */
  authorOrgName: string | null;
  recordedByUserId: string | null;
  locationLat: unknown;
  locationLng: unknown;
  /** Oldest-first. Empty when this record was never corrected. */
  amendments: PetEventAmendmentStep[];
  attachments: PetEventAttachmentRow[];
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

type EventRow = {
  id: string;
  eventType: string;
  payload: unknown;
  occurredAt: Date;
  recordedAt: Date;
  notes: string | null;
  authorRole: string;
  authorVerified: boolean;
  authorOrganizationId: string | null;
  recordedByUserId: string | null;
  locationLat: unknown;
  locationLng: unknown;
};

/** The event itself, fenced by pet. */
export async function readEventRow(petId: string, eventId: string): Promise<EventRow | null> {
  const rows = await db
    .select({
      id: petEvents.id,
      eventType: petEvents.eventType,
      payload: petEvents.payload,
      occurredAt: petEvents.occurredAt,
      recordedAt: petEvents.recordedAt,
      notes: petEvents.notes,
      authorRole: petEvents.authorRole,
      authorVerified: petEvents.authorVerified,
      authorOrganizationId: petEvents.authorOrganizationId,
      recordedByUserId: petEvents.recordedByUserId,
      locationLat: petEvents.locationLat,
      locationLng: petEvents.locationLng,
    })
    .from(petEvents)
    // Reached BY ID, which is why it needs the clause at all: a row subtracted
    // from every listing is still addressable by URL without it. A reported
    // item answers "not found" here, which is the same answer the listings give
    // by omission.
    .where(and(eq(petEvents.id, eventId), eq(petEvents.petId, petId), notReportedClause()))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * EVERY correction targeting this event, oldest-first.
 *
 * Not `fetchLatestAmendmentsForEvents`, which answers a different question: the
 * timeline needs the LATEST correction to project a value, and this screen needs
 * the WHOLE chain, because "this record was corrected" and "this record was
 * corrected three times, and here is what each one changed" are different facts
 * and only the second one is a history.
 *
 * Ordered by `(occurred_at, recorded_at, id)` — the SAME tiebreak
 * `overlayAmendments` and the SQL twin use, read in the opposite direction. A
 * chain that folded in a different order than the timeline projects would show a
 * history that does not add up to the value on screen.
 *
 * `amend-event.ts` always resolves the ROOT event as the target, so this is one
 * hop deep by construction — an amendment of an amendment still points here.
 */
export async function readAmendmentChain(
  petId: string,
  targetEventId: string,
): Promise<PetEventAmendmentStep[]> {
  const rows = await db
    .select({
      id: petEvents.id,
      occurredAt: petEvents.occurredAt,
      payload: petEvents.payload,
      authorRole: petEvents.authorRole,
      authorVerified: petEvents.authorVerified,
      recordedByUserId: petEvents.recordedByUserId,
      recordedAt: petEvents.recordedAt,
    })
    .from(petEvents)
    // Filtered by TARGET in SQL, not after the fact in JS: the result is
    // bounded by the record (its own corrections) rather than by every
    // correction the animal ever had. Not capped with a limit — that would
    // bound it by dropping rows, and a dropped professional correction is one
    // the authorship rule must see (fresh-context security review, item 4).
    .where(
      and(
        eq(petEvents.petId, petId),
        eq(petEvents.eventType, "event_amended"),
        sql`${petEvents.payload}->>'target_event_id' = ${targetEventId}`,
      ),
    )
    .orderBy(asc(petEvents.occurredAt), asc(petEvents.recordedAt), asc(petEvents.id));

  const steps: PetEventAmendmentStep[] = [];
  for (const row of rows) {
    const p = (row.payload ?? {}) as Record<string, unknown>;
    if (p.target_event_id !== targetEventId) continue;
    steps.push({
      amendmentId: row.id,
      occurredAt: row.occurredAt,
      reason: typeof p.reason === "string" ? p.reason : null,
      actorRole: typeof p.actor_role === "string" ? p.actor_role : "owner",
      authorRole: row.authorRole,
      authorVerified: row.authorVerified,
      recordedByUserId: row.recordedByUserId,
      recordedAt: row.recordedAt,
      changes: Array.isArray(p.changes) ? (p.changes as ChangeEntry[]) : [],
    });
  }
  return steps;
}

/** The event's files, fenced by pet as well as by event. */
export async function readEventAttachments(
  petId: string,
  eventId: string,
): Promise<PetEventAttachmentRow[]> {
  const rows = await db
    .select({
      id: attachments.id,
      mimeType: attachments.mimeType,
      storagePath: attachments.storagePath,
    })
    .from(attachments)
    .where(and(eq(attachments.petId, petId), eq(attachments.eventId, eventId)));
  return rows;
}

/** The signing organization's display name, or null. Never a person's name. */
export async function readOrganizationName(organizationId: string): Promise<string | null> {
  const rows = await db
    .select({ displayName: organizations.displayName })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return rows[0]?.displayName ?? null;
}

export type PetEventDetailDeps = {
  readEventRow: typeof readEventRow;
  readAmendmentChain: typeof readAmendmentChain;
  readEventAttachments: typeof readEventAttachments;
  readOrganizationName: typeof readOrganizationName;
};

const PRODUCTION_DEPS: PetEventDetailDeps = {
  readEventRow,
  readAmendmentChain,
  readEventAttachments,
  readOrganizationName,
};

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

/**
 * One event of one pet, or `null` when the pet has no such event.
 *
 * NULL IS THE ONLY "not here" ANSWER, and it does not distinguish "no such
 * event" from "that event belongs to another animal". The caller answers 404 to
 * both, which is what keeps this from becoming a probe for which event ids
 * exist.
 *
 * THROWS nothing of its own — the caller owns the time budget, the same split
 * `loadOwnerPetDetail` documents.
 */
export async function loadPetEventDetail(
  input: { petId: string; eventId: string },
  deps: PetEventDetailDeps = PRODUCTION_DEPS,
): Promise<PetEventDetailRead | null> {
  const event = await deps.readEventRow(input.petId, input.eventId);
  if (!event) return null;

  const [amendments, files, orgName] = await Promise.all([
    deps.readAmendmentChain(input.petId, event.id),
    deps.readEventAttachments(input.petId, event.id),
    event.authorOrganizationId
      ? deps.readOrganizationName(event.authorOrganizationId)
      : Promise.resolve(null),
  ]);

  // UPCAST FIRST, THEN CORRECT — the order `overlayAmendments` uses, and it
  // matters: a payload_version bump would otherwise hand a reader a stale-shaped
  // payload with a correction layered onto the wrong field names.
  const originalPayload = (upcastPayload(event.eventType as EventType, event.payload) ??
    {}) as Record<string, unknown>;

  // Folded ONCE here rather than at each call site, and through the SHARED
  // helper rather than a local spread: `applyAmendments` owns the "latest wins"
  // rule the timeline also projects, and a second implementation of it is how
  // one screen starts showing a different correction than the other. The chain
  // is re-shaped into that helper's row type rather than the helper being
  // loosened — every amendment here targets this event by construction.
  const payload =
    amendments.length > 0
      ? applyAmendments(
          originalPayload,
          amendments.map((a) => ({ ...a, id: a.amendmentId, targetEventId: event.id })),
        )
      : originalPayload;

  return {
    id: event.id,
    eventType: event.eventType,
    payload,
    originalPayload,
    occurredAt: event.occurredAt,
    recordedAt: event.recordedAt,
    notes: event.notes,
    authorRole: event.authorRole,
    authorVerified: event.authorVerified,
    authorOrganizationId: event.authorOrganizationId,
    authorOrgName: orgName,
    recordedByUserId: event.recordedByUserId,
    locationLat: event.locationLat,
    locationLng: event.locationLng,
    amendments,
    attachments: files,
  };
}

// The projection from one event's domain read onto its wire shape.
//
// It mirrors the WEB event-detail screen, section for section: the type's name
// as an eyebrow, the record's headline and secondary line, when it happened and
// when it was written, the notes, the point, the curated field list, the
// correction history and the files. The web page does all of that inline; this
// answers the separate question of what a client may HOLD.
//
// THE CORRECTION HISTORY IS DERIVED, NOT ECHOED
// ---------------------------------------------------------------------------
// The spine's `event_amended` payload carries a `changes` array of
// `{field, old, new}` over RAW payload keys, and the amend form lets an owner
// edit ANY key of the record. Echoing that array onto a citizen surface would
// put un-curated key names — and their values — exactly where the H3 whitelist
// exists to keep them out of.
//
// So each step's visible change list is derived by running the SAME curated
// projection (`eventPayloadDetails`) over the record BEFORE and AFTER that step
// and diffing the es-AR rows. It reuses the whitelist instead of writing a
// second one, it speaks in labels rather than column names, and a step that
// moved nothing curated still appears with an empty list: the correction
// happened, and a history that hid it would be worse than one that cannot say
// what it touched.
//
// SIGNING HAPPENS HERE, AND ONLY HERE
// ---------------------------------------------------------------------------
// The reader hands back storage PATHS. This module takes a signer as an
// argument, so the decision to hand a file over sits next to the code that also
// decided the caller may see it — and so the tests can prove the TTL travels
// without touching Storage. `expiresAt` is computed from the SAME number handed
// to the signer, because two constants that agree today are two constants.

import type { EventType } from "@/db/schema";
import { authorRoleLabel } from "@/lib/events/author-role-labels";
import { eventPayloadDetails, eventPayloadSummary } from "@/lib/events/events";
import {
  AMEND_AUTHORSHIP_REFUSAL_COPY,
  type TitularTenure,
  amendAuthorshipRefusal,
  isAmendableEventType,
} from "@/lib/infra/amendment";
import { apiV1Envelope } from "@/lib/infra/api-v1";
import { eventTypeLabel } from "@/lib/utils/format";
import type { PetEventDetailRead } from "@/src/modules/events/application/read/load-pet-event-detail";
import type {
  EventAmendmentV1,
  EventAttachmentV1,
  EventFactV1,
  PetEventDetailV1,
} from "@dim/contract/api";
import {
  EVENT_ATTACHMENT_LINK_TTL_SECONDS,
  PET_EVENT_DETAIL_PAYLOAD_VERSION,
  PET_EVENT_DETAIL_STALE_AFTER_MS,
} from "@dim/contract/api";

/** Signs one storage path for `ttlSeconds`, or answers null when it cannot. */
export type AttachmentSigner = (storagePath: string, ttlSeconds: number) => Promise<string | null>;

/**
 * es-AR sentences for every reason a record refuses correction.
 *
 * They are the SCREEN's copy, not an error channel, and they say the same thing
 * the web says in the same situation — with one deliberate rewording. The
 * server action's allowlist refusal interpolates the raw event type
 * (`El tipo de evento "vaccination_administered" no admite enmiendas.`); an
 * internal slug has no business on a citizen surface, and the screen already
 * shows the type's es-AR name in its own eyebrow.
 */
export const AMEND_REFUSAL = {
  notAmendableType: "Este tipo de registro no admite correcciones.",
  deceased: "Esta mascota está registrada como fallecida y no acepta nuevos eventos.",
  notHolder: "Solo quien tiene la mascota a su cargo puede corregir un registro.",
  // PO decision 3B — the same sentences the use-case refuses with.
  professionalAuthored: AMEND_AUTHORSHIP_REFUSAL_COPY.professional_authored,
  notAuthor: AMEND_AUTHORSHIP_REFUSAL_COPY.not_author,
} as const;

/**
 * Whether this viewer may correct this record, and why not when they may not.
 *
 * THE ORDER OF THE REFUSALS IS THE ORDER THE SERVER APPLIES THEM, so the
 * sentence a client shows is the one it would actually get back. Deceased
 * first: it refuses every event type, so reporting "this type is not amendable"
 * on a deceased animal would send someone looking for a different record to
 * correct.
 */
export function resolveAmendAffordance(input: {
  eventType: string;
  accessPath: "owner" | "org";
  petStatus: string;
  /**
   * Who is reading, for the authorship rule (PO decision 3B). Only the person
   * path reaches it — the org path is refused above — so the viewer is always a
   * `person` actor here. An admin/govt profile holding the animal on the
   * person path would be allowed by the server's override and is under-offered
   * here; stated rather than fetched, because that population is a handful of
   * staff accounts and the door still honours the full rule.
   */
  viewer: { userId: string; titularTenures: ReadonlyArray<TitularTenure> };
  /** The record's authorship and its correction chain's. */
  authorship: {
    authorRole: string;
    authorVerified: boolean;
    recordedByUserId: string | null;
    recordedAt: Date;
    amendments: ReadonlyArray<{
      authorRole: string;
      authorVerified: boolean;
      recordedByUserId: string | null;
      recordedAt: Date;
      actorRole: string;
    }>;
  };
}): { canAmend: boolean; refusal: string | null } {
  if (input.petStatus === "deceased") return { canAmend: false, refusal: AMEND_REFUSAL.deceased };
  // The web's own affordance: the "Corregir registro" button renders for the
  // person path only, never for an org/vet member — narrower than the server
  // action's guard, and mirrored rather than widened.
  if (input.accessPath !== "owner") return { canAmend: false, refusal: AMEND_REFUSAL.notHolder };
  if (!isAmendableEventType(input.eventType)) {
    return { canAmend: false, refusal: AMEND_REFUSAL.notAmendableType };
  }
  // Last, because it is the one that depends on WHICH record — the server
  // checks it after the type too.
  const refusal = amendAuthorshipRefusal(
    {
      userId: input.viewer.userId,
      standing: "person",
      titularTenures: input.viewer.titularTenures,
    },
    [
      {
        authorRole: input.authorship.authorRole,
        authorVerified: input.authorship.authorVerified,
        recordedByUserId: input.authorship.recordedByUserId,
        recordedAt: input.authorship.recordedAt,
      },
      ...input.authorship.amendments,
    ],
  );
  if (refusal === "professional_authored") {
    return { canAmend: false, refusal: AMEND_REFUSAL.professionalAuthored };
  }
  if (refusal === "not_author") return { canAmend: false, refusal: AMEND_REFUSAL.notAuthor };
  return { canAmend: true, refusal: null };
}

/** The curated rows of one payload state, keyed by their es-AR label. */
function curatedRows(eventType: string, payload: Record<string, unknown>): Map<string, string> {
  return new Map(eventPayloadDetails(eventType, payload).map((row) => [row.label, row.value]));
}

/**
 * What ONE correction changed, in curated labels.
 *
 * Labels present on one side only report `null` for the other, which is how a
 * field that was EMPTY and got filled in (or the reverse) reads honestly — the
 * curated projection omits empty values entirely, so an absent row is "no
 * había dato", not "unchanged".
 */
function curatedChanges(
  eventType: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): EventAmendmentV1["changes"] {
  const rowsBefore = curatedRows(eventType, before);
  const rowsAfter = curatedRows(eventType, after);
  const labels = [...new Set([...rowsBefore.keys(), ...rowsAfter.keys()])];
  const changes: EventAmendmentV1["changes"] = [];
  for (const label of labels) {
    const from = rowsBefore.get(label) ?? null;
    const to = rowsAfter.get(label) ?? null;
    if (from !== to) changes.push({ label, from, to });
  }
  return changes;
}

/**
 * The correction history, oldest first, each step diffed against the state that
 * preceded it.
 *
 * The walk re-applies the steps cumulatively rather than diffing every step
 * against the ORIGINAL, because "what did this correction change" is a question
 * about the record as it stood when somebody corrected it. Diffing against the
 * original would report the second correction as having also made the first.
 */
export function buildAmendmentHistory(read: PetEventDetailRead): EventAmendmentV1[] {
  let before = read.originalPayload;
  const items: EventAmendmentV1[] = [];
  for (const step of read.amendments) {
    const after = { ...before };
    for (const change of step.changes) after[change.field] = change.new;
    items.push({
      amendmentId: step.amendmentId,
      occurredAt: step.occurredAt.toISOString(),
      reason: step.reason,
      actorRoleLabel: authorRoleLabel(step.actorRole),
      changes: curatedChanges(read.eventType, before, after),
    });
    before = after;
  }
  return items;
}

/**
 * Sign every attachment, in one pass, and stamp each with its real expiry.
 *
 * `kind` is decided from the MIME type HERE because the branch is a product
 * decision: an image renders inline and everything else opens in the browser,
 * because this client has no PDF viewer and a tap that does nothing is worse
 * than an honest handoff.
 */
export async function buildAttachments(
  rows: PetEventDetailRead["attachments"],
  sign: AttachmentSigner,
  now: Date,
): Promise<EventAttachmentV1[]> {
  const expiresAt = new Date(
    now.getTime() + EVENT_ATTACHMENT_LINK_TTL_SECONDS * 1_000,
  ).toISOString();
  return Promise.all(
    rows.map(async (row) => {
      const url = await sign(row.storagePath, EVENT_ATTACHMENT_LINK_TTL_SECONDS);
      return {
        attachmentId: row.id,
        kind: row.mimeType.startsWith("image/") ? ("image" as const) : ("file" as const),
        mimeType: row.mimeType,
        url,
        // Null exactly when the URL is null: an expiry for a link that does not
        // exist is a countdown on nothing.
        expiresAt: url ? expiresAt : null,
      };
    }),
  );
}

export type BuildPetEventDetailInput = {
  publicToken: string;
  petStatus: string;
  accessPath: "owner" | "org";
  /** The reader — see `resolveAmendAffordance`. */
  viewer: { userId: string; titularTenures: ReadonlyArray<TitularTenure> };
  read: PetEventDetailRead;
  /** Already signed — see `buildAttachments`. */
  attachments: EventAttachmentV1[] | null;
  now: Date;
};

export function buildPetEventDetailV1(input: BuildPetEventDetailInput): PetEventDetailV1 {
  const { read, now } = input;
  const summary = eventPayloadSummary(read.eventType, read.payload);
  const typeLabel = eventTypeLabel(read.eventType as EventType);

  // The CORRECTED record. `eventPayloadDetails` is the same whitelist the web's
  // detail page renders — it never emits `firma_hash`, `evidence_hash`, a `*_id`
  // or `matched_chip_number`, and an unknown type yields no rows at all.
  const facts: EventFactV1[] = eventPayloadDetails(read.eventType, read.payload).map((row) => ({
    field: row.field,
    label: row.label,
    value: row.value,
  }));

  const lat = Number(read.locationLat);
  const lng = Number(read.locationLng);
  const location =
    read.locationLat !== null &&
    read.locationLng !== null &&
    Number.isFinite(lat) &&
    Number.isFinite(lng)
      ? { lat, lng }
      : null;

  return {
    ...apiV1Envelope({
      payloadVersion: PET_EVENT_DETAIL_PAYLOAD_VERSION,
      issuedAt: now,
      staleAfterMs: PET_EVENT_DETAIL_STALE_AFTER_MS,
    }),
    publicToken: input.publicToken,
    eventId: read.id,
    eventType: read.eventType,
    kind: typeLabel,
    title: summary.primary ?? typeLabel,
    subtitle: summary.secondary,
    occurredAt: read.occurredAt.toISOString(),
    recordedAt: read.recordedAt.toISOString(),
    notes: read.notes,
    location,
    author: {
      // A ROLE, never the person. `recordedByUserId` is read by the loader for
      // the libreta's "cargado por vos" stamp and does not cross here.
      roleLabel: authorRoleLabel(read.authorRole),
      verified: read.authorVerified,
      orgDisplayName: read.authorOrgName,
    },
    facts,
    amendments: { status: "ok", data: { items: buildAmendmentHistory(read) } },
    // `null` means the signer could not be reached at all — a section-level
    // failure, which is a different fact from "this record has no files".
    attachments:
      input.attachments === null
        ? { status: "unavailable" }
        : { status: "ok", data: { items: input.attachments } },
    amend: resolveAmendAffordance({
      eventType: read.eventType,
      accessPath: input.accessPath,
      petStatus: input.petStatus,
      viewer: input.viewer,
      authorship: {
        authorRole: read.authorRole,
        authorVerified: read.authorVerified,
        recordedByUserId: read.recordedByUserId,
        recordedAt: read.recordedAt,
        amendments: read.amendments,
      },
    }),
  };
}

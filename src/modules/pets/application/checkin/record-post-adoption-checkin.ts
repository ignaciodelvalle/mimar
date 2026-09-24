// Use-case: recordPostAdoptionCheckin — owner self-reports a post-adoption
// check-in (strangler migration 33/61).
//
// Inserts a post_adoption_checkin pet_event, closes the soonest open
// post_adoption_checkin reminder for this pet+user, and fans out a
// notification to the originating refugio's admins.
//
// TWO DOORS SINCE 2026-09-09. The web action (app/actions/checkin.ts) parses
// its form, uploads the attachment and canonicalises the location, then calls
// this with facts; `POST /api/v1/pets/{token}/events` builds the same input
// from JSON with no attachment and no location. Neither door holds a rule:
// who may write a check-in, what one requires, what it appends and what it
// closes are decided HERE and nowhere else.
//
// THE RULES, IN THE ORDER THEY RUN, AND WHY THAT ORDER:
//
//   1. The animal was adopted through the platform (`not_adopted`).
//   2. The latest adoption names THIS user as the adopter (`not_adopter`).
//      Latest-event-wins: a re-adoption revokes the previous adopter.
//   3. A follow-up window is open (`no_open_window`). The check-in is the
//      ANSWER to a window the refugio asked for; one nobody asked for would
//      notify every refugio admin about nothing, which is the spam the web page
//      has always refused to let through (eventos/nuevo/checkin/page.tsx).
//
// RULE 3 IS THE ONE THIS WRITE'S OWN SUCCESS INVALIDATES, and that is why the
// ledger is asked BEFORE it is enforced. A check-in that commits closes the
// soonest window; when that was the last one, the retry of that very request —
// the phone never saw the 201, and re-sends with the same key — arrives at an
// animal with no window open and would be refused FOREVER on a write that
// already happened. Worse, the refusal's copy tells the person to wait for a
// window that will never come. Same trap as the pregnancy close, same remedy:
// "did THIS key already write?" is asked first, and only then "may a new one
// be written?". Rules 1 and 2 are not invalidated by success and do not need
// it.

import {
  attachments,
  db,
  notifications,
  organizationMemberships,
  organizations,
  reminders,
} from "@/db";
import { findExistingByKey, insertEventIdempotent } from "@/lib/events/event-idempotency";
import { validateEventPayload } from "@/lib/events/event-schemas";
import {
  findLatestAdoption,
  findOpenPostAdoptionCheckinReminder,
} from "@/lib/infra/adoption-checkin";
import { and, eq, isNull } from "drizzle-orm";

import type { RecordPostAdoptionCheckinInput, RecordPostAdoptionCheckinResult } from "./types";

export async function recordPostAdoptionCheckin(
  input: RecordPostAdoptionCheckinInput,
): Promise<RecordPostAdoptionCheckinResult> {
  const { pet, user, notes, clientIdempotencyKey } = input;

  // Rules 1 and 2. The related organization is denormalized from the adoption
  // payload so the check-in event can stand on its own without re-joining
  // ownerships history.
  const adoption = await findLatestAdoption(pet.id);
  if (!adoption) {
    return {
      ok: false,
      error: "No se encontró adopción registrada para esta mascota.",
      notAllowed: "not_adopted",
    };
  }
  if (adoption.adopterUserId !== user.id) {
    return {
      ok: false,
      error: "No sos el adoptante registrado para esta mascota.",
      notAllowed: "not_adopter",
    };
  }
  const orgId = adoption.organizationId;
  if (!orgId) {
    // NO `notAllowed`: this is a malformed spine row, not a fact about the
    // animal or the caller. The endpoint reports it as its own failure.
    return { ok: false, error: "Adopción sin organización asociada." };
  }

  // Rule 3, with the replay check in front of it — see the header.
  const openWindow = await findOpenPostAdoptionCheckinReminder(pet.id, user.id);
  if (!openWindow) {
    if (clientIdempotencyKey) {
      const replayed = await findExistingByKey(
        pet.id,
        "post_adoption_checkin",
        clientIdempotencyKey,
      );
      if (replayed) return { ok: true, eventId: replayed.id, wasDuplicate: true };
    }
    return {
      ok: false,
      error: `${pet.name} no tiene un check-in post-adopción pendiente en este momento. Si el refugio te pide otro seguimiento más adelante, te vamos a avisar.`,
      notAllowed: "no_open_window",
    };
  }

  let eventId = "";
  let wasDuplicate = false;
  try {
    await db.transaction(async (tx) => {
      const payload = validateEventPayload("post_adoption_checkin", {
        related_organization_id: orgId,
        photo_attachment_ids: [],
        notes,
        jurisdiction_province: input.eventJurisdictionProvince,
        jurisdiction_locality: input.eventJurisdictionLocality,
      });
      const now = input.now ?? new Date();
      const { event, wasNoop: checkinNoop } = await insertEventIdempotent(
        {
          petId: pet.id,
          eventType: "post_adoption_checkin",
          occurredAt: now,
          recordedAt: now,
          recordedByUserId: user.id,
          // ALWAYS THE OWNER. Rule 2 already established that the caller is
          // the adopter — a person, never an organization — so there is no
          // authorship to resolve.
          authorRole: "owner",
          payload,
          // The answer lives in the payload for the typed schema, AND in the
          // notes column for every generic surface that renders event.notes
          // (timeline, detail). Payload-only meant the adopter's text appeared
          // NOWHERE in the UI (9-role external run, 2026-08-18).
          notes,
          clientIdempotencyKey,
        },
        tx as Parameters<typeof insertEventIdempotent>[1],
      );
      eventId = event.id;
      wasDuplicate = checkinNoop;
      if (checkinNoop) return;

      if (input.uploadedPath) {
        await tx.insert(attachments).values({
          petId: pet.id,
          eventId: event.id,
          uploadedByUserId: user.id,
          storagePath: input.uploadedPath,
          mimeType: input.uploadedMimeType ?? "image/jpeg",
          fileSize: input.uploadedSize ?? 0,
        });
      }

      // Close the soonest open post_adoption_checkin reminder for this
      // pet+user — RE-READ INSIDE THE TRANSACTION, so the row closed is the
      // row that exists now and not the one the guard saw a moment ago. Later
      // windows stay open — the adopter self-reports again at each milestone.
      const next = await findOpenPostAdoptionCheckinReminder(
        pet.id,
        user.id,
        tx as Parameters<typeof findOpenPostAdoptionCheckinReminder>[2],
      );
      if (next) {
        await tx.update(reminders).set({ completedAt: now }).where(eq(reminders.id, next.id));
      }

      // Fan out to refugio admins. Matches the capability_request precedent
      // (admins only, not coordinators) — extend the role list here if the
      // refugio team wants broader visibility later.
      const [orgRow] = await tx
        .select({ publicToken: organizations.publicToken })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);

      const admins = await tx
        .select({ userId: organizationMemberships.userId })
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.organizationId, orgId),
            eq(organizationMemberships.role, "admin"),
            isNull(organizationMemberships.leftAt),
          ),
        );

      if (admins.length > 0) {
        await tx.insert(notifications).values(
          admins.map((a) => ({
            userId: a.userId,
            notificationType: "post_adoption_checkin_received",
            title: `Check-in de ${pet.name}`,
            body: `El adoptante de ${pet.name} registró un seguimiento post-adopción.`,
            severity: "info" as const,
            ctaLabel: "Ver mascota",
            ctaUrl: orgRow ? `/org/${orgRow.publicToken}/mascotas` : "/org",
            relatedPetId: pet.id,
            relatedEventId: event.id,
          })),
        );
      }
    });
  } catch (err) {
    return {
      ok: false,
      error: `No se pudo registrar el check-in: ${
        err instanceof Error ? err.message : "error desconocido"
      }`,
    };
  }

  return { ok: true, eventId, wasDuplicate };
}

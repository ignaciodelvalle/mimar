// Use-case: revokeTagForUser — physical-tag lifecycle.
//
// Pure writer, mirrors activate-tag.ts. Revocation is allowed ONLY from
// `active` (design D4): a blank (unactivated) tag has no pet_id, so there is
// no pet to hang the tag_revoked spine event on. `revoked` is terminal.
//
// The row keeps pet_id + activated_at after revocation — the linking history
// is the audit trail; revocation never detaches the pet.

import { and, eq, isNull, sql } from "drizzle-orm";

import { auditLog, db, ownerships, petEvents, petTags, pets } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import {
  type CreateNotificationInput,
  createNotificationsBulk,
} from "@/lib/infra/notification-service";
import { normalizeTagSerial } from "@/lib/infra/tag-lookup";

import { UNKNOWN_ERROR_FALLBACK } from "@/lib/ui/error-fallback";

import { TagWriterRefusal, revokeTagSchema } from "./types";
import type { RevokeTagInput, RevokeTagResult } from "./types";

export async function revokeTagForUser(
  userId: string,
  rawInput: RevokeTagInput,
): Promise<RevokeTagResult> {
  let parsed: RevokeTagInput;
  try {
    parsed = revokeTagSchema.parse(rawInput);
  } catch (err) {
    return {
      error: `Invalid input: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const serial = normalizeTagSerial(parsed.serial);

  const pendingNotifications: CreateNotificationInput[] = [];
  let result: { ok: true; eventId: string };

  try {
    result = await db.transaction(async (tx) => {
      const [tag] = await tx
        .select()
        .from(petTags)
        .where(eq(petTags.serial, serial))
        .limit(1)
        .for("update");

      if (!tag) throw new TagWriterRefusal("Tag not found.");
      // D4: only an ACTIVE tag can be revoked. A blank tag has no pet for the
      // spine event; a revoked tag is terminal.
      if (tag.status !== "active" || !tag.petId) {
        throw new TagWriterRefusal("Only an active tag can be revoked.");
      }

      // Authorization: the caller must hold an active ownership on the LINKED
      // pet (not on a pet of their choosing).
      const [ownership] = await tx
        .select({ id: ownerships.id })
        .from(ownerships)
        .where(
          and(
            eq(ownerships.petId, tag.petId),
            eq(ownerships.ownerUserId, userId),
            isNull(ownerships.endedAt),
          ),
        )
        .limit(1);
      if (!ownership) throw new TagWriterRefusal("No active ownership for this user on this pet.");

      const [pet] = await tx.select().from(pets).where(eq(pets.id, tag.petId)).limit(1);
      if (!pet) throw new TagWriterRefusal("Pet not found.");

      // Idempotency guard (same shape as activate-tag.ts).
      const idemKey = parsed.clientIdempotencyKey ?? null;
      if (idemKey) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${idemKey}))`);
        const [existingEvent] = await tx
          .select({ id: petEvents.id })
          .from(petEvents)
          .where(
            and(
              eq(petEvents.petId, pet.id),
              eq(petEvents.eventType, "tag_revoked"),
              eq(petEvents.clientIdempotencyKey, idemKey),
            ),
          )
          .limit(1);
        if (existingEvent) {
          return { ok: true, eventId: existingEvent.id };
        }
      }

      // Payload key is revoke_reason, NOT reason (design D5 — erase RPC
      // sentinel-redacts `reason` across all event types).
      const eventPayload = validateEventPayload("tag_revoked", {
        serial,
        revoke_reason: parsed.revokeReason,
        replacement_serial: parsed.replacementSerial ?? null,
      });

      const now = new Date();

      const [event] = await tx
        .insert(petEvents)
        .values({
          petId: pet.id,
          eventType: "tag_revoked",
          occurredAt: now,
          recordedAt: now,
          recordedByUserId: userId,
          authorRole: "owner",
          authorVerified: false,
          payload: eventPayload,
          clientIdempotencyKey: idemKey,
        })
        .returning();

      // Declared cache flip — pet_id is KEPT for audit (state-machine CHECK
      // requires it on 'revoked').
      await tx
        .update(petTags)
        .set({
          status: "revoked",
          revokedByUserId: userId,
          revokedAt: now,
          revokedReason: parsed.revokeReason,
          updatedAt: now,
        })
        .where(eq(petTags.id, tag.id));

      await tx.update(pets).set({ updatedAt: now }).where(eq(pets.id, pet.id));

      await tx.insert(auditLog).values({
        actorUserId: userId,
        action: "tag.revoke",
        payload: {
          event_id: event.id,
          target_pet_id: pet.id,
          serial,
          revoke_reason: parsed.revokeReason,
        },
      });

      const ownerRows = await tx
        .select({ ownerUserId: ownerships.ownerUserId })
        .from(ownerships)
        .where(
          and(
            eq(ownerships.petId, pet.id),
            eq(ownerships.role, "owner"),
            isNull(ownerships.endedAt),
          ),
        );
      for (const row of ownerRows) {
        if (!row.ownerUserId) continue;
        pendingNotifications.push({
          userId: row.ownerUserId,
          notificationType: "tag_revoked",
          severity: "info",
          title: `Chapa dada de baja — ${pet.name}`,
          body: `La chapa ${serial} fue dada de baja. Su QR ya no muestra la credencial de ${pet.name}.`,
          relatedPetId: pet.id,
          relatedEventId: event.id,
          ctaLabel: "Ver mis chapas",
          ctaUrl: "/cuenta/chapas",
          dedupeKey: `event:${event.id}:${row.ownerUserId}:tag_revoked`,
        });
      }

      return { ok: true, eventId: event.id };
    });
  } catch (err) {
    // Deliberate refusals keep their message (mirrors activate-tag.ts); any
    // other failure is internal detail that must not reach the browser — it is
    // rendered verbatim in RevokeTagDialog's error banner. See TagWriterRefusal.
    if (err instanceof TagWriterRefusal) {
      return { error: err.message };
    }
    console.error("[revokeTagForUser] unexpected failure", err);
    return { error: UNKNOWN_ERROR_FALLBACK };
  }

  // Outside the business tx on purpose (ARCH-P): createNotificationsBulk
  // dead-letters its own failures and never throws, so a notification problem
  // can never roll back a revocation that already committed.
  if (pendingNotifications.length > 0) {
    await createNotificationsBulk(pendingNotifications);
  }

  return result;
}

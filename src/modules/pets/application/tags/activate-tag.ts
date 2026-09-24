// Use-case: activateTagForUser — physical-tag lifecycle.
//
// Pure writer: receives userId + validated input, runs the DB transaction,
// and returns the result. No Next.js request context.
//
// The outer shim (app/actions/tags.ts) gates via the Supabase session and
// applies the per-IP / per-serial rate limits. Tests call activateTagForUser
// directly with a known userId.
//
// SECURITY SHAPE (design D2/D3):
//   - The activation code is hashed and compared inside a SQL predicate
//     (tagActivationCodeMatches) — never SELECTed, never echoed.
//   - Wrong code, unknown serial and non-activatable state ALL return the
//     same ACTIVATION_FAILED_MESSAGE (uniform failure, no oracle).
//   - The tag_activated event payload never carries the code (strict schema).

import { and, eq, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { auditLog, db, ownerships, petEvents, petTags, pets } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import {
  type CreateNotificationInput,
  createNotificationsBulk,
} from "@/lib/infra/notification-service";
import { normalizeTagSerial, tagActivationCodeMatches } from "@/lib/infra/tag-lookup";

import { UNKNOWN_ERROR_FALLBACK } from "@/lib/ui/error-fallback";

import { ACTIVATION_FAILED_MESSAGE, TagWriterRefusal, activateTagSchema } from "./types";
import type { ActivateTagInput, ActivateTagResult } from "./types";

export async function activateTagForUser(
  userId: string,
  rawInput: ActivateTagInput,
): Promise<ActivateTagResult> {
  let parsed: ActivateTagInput;
  try {
    parsed = activateTagSchema.parse(rawInput);
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
      // Lock the tag row: concurrent activations of the same serial serialize
      // here, so the status gate below is race-free.
      const [tag] = await tx
        .select()
        .from(petTags)
        .where(eq(petTags.serial, serial))
        .limit(1)
        .for("update");

      // Active-ownership gate on the chosen pet (same shape as
      // replace-microchip's owner branch: any active ownership row). Runs
      // BEFORE the evidence gates: it reveals nothing about the TAG, and the
      // idempotency short-circuit below must not answer an unauthorized caller.
      const [pet] = await tx.select().from(pets).where(eq(pets.id, parsed.petId)).limit(1);
      if (!pet || pet.deletedAt !== null) throw new TagWriterRefusal("Pet not found.");

      const [ownership] = await tx
        .select({ id: ownerships.id })
        .from(ownerships)
        .where(
          and(
            eq(ownerships.petId, pet.id),
            eq(ownerships.ownerUserId, userId),
            isNull(ownerships.endedAt),
          ),
        )
        .limit(1);
      if (!ownership) throw new TagWriterRefusal("No active ownership for this user on this pet.");

      // Idempotency guard: a double-submit must not emit a second
      // tag_activated event. The advisory lock serializes concurrent same-key
      // submits; the lookup then returns the original event for the retry.
      // MUST run before the state gate: after the first submit succeeds the
      // tag is `active`, and the retry has to find the original event instead
      // of bouncing off the uniform failure.
      const idemKey = parsed.clientIdempotencyKey ?? null;
      if (idemKey) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${idemKey}))`);
        const [existingEvent] = await tx
          .select({ id: petEvents.id })
          .from(petEvents)
          .where(
            and(
              eq(petEvents.petId, pet.id),
              eq(petEvents.eventType, "tag_activated"),
              eq(petEvents.clientIdempotencyKey, idemKey),
            ),
          )
          .limit(1);
        if (existingEvent) {
          return { ok: true, eventId: existingEvent.id };
        }
      }

      // UNIFORM failure: unknown serial, wrong state and wrong code are
      // indistinguishable to the caller (no enumeration/state oracle).
      if (!tag) throw new UniformActivationFailure();
      if (tag.status !== "unactivated") throw new UniformActivationFailure();

      const codeOk = await tagActivationCodeMatches(tag.id, parsed.activationCode, tx);
      if (!codeOk) throw new UniformActivationFailure();

      // Spine event. Payload never carries the code (strict schema throws on
      // any extra key).
      const eventPayload = validateEventPayload("tag_activated", {
        serial,
        lote_id: tag.loteId,
        source: "self",
      });

      const now = new Date();

      const [event] = await tx
        .insert(petEvents)
        .values({
          petId: pet.id,
          eventType: "tag_activated",
          occurredAt: now,
          recordedAt: now,
          recordedByUserId: userId,
          authorRole: "owner",
          authorVerified: false,
          payload: eventPayload,
          clientIdempotencyKey: idemKey,
        })
        .returning();

      // Declared cache flip (invariant #3): pet_tags is the operational cache
      // of the tag's lifecycle; the spine row above is the fact.
      await tx
        .update(petTags)
        .set({
          status: "active",
          petId: pet.id,
          activatedByUserId: userId,
          activatedAt: now,
          updatedAt: now,
        })
        .where(eq(petTags.id, tag.id));

      await tx.update(pets).set({ updatedAt: now }).where(eq(pets.id, pet.id));

      await tx.insert(auditLog).values({
        actorUserId: userId,
        action: "tag.activate",
        payload: {
          event_id: event.id,
          target_pet_id: pet.id,
          serial,
        },
      });

      // Notify all active owners (co-owners included by role='owner' rows).
      // Collected in-tx, inserted OUTSIDE the tx (notification failure must
      // not roll back the activation — replace-microchip D8 pattern).
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
          notificationType: "tag_activated",
          severity: "info",
          title: `Chapa activada — ${pet.name}`,
          body: `La chapa ${serial} quedó vinculada a ${pet.name}. Quien escanee su QR va a ver la credencial pública.`,
          relatedPetId: pet.id,
          relatedEventId: event.id,
          ctaLabel: "Ver mis chapas",
          ctaUrl: "/cuenta/chapas",
          dedupeKey: `event:${event.id}:${row.ownerUserId}:tag_activated`,
        });
      }

      return { ok: true, eventId: event.id };
    });
  } catch (err) {
    if (err instanceof UniformActivationFailure) {
      return { error: ACTIVATION_FAILED_MESSAGE };
    }
    // Deliberate refusals keep their message — the caller can act on them.
    if (err instanceof TagWriterRefusal) {
      return { error: err.message };
    }
    // Everything else is UNEXPECTED — a driver fault, a constraint violation, a
    // bug. Its message can quote the failing statement or name a column, and
    // this string is rendered straight into ActivateTagForm's error banner, so
    // it never leaves the server. Logged here so the detail is not lost.
    console.error("[activateTagForUser] unexpected failure", err);
    return { error: UNKNOWN_ERROR_FALLBACK };
  }

  // Outside the business tx on purpose (ARCH-P): createNotificationsBulk
  // dead-letters its own failures and never throws, so a notification problem
  // can never roll back an activation that already committed.
  if (pendingNotifications.length > 0) {
    await createNotificationsBulk(pendingNotifications);
  }

  return result;
}

// Marker error for the uniform activation failure — carries NO detail about
// which gate failed, by design.
class UniformActivationFailure extends Error {
  constructor() {
    super("activation_failed");
    this.name = "UniformActivationFailure";
  }
}

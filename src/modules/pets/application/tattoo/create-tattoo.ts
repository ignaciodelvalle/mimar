// Use-case: createTattooForUser — strangler migration 34/61.
//
// Pure writer: receives petId + userId + eventAuthorship + input, runs the DB
// transaction, and returns the result. No Next.js request context.
//
// The outer shim (app/actions/tattoo.ts) gates via requireAlivePetAccess.
// Tests call createTattooForUser directly with a known userId.

import { and, eq } from "drizzle-orm";

import { attachments, db, petIdentifications } from "@/db";
import { insertEventIdempotent } from "@/lib/events/event-idempotency";
import { validateEventPayload } from "@/lib/events/event-schemas";
import type { PetEventAuthorship } from "@/lib/infra/pet-access";
import { normalizeTattooCode } from "@/lib/infra/tattoo-lookup";
import { TATTOO_LOCATIONS } from "@dim/contract/input";

import type { CreateTattooResult, TattooInput, TattooLocation } from "./types";

/**
 * The five places, from the contract that now names them once.
 *
 * KEPT AS AN EXPORT UNDER THIS NAME because `app/actions/tattoo.ts` and the web
 * form both read it, and re-pointing the alias is a smaller change than moving
 * two call sites onto a new one. The values are identical — this is where the
 * list stopped being a second copy, not where it changed.
 */
export const VALID_LOCATIONS: readonly TattooLocation[] = TATTOO_LOCATIONS;

// Inner writer — testable without Next.js request context. The outer action
// resolves access + uploads the photo + delegates here. Photo upload happens
// outside the transaction so a failed insert doesn't leak orphan bytes; the
// outer action cleans up on failure.
export async function createTattooForUser(
  petId: string,
  userId: string,
  eventAuthorship: PetEventAuthorship,
  input: TattooInput,
): Promise<CreateTattooResult> {
  const normalizedCode = normalizeTattooCode(input.code);
  if (!normalizedCode) return { error: "Falta el código del tatuaje." };

  if (input.location !== null && !VALID_LOCATIONS.includes(input.location)) {
    return { error: "Ubicación del tatuaje inválida." };
  }

  const now = new Date();
  const recordedAtIso = input.recordedAt ? input.recordedAt.toISOString().slice(0, 10) : null;

  try {
    const result = await db.transaction(async (tx) => {
      const eventPayload = validateEventPayload("tattoo_recorded", {
        tattoo_code: normalizedCode,
        location_on_body: input.location,
        description: input.description,
        recorded_by: input.recordedBy,
        recorded_at: recordedAtIso,
        tattoo_date_known: input.recordedAt !== null,
      });

      // Idempotency guard (projection-writes audit §6): a double-submit of the
      // tattoo form must not emit a second tattoo_recorded event + a second
      // pet_identifications row. insertEventIdempotent dedupes on the partial
      // unique index (pet_id, event_type, client_idempotency_key).
      const { event, wasNoop } = await insertEventIdempotent(
        {
          petId,
          eventType: "tattoo_recorded",
          occurredAt: input.recordedAt ?? now,
          recordedAt: now,
          recordedByUserId: userId,
          ...eventAuthorship,
          payload: eventPayload,
          clientIdempotencyKey: input.clientIdempotencyKey ?? null,
        },
        tx as Parameters<typeof insertEventIdempotent>[1],
      );

      // Duplicate submit — the original event (and its attachment + canonical
      // ident row) already exist. Skip ALL side-effects.
      if (wasNoop) return { ok: true as const, eventId: event.id, wasNoop: true };

      const [attachment] = await tx
        .insert(attachments)
        .values({
          petId,
          eventId: event.id,
          uploadedByUserId: userId,
          storagePath: input.uploadedAttachment.path,
          mimeType: input.uploadedAttachment.mimeType,
          fileSize: input.uploadedAttachment.size,
        })
        .returning();

      // Supersede any active tattoo BEFORE inserting the new one.
      //
      // El modelo es UN tatuaje activo por mascota. La ausencia de índice único
      // parcial para tatuaje (a diferencia de pet_identifications_chip_unique)
      // no es para permitir varios: es porque distintos registros reusan códigos
      // entre mascotas distintas (0056:90-91, 0045:24-26). La vista de compat
      // lee con LIMIT 1 y la proyección es latest-wins.
      //
      // Como no hay flujo de "editar tatuaje", corregir un código mal cargado
      // obliga a re-registrar. Sin este supersede quedaban DOS filas con
      // status='active', y como el read (pet-identifiers.ts) y el harness de
      // deriva no ordenan, cuál ganaba dependía del orden físico de Postgres: la
      // credencial podía mostrar de forma no-determinística el dato viejo o el
      // corregido. O sea, la corrección "no tomaba" a veces.
      //
      // replace-microchip.ts:291 ya hacía exactamente esto para el chip; el
      // tatuaje quedó sin el hermano.
      await tx
        .update(petIdentifications)
        .set({ status: "replaced", updatedAt: now })
        .where(
          and(
            eq(petIdentifications.petId, petId),
            eq(petIdentifications.kind, "tattoo"),
            eq(petIdentifications.status, "active"),
          ),
        );

      // Canonical write to pet_identifications (legacy pets.* tattoo columns
      // removed — ARCH-R. Migration 0084 drops the columns next PR).
      await tx.insert(petIdentifications).values({
        petId,
        kind: "tattoo",
        code: normalizedCode,
        recordedAt: recordedAtIso ?? now.toISOString().slice(0, 10),
        recordedByUserId: userId,
        recordedByLabel: input.recordedBy,
        photoId: attachment.id,
        tattooLocation: input.location,
        tattooDescription: input.description,
      });

      return { ok: true as const, eventId: event.id };
    });

    return result;
  } catch (err) {
    return {
      error: `No se pudo registrar el tatuaje: ${
        err instanceof Error ? err.message : "error desconocido"
      }`,
    };
  }
}

// Use-case: createMicrochip
//
// Migrated from app/actions/events.ts::createMicrochipAction (inner tx block).
// Auth (requireAlivePetAccess) handled by caller (actions.ts).
//
// Parity:
//   - Uses insertEventIdempotent; wasNoop=true → skip ALL side-effects.
//   - Attachment inserted when uploadedPath provided.
//   - ARCH-R: legacy updateMicrochipBackfill (pets.microchipId column) removed.
//     Canonical row written to pet_identifications via insertIdentification.
//   - ARCH-S: pet.microchipId replaced by a pre-resolved canonical chip value
//     (from pet_identifications) so no legacy column is needed.
//   - No outbox. No audit_log.
//
// The caller passes the canonical chip NUMBER, not a boolean. A boolean could
// only answer "does this pet have a chip?", which collapses a re-submit of the
// same chip and an implant of a different one into one branch — and that branch
// wrote the event while skipping the canonical row. See
// checkChipMatchesCanonical for what that cost.

import { chipImplantSiteFromLocation } from "@/lib/domain/microchip-implant-site";
import { checkChipMatchesCanonical } from "@/lib/domain/microchip-validation";
import { validateEventPayload } from "@/lib/events/event-schemas";

import type { EventsRepository } from "../../infrastructure/events-repository";
import type { RecordedEvent, UseCaseResult } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CreateMicrochipInput = {
  /**
   * `canonicalChipNumber` is the pet's active pet_identifications code, or null
   * when the pet carries no chip yet. Resolved by the caller.
   */
  pet: { id: string; canonicalChipNumber: string | null };
  user: { id: string };
  eventAuthorship: {
    authorRole: string;
    authorOrganizationId: string | null;
    authorVerified: boolean;
  };
  chipNumber: string;
  countryCode: string | null;
  implantedBy: string | null;
  locationOnBody: string | null;
  occurredAt: Date;
  notes: string | null;
  uploadedPath: string | null;
  uploadedMimeType: string | null;
  uploadedSize: number | null;
  clientIdempotencyKey: string | null;
};

type Deps = {
  repo: Pick<
    EventsRepository,
    "insertEventIdempotent" | "insertAttachment" | "insertIdentification"
  >;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function createMicrochip(
  input: CreateMicrochipInput,
  deps: Deps,
): Promise<UseCaseResult<RecordedEvent>> {
  const {
    pet,
    user,
    eventAuthorship,
    chipNumber,
    countryCode,
    implantedBy,
    locationOnBody,
    occurredAt,
    notes,
    uploadedPath,
    uploadedMimeType,
    uploadedSize,
    clientIdempotencyKey,
  } = input;
  const { repo, transaction } = deps;

  // Runs BEFORE the transaction opens: an implant that contradicts the chip on
  // record must never reach the append-only spine, because nothing downstream
  // can retract it. See checkChipMatchesCanonical for why rejection beats both
  // overwriting the canonical row and flagging the conflict after the fact.
  const conflict = checkChipMatchesCanonical(pet.canonicalChipNumber, chipNumber);
  if (conflict) return { ok: false, error: conflict.error };

  const now = new Date();

  const committed = await transaction(async (tx) => {
    const eventPayload = validateEventPayload("microchip_implanted", {
      chip_number: chipNumber,
      country_code: countryCode,
      implanted_by: implantedBy,
      location_on_body: locationOnBody,
      // La proyección deriva `microchipImplantedAt` como
      // `implant_date_known ? formatDate(occurredAt) : null`
      // (pet-microchip.ts:60), y este campo es .optional() en el schema, así que
      // omitirlo NO significa "true por defecto": significa null derivado.
      // Mientras tanto la fila canónica de abajo escribe `recordedAt` no-nulo,
      // con lo cual cada alta de chip por este camino generaba deriva entre el
      // caché y la proyección — ruido permanente en el detector, que es como se
      // termina ignorando un detector.
      //
      // Acá la fecha SÍ se conoce: la acción la exige antes de llegar hasta acá
      // ("Falta la fecha de implantación", actions.ts:121), así que lo correcto
      // es afirmarlo, no omitirlo.
      implant_date_known: true,
    });

    const { event, wasNoop } = await repo.insertEventIdempotent(
      {
        petId: pet.id,
        eventType: "microchip_implanted",
        occurredAt,
        recordedAt: now,
        recordedByUserId: user.id,
        ...eventAuthorship,
        payload: eventPayload,
        notes,
        clientIdempotencyKey,
      } as Parameters<typeof repo.insertEventIdempotent>[0],
      tx as Parameters<typeof repo.insertEventIdempotent>[1],
    );

    if (wasNoop) return { eventId: event.id, wasDuplicate: true };

    if (uploadedPath) {
      await repo.insertAttachment(
        {
          petId: pet.id,
          eventId: event.id,
          uploadedByUserId: user.id,
          storagePath: uploadedPath,
          mimeType: uploadedMimeType ?? "image/jpeg",
          fileSize: uploadedSize ?? 0,
        },
        tx as Parameters<typeof repo.insertAttachment>[1],
      );
    }

    // Insert canonical microchip row in pet_identifications.
    // Only when the pet had no prior chip. A pet that already carries THIS
    // chip needs nothing written — the guard above proved the codes agree, so
    // this is a double-submit or a partial-write re-sync, and
    // insertIdentification would skip it anyway.
    // ARCH-R: legacy pets.microchipId write removed.
    if (pet.canonicalChipNumber === null) {
      const implantSite = chipImplantSiteFromLocation(locationOnBody);
      await repo.insertIdentification(
        {
          petId: pet.id,
          kind: "microchip_iso",
          code: chipNumber,
          recordedAt: occurredAt.toISOString().slice(0, 10),
          recordedByUserId: user.id,
          recordedByLabel: implantedBy,
          isoCountryCode: chipNumber.slice(0, 3),
          isoManufacturerCode: chipNumber.slice(3, 7),
          isoNationalId: chipNumber.slice(7, 15),
          isoCompliant: true,
          implantationSite: implantSite ?? undefined,
        },
        tx as Parameters<typeof repo.insertIdentification>[1],
      );
    }

    return { eventId: event.id, wasDuplicate: false };
  });

  return { ok: true, value: committed, notifications: [] };
}

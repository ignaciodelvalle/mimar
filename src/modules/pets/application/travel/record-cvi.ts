// Use-case: recordCvi (viajes-fase-2, design D4) — the SENASA Certificado
// Veterinario Internacional the owner copied off the paper.
//
// Appends ONE `movement_recorded` / `cvi_issued` through `recordMovementWriter`
// — never a `pets.*` write. Shared by `recordCviAction` (web) and
// `POST /api/v1/pets/{publicToken}/travel` `record_cvi`. `cvi_duplicate` is the
// same certificate number already on record, checked after the replay check
// and under the per-pet lock, like `trip_duplicate`.

import { recordMovementWriter } from "../movement/record-movement";
import {
  cviInputRefusal,
  loadOverlaidMovements,
  normalizeCviNumber,
  travelAuthzRefusal,
} from "./travel-edge";
import type { RecordCviInput, TravelActor, TravelPet, TravelWriteResult } from "./types";

/** SENASA issues the CVI for an animal leaving Argentina. */
const CVI_ORIGIN_COUNTRY = "AR";
const CVI_ISSUING_AUTHORITY = "SENASA";

export const CVI_DUPLICATE_ERROR = "Ese número de CVI ya está registrado para esta mascota.";

export async function recordCvi(params: {
  pet: TravelPet;
  actor: TravelActor;
  input: RecordCviInput;
  clientIdempotencyKey: string | null;
  now?: Date;
}): Promise<TravelWriteResult> {
  const now = params.now ?? new Date();
  const { pet, actor, input } = params;

  const refused = travelAuthzRefusal(pet, actor) ?? cviInputRefusal(input, now);
  if (refused) return { ok: false, ...refused };

  const cviNumber = input.cviNumber.trim();
  const wanted = normalizeCviNumber(cviNumber);

  const result = await recordMovementWriter({
    pet: { id: pet.id, publicToken: pet.publicToken },
    recordedByUserId: actor.userId,
    eventAuthorship: actor.eventAuthorship,
    occurredAt: now,
    now,
    notes: null,
    movement: {
      sub_kind: "cvi_issued",
      origin_country: CVI_ORIGIN_COUNTRY,
      cvi_number: cviNumber,
      issuing_authority: CVI_ISSUING_AUTHORITY,
      issued_date: input.issuedDate,
      chip_iso_country_code: null,
      ...(input.validUntil !== null ? { valid_until: input.validUntil } : {}),
    },
    clientIdempotencyKey: params.clientIdempotencyKey,
    refuseIf: async (tx) => {
      const movements = await loadOverlaidMovements(pet.id, tx);
      const twin = movements.some((e) => {
        const p = (e.payload ?? {}) as Record<string, unknown>;
        return (
          p.sub_kind === "cvi_issued" &&
          typeof p.cvi_number === "string" &&
          normalizeCviNumber(p.cvi_number) === wanted
        );
      });
      return twin ? "cvi_duplicate" : null;
    },
  });

  if (!result.ok) {
    if (result.refusal === "cvi_duplicate") {
      return { ok: false, code: "cvi_duplicate", error: CVI_DUPLICATE_ERROR };
    }
    console.error("[travel] recordCvi failed:", result.error);
    return {
      ok: false,
      code: "write_failed",
      error: "No pudimos registrar el CVI. Intentá de nuevo.",
    };
  }
  return { ok: true, eventId: result.eventId, replayed: result.replayed };
}

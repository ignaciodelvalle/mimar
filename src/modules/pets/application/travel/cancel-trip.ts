// Use-case: cancelTrip (viajes-fase-2, design D4).
//
// A cancellation is a CORRECTION, never an edit or a delete (invariant 2): it
// goes through `amendEvent` with `{field: "cancelled", new: true}`, a classified
// key of `transport_recorded`, so the original row stays byte-identical and
// `deriveTrips` / `deriveTravelContext` skip it from then on.
//
// Idempotent on the STATE: cancelling a trip that is already cancelled answers
// `changed: false`, never a refusal — a second tap or a replay must answer the
// way the first did.

import { amendEvent } from "@/src/modules/events/application/amendment/amend-event";

import { loadOverlaidMovements, travelAuthzRefusal } from "./travel-edge";
import type { CancelTripResult, TravelActor, TravelPet } from "./types";

const TRIP_NOT_FOUND_ERROR = "No encontramos ese viaje.";

export async function cancelTrip(params: {
  pet: TravelPet;
  actor: TravelActor;
  tripEventId: string;
  clientIdempotencyKey: string | null;
}): Promise<CancelTripResult> {
  const { pet, actor, tripEventId } = params;

  const refused = travelAuthzRefusal(pet, actor);
  if (refused) return { ok: false, ...refused };

  const target = (await loadOverlaidMovements(pet.id)).find((e) => e.id === tripEventId);
  const payload = (target?.payload ?? {}) as Record<string, unknown>;
  if (!target || payload.sub_kind !== "transport_recorded") {
    return { ok: false, code: "trip_not_found", error: TRIP_NOT_FOUND_ERROR };
  }
  if (payload.cancelled === true) return { ok: true, tripEventId, changed: false };

  const result = await amendEvent(
    { id: actor.userId },
    { id: pet.id, name: pet.name, publicToken: pet.publicToken },
    actor.eventAuthorship,
    {
      publicToken: pet.publicToken,
      targetEventId: tripEventId,
      reason: null,
      changes: [{ field: "cancelled", old: null, new: true }],
      clientIdempotencyKey: params.clientIdempotencyKey,
    },
  );

  if (!result.ok) {
    switch (result.code) {
      case "target_not_found":
      case "travel_private_target":
        return { ok: false, code: "trip_not_found", error: TRIP_NOT_FOUND_ERROR };
      case "authorship_refused":
        // PO decision 3B: a record is corrected by whoever wrote it. A
        // co-owner cancelling the owner's trip lands here.
        return { ok: false, code: "forbidden", error: result.error };
      default:
        console.error("[travel] cancelTrip failed:", result.code, result.error);
        return {
          ok: false,
          code: "write_failed",
          error: "No pudimos cancelar el viaje. Intentá de nuevo.",
        };
    }
  }
  return { ok: true, tripEventId, changed: !result.wasDuplicate };
}

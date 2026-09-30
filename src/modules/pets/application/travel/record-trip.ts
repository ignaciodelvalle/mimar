// Use-case: recordTrip (viajes-fase-2, design D4).
//
// Appends ONE `movement_recorded` / `transport_recorded` through
// `recordMovementWriter` — never a `pets.*` write (R6.2: only
// jurisdiction_changed denormalizes). Shared by `recordTripAction` (web) and
// `POST /api/v1/pets/{publicToken}/travel` `record_trip`.
//
// Order: access (travel titular, alive) → plausibility → write. Inside the
// write, a replay of the same idempotency key answers the first event; only
// then does `trip_duplicate` run, under a per-pet lock.

import { deriveTrips } from "@/lib/projections/travel-compliance";

import { recordMovementWriter } from "../movement/record-movement";
import { loadOverlaidMovements, travelAuthzRefusal, tripInputRefusal } from "./travel-edge";
import type { RecordTripInput, TravelActor, TravelPet, TravelWriteResult } from "./types";

export const TRIP_DUPLICATE_ERROR =
  "Ya registraste un viaje a ese destino para esa fecha. Si cambió algo, cancelalo y registralo de nuevo.";

export async function recordTrip(params: {
  pet: TravelPet;
  actor: TravelActor;
  input: RecordTripInput;
  clientIdempotencyKey: string | null;
  now?: Date;
}): Promise<TravelWriteResult> {
  const now = params.now ?? new Date();
  const { pet, actor, input } = params;

  const refused = travelAuthzRefusal(pet, actor) ?? tripInputRefusal(input, now);
  if (refused) return { ok: false, ...refused };

  // An airline implies an air trip (design D4) — recorded as such, so the
  // corridor and airline rules read one consistent mode.
  const mode = input.airlineId !== null ? "air" : input.mode;

  const result = await recordMovementWriter({
    pet: { id: pet.id, publicToken: pet.publicToken },
    recordedByUserId: actor.userId,
    eventAuthorship: actor.eventAuthorship,
    occurredAt: now,
    now,
    notes: null,
    movement: {
      sub_kind: "transport_recorded",
      corridor_id: input.corridorId,
      direction: "outbound_from_ar",
      travel_date: input.travelDate,
      mode,
      purpose: null,
      ...(input.airlineId !== null ? { airline_id: input.airlineId } : {}),
      ...(input.intendedModality !== null ? { intended_modality: input.intendedModality } : {}),
    },
    clientIdempotencyKey: params.clientIdempotencyKey,
    refuseIf: async (tx) => {
      const trips = deriveTrips(await loadOverlaidMovements(pet.id, tx));
      const twin = trips.some(
        (t) => t.corridorId === input.corridorId && t.travelDate === input.travelDate,
      );
      return twin ? "trip_duplicate" : null;
    },
  });

  if (!result.ok) {
    if (result.refusal === "trip_duplicate") {
      return { ok: false, code: "trip_duplicate", error: TRIP_DUPLICATE_ERROR };
    }
    console.error("[travel] recordTrip failed:", result.error);
    return {
      ok: false,
      code: "write_failed",
      error: "No pudimos registrar el viaje. Intentá de nuevo.",
    };
  }
  return { ok: true, eventId: result.eventId, replayed: result.replayed };
}

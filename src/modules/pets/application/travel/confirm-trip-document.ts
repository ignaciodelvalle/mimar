// Use-case: confirmTripDocument (PO 2026-10-01, viajes-fase-2 sign-offs).
//
// The owner ticks "Lo tengo" for one paper the trip asks for (or unticks it).
// miMAR cannot see a paper, so this records what the OWNER says; the
// papers-to-carry obligation stays a warning until every document it lists is
// ticked, and then reads "Registraste que tenés cada documento" — never that a
// paper is valid.
//
// WHY A CORRECTION AND NOT A NEW EVENT TYPE. The ticks are a property of ONE
// trip, read only where the trip is read, by the same titular who recorded it.
// `transport_recorded` gains an optional `documents_confirmed` (a classified CF
// key), and every tick is an `event_amended` {field: "documents_confirmed",
// new: [...]} on the trip row — the path `cancelTrip` already takes. So the
// facts stay on the append-only spine (each tick is a new row, the trip row is
// never touched), the trip-privacy fence (D8) already covers them — it drops
// every correction whose target is a trip — and the 56-type catalogue does not
// move.
//
// THE DOCUMENT MUST BE ONE THE TRIP LISTS. The label is checked against the
// trip's own `required_documents` as loadTravelView derives it right now, so
// the payload only ever carries reference text, never something typed.
//
// Idempotent on the STATE: ticking a ticked document (or unticking an unticked
// one) answers `changed: false` without appending anything — a second tap or a
// replay answers the way the first did.
//
// KNOWN LIMIT: the read of the current ticks and the correction are two steps,
// so two DIFFERENT documents ticked in the same instant could leave only the
// later list. Both surfaces send one tick at a time and re-read after it (the
// web reloads; the phone disables every tick while one is in flight).

import { amendEvent } from "@/src/modules/events/application/amendment/amend-event";

import { type TravelViewPet, loadTravelView } from "./load-travel-view";
import { inputRefusal, travelAuthzRefusal } from "./travel-edge";
import type { ConfirmTripDocumentResult, TravelActor, TravelPet } from "./types";

const TRIP_NOT_FOUND_ERROR = "No encontramos ese viaje.";

export async function confirmTripDocument(params: {
  pet: TravelPet & TravelViewPet;
  actor: TravelActor;
  tripEventId: string;
  /** The document's label, exactly as the trip's obligation lists it. */
  document: string;
  /** true = "Lo tengo"; false = take the tick back. */
  confirmed: boolean;
  clientIdempotencyKey: string | null;
  now?: Date;
}): Promise<ConfirmTripDocumentResult> {
  const { pet, actor, tripEventId, document, confirmed } = params;

  const refused = travelAuthzRefusal(pet, actor);
  if (refused) return { ok: false, ...refused };

  const read = await loadTravelView({
    pet,
    viewer: { accessPath: actor.accessPath, holderRole: actor.holderRole },
    tripId: tripEventId,
    now: params.now,
  });
  const trip = read.ok ? read.view.selectedTrip : null;
  if (!read.ok || !trip || trip.eventId !== tripEventId) {
    return { ok: false, code: "trip_not_found", error: TRIP_NOT_FOUND_ERROR };
  }

  const listed =
    read.view.compliance?.obligations.find((o) => o.key === "required_documents")?.documents ?? [];
  const labels = listed.map((d) => d.label);
  if (!labels.includes(document)) {
    return { ok: false, ...inputRefusal("DOCUMENT_NOT_LISTED") };
  }

  const current = trip.documentsConfirmed;
  if (current.includes(document) === confirmed) return { ok: true, tripEventId, changed: false };

  // In the rule's own order, and only documents the trip still lists: a tick
  // for a paper a rule no longer asks for drops out on the next write.
  const next = labels.filter((label) => (label === document ? confirmed : current.includes(label)));

  const result = await amendEvent(
    { id: actor.userId },
    { id: pet.id, name: pet.name, publicToken: pet.publicToken },
    actor.eventAuthorship,
    {
      publicToken: pet.publicToken,
      targetEventId: tripEventId,
      reason: null,
      changes: [{ field: "documents_confirmed", old: current, new: next }],
      clientIdempotencyKey: params.clientIdempotencyKey,
    },
  );

  if (!result.ok) {
    switch (result.code) {
      case "target_not_found":
      case "travel_private_target":
        return { ok: false, code: "trip_not_found", error: TRIP_NOT_FOUND_ERROR };
      case "authorship_refused":
        // PO decision 3B, as for a cancel: a record is corrected by whoever
        // wrote it, so the ticks of a trip belong to the titular who recorded it.
        return { ok: false, code: "forbidden", error: result.error };
      default:
        console.error("[travel] confirmTripDocument failed:", result.code, result.error);
        return {
          ok: false,
          code: "write_failed",
          error: "No pudimos guardar la confirmación. Intentá de nuevo.",
        };
    }
  }
  return { ok: true, tripEventId, changed: !result.wasDuplicate };
}

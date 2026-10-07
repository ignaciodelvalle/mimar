// The `GET /api/v1/pets/{publicToken}/travel` body (viajes-fase-2, task 5.5).
//
// SAME LOADER AS THE WEB. `loadTravelView` is what /viaje renders from; this
// file only narrows its answer to the wire. The semáforo and every obligation
// are computed on the server and drawn by the native screen as they come, so
// web and phone cannot disagree about a trip (spec mobile-travel-screen).
//
// WHO MAY READ: the travel titular (`canAccessTravel` — owner, co-owner, foster
// on the person path), decided INSIDE the loader. A caller who may not see the
// animal at all gets `not_found`, like every door here; one who holds it and is
// not a travel titular gets `travel_forbidden` (403), the same split the POST
// makes.

import { TRAVEL_AIRLINE_NOTICE, TRAVEL_SEMAFORO_LABELS } from "@/lib/domain/travel-copy";
import { apiV1Envelope, apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { type PetHolderAccess, resolvePetHolderAccess } from "@/lib/infra/pet-access";
import { resolveSiteUrl } from "@/lib/infra/site-url";
import { getAirline, isAirlineId } from "@/lib/reference/airlines";
import {
  CORRIDOR_IDS,
  type CorridorId,
  TRAVEL_DISCLAIMER,
  getCorridor,
} from "@/lib/reference/cross-border-corridors";
import {
  type TravelView,
  type TravelViewPet,
  loadTravelView,
} from "@/src/modules/pets/application/travel/load-travel-view";
import { travelFormOptions } from "@/src/modules/pets/application/travel/travel-options";
import {
  PET_TRAVEL_PAYLOAD_VERSION,
  PET_TRAVEL_STALE_AFTER_MS,
  type PetTravelObligationV1,
  type PetTravelTripV1,
  type PetTravelV1,
} from "@dim/contract/api";

import { unavailable } from "./commands";

/** The access query plus one indexed read of the pet's libreta events. */
const READ_BUDGET_MS = 8_000;

function corridorLabel(id: string): string {
  return (CORRIDOR_IDS as readonly string[]).includes(id)
    ? getCorridor(id as CorridorId).label
    : id;
}

function toWireTrip(trip: TravelView["trips"][number]): PetTravelTripV1 {
  const mode =
    trip.mode === "air" || trip.mode === "land" || trip.mode === "sea" ? trip.mode : null;
  return {
    tripEventId: trip.eventId,
    corridorId: trip.corridorId,
    corridorLabel: corridorLabel(trip.corridorId),
    travelDate: trip.travelDate,
    mode,
    airlineId: trip.airlineId,
    airlineName:
      trip.airlineId && isAirlineId(trip.airlineId) ? getAirline(trip.airlineId).name : null,
    intendedModality: trip.intendedModality,
  };
}

function toWireObligation(
  o: NonNullable<TravelView["compliance"]>["obligations"][number],
): PetTravelObligationV1 {
  return {
    id: o.id,
    group: o.group,
    label: o.label,
    state: o.state,
    detail: o.detail,
    requirementLevel: o.requirementLevel,
    contributingJurisdictions: o.contributingJurisdictions,
    sources: o.sources.map((s) => ({
      kind: s.kind,
      label: s.label,
      issuerLabel: s.issuerLabel,
      sourceUrl: s.sourceUrl,
      lastVerifiedAt: s.lastVerifiedAt,
      freshness: s.freshness,
    })),
    freshnessNotice: o.freshnessNotice,
    legalFootnote: o.legalFootnote,
    documents: o.documents ? o.documents.map((d) => ({ ...d })) : null,
    evidence: o.evidence ?? null,
  };
}

export function buildPetTravelV1(params: {
  pet: { publicToken: string; name: string; status: string };
  view: TravelView;
  now: Date;
}): PetTravelV1 {
  const { pet, view, now } = params;
  const compliance = view.compliance;
  return {
    ...apiV1Envelope({
      payloadVersion: PET_TRAVEL_PAYLOAD_VERSION,
      issuedAt: now,
      staleAfterMs: PET_TRAVEL_STALE_AFTER_MS,
    }),
    publicToken: pet.publicToken,
    petName: pet.name,
    trips: view.trips.map(toWireTrip),
    selectedTripEventId: view.selectedTrip?.eventId ?? null,
    compliance: compliance
      ? {
          semaforo: compliance.semaforo,
          semaforoLabel: TRAVEL_SEMAFORO_LABELS[compliance.semaforo],
          obligations: compliance.obligations.map(toWireObligation),
          corridors: compliance.corridorsShown.map((c) => ({ ...c })),
        }
      : null,
    cvis: view.cvis,
    disclaimers: [TRAVEL_DISCLAIMER, `${TRAVEL_AIRLINE_NOTICE} antes de reservar.`],
    options: {
      // v14: the same objects the /viaje form receives (travel-options.ts).
      ...travelFormOptions(),
    },
    capabilities: { canRecord: pet.status !== "deceased" },
    exportWebUrl: `${resolveSiteUrl()}/mis-mascotas/${encodeURIComponent(pet.publicToken)}/viaje`,
  };
}

export type TravelReadContext = {
  publicToken: string;
  userId: string;
  /** `?trip=` — the trip to read; the next one when absent or unknown. */
  tripId: string | null;
  now?: Date;
};

/** Everything from the access guard to the body. */
export async function readPetTravel(ctx: TravelReadContext) {
  let access: PetHolderAccess;
  try {
    access = await withDbBudgetOrThrow(
      resolvePetHolderAccess(ctx.publicToken, ctx.userId),
      READ_BUDGET_MS,
      "api-v1-travel-read-access",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  // A pet this caller may not read and a pet that does not exist answer
  // IDENTICALLY. Anything else turns this endpoint into an oracle.
  if (access.kind === "none") return apiV1Error("not_found", 404);

  const viewer =
    access.kind === "owner"
      ? { accessPath: "owner" as const, holderRole: access.holderRole }
      : { accessPath: "org" as const, holderRole: null };
  const pet: TravelViewPet & { publicToken: string; name: string; status: string } = access.pet;
  const now = ctx.now ?? new Date();

  let result: Awaited<ReturnType<typeof loadTravelView>>;
  try {
    result = await withDbBudgetOrThrow(
      loadTravelView({ pet, viewer, tripId: ctx.tripId, now }),
      READ_BUDGET_MS,
      "api-v1-travel-read",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!result.ok) return apiV1Error("travel_forbidden", 403);

  return apiV1Json(buildPetTravelV1({ pet, view: result.view, now }), { status: 200 });
}

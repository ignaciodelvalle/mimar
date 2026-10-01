// loadTravelView — THE ONE READ behind every surface that shows an owner their
// trip (viajes-fase-2, design D5 / task 5.1).
//
// The /viaje page, `GET /api/v1/pets/{publicToken}/travel` and the travel PDF
// export (generate-travel-export.ts) all call it, so web, the native screen and the PDF show the
// same semáforo BY CONSTRUCTION rather than by three derivations agreeing.
//
// What it does:
//   1. refuses anyone `canAccessTravel` refuses — BEFORE any read. A trip says
//      when a household is away and where it is going (design D8);
//   2. reads the pet's libreta events plus the corrections that fold onto them
//      (overlayAmendments), the same event set the rule engine checks;
//   3. lists the trips still on (deriveTrips) that are upcoming or at most
//      RECENT_TRAVEL_WINDOW_MS old, and picks ONE: the one asked for, else the
//      next one, else the latest recent one;
//   4. derives the semáforo for THAT trip only — its corridor, its airline and
//      its modality, against the pet's own facts. One trip per reading: mixing
//      every active trip's corridors (what deriveTravelContext does for the
//      Fase 1 export) would show Chile's rules on a Uruguay trip.
//
// It never writes and never reads `pets.*` caches: the caller passes the row it
// already holds.

import { and, asc, eq, inArray } from "drizzle-orm";

import { type OwnershipRole, type Pet, db, petEvents } from "@/db";
import { overlayAmendments } from "@/lib/infra/amendment";
import { type PetAccessPath, canAccessTravel } from "@/lib/infra/pet-access";
import {
  RECENT_TRAVEL_WINDOW_MS,
  type TravelComplianceEvent,
  type TravelComplianceState,
  type TravelTrip,
  deriveTravelCompliance,
  deriveTrips,
} from "@/lib/projections/travel-compliance";
import { MODALITY_LABELS } from "@/lib/projections/travel-libreta-checks";
import { type Airline, getAirline, isAirlineId } from "@/lib/reference/airlines";
import {
  CORRIDOR_IDS,
  type Corridor,
  type CorridorId,
  getCorridor,
} from "@/lib/reference/cross-border-corridors";
import { isoToArDateDisplay } from "@/lib/utils/date-input-ar";
import { isoDateInAr } from "@/lib/utils/format";

/**
 * Every event type the travel rule engine reads (design D3): rabies doses,
 * dewormings, the microchip, weights, lab work (titre), the trips and the CVI,
 * plus the corrections that fold onto them.
 */
export const TRAVEL_VIEW_EVENT_TYPES = [
  "movement_recorded",
  "vaccination_administered",
  "deworming_administered",
  "microchip_implanted",
  "microchip_replaced",
  "weight_recorded",
  "clinical_info_logged",
  "event_amended",
] as const;

/** The `pets` columns the view reads. Structural — a full row satisfies it. */
export type TravelViewPet = Pick<
  Pet,
  | "id"
  | "species"
  | "breed"
  | "dateOfBirth"
  | "birthDateIsEstimated"
  | "jurisdictionCountry"
  | "jurisdictionProvince"
  | "jurisdictionLocality"
>;

/** Who is reading, as the door resolved it. */
export type TravelViewer = {
  accessPath: PetAccessPath | null;
  holderRole: OwnershipRole | string | null;
};

/** One SENASA CVI the owner recorded. */
export type TravelCvi = {
  eventId: string;
  cviNumber: string;
  /** `YYYY-MM-DD`, as printed. */
  issuedDate: string;
  /** `YYYY-MM-DD`, when the owner copied it; null otherwise. */
  validUntil: string | null;
};

export type TravelView = {
  /** The trips still on that are upcoming or recent, earliest first. */
  trips: TravelTrip[];
  /** The trip the semáforo is about; null when there is none. */
  selectedTrip: TravelTrip | null;
  /** Every CVI on record, the most recently issued first. */
  cvis: TravelCvi[];
  /** The selected trip's corridor. */
  corridor: Corridor | null;
  /** The selected trip's airline, when the owner chose one. */
  airline: Airline | null;
  /** The semáforo and its obligations, for the selected trip only. */
  compliance: TravelComplianceState | null;
};

export type LoadTravelViewResult =
  | { ok: true; view: TravelView }
  | { ok: false; code: "forbidden" };

type ViewEvent = {
  id: string;
  eventType: string;
  occurredAt: Date | string;
  payload: unknown;
};

function isCorridorId(value: string): value is CorridorId {
  return (CORRIDOR_IDS as readonly string[]).includes(value);
}

/** "Chile, 12/11/2026" — how a trip is named on /viaje and in its PDF. */
export function travelTripLabel(trip: TravelTrip): string {
  const corridor = isCorridorId(trip.corridorId)
    ? getCorridor(trip.corridorId).label
    : trip.corridorId;
  return `${corridor}, ${isoToArDateDisplay(trip.travelDate)}`;
}

/** "Chile, 12/11/2026 · LATAM, en cabina" — the line over the semáforo. */
export function travelTripSummary(trip: TravelTrip): string {
  const airline =
    trip.airlineId && isAirlineId(trip.airlineId) ? getAirline(trip.airlineId).name : null;
  if (!airline) return travelTripLabel(trip);
  const where = trip.intendedModality ? `, en ${MODALITY_LABELS[trip.intendedModality]}` : "";
  return `${travelTripLabel(trip)} · ${airline}${where}`;
}

/** The CVIs among the overlaid movement rows, the most recently issued first. */
export function deriveCvis(events: readonly ViewEvent[]): TravelCvi[] {
  const cvis: TravelCvi[] = [];
  for (const e of events) {
    if (e.eventType !== "movement_recorded") continue;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (p.sub_kind !== "cvi_issued") continue;
    if (typeof p.cvi_number !== "string" || typeof p.issued_date !== "string") continue;
    cvis.push({
      eventId: e.id,
      cviNumber: p.cvi_number,
      issuedDate: p.issued_date,
      validUntil: typeof p.valid_until === "string" ? p.valid_until : null,
    });
  }
  return cvis.sort((a, b) => b.issuedDate.localeCompare(a.issuedDate));
}

/**
 * The trips worth showing and the one the semáforo reads. A trip older than
 * RECENT_TRAVEL_WINDOW_MS is history, not a plan: it drops off the list.
 */
export function selectTrip(
  allTrips: readonly TravelTrip[],
  tripId: string | null,
  now: Date,
): { trips: TravelTrip[]; selectedTrip: TravelTrip | null } {
  const today = isoDateInAr(now);
  const oldest = isoDateInAr(new Date(now.getTime() - RECENT_TRAVEL_WINDOW_MS));
  const trips = allTrips.filter(
    (t) => isCorridorId(t.corridorId) && t.travelDate.localeCompare(oldest) >= 0,
  );
  const asked = tripId ? trips.find((t) => t.eventId === tripId) : undefined;
  const next = trips.find((t) => t.travelDate.localeCompare(today) >= 0);
  const latest = trips.length > 0 ? trips[trips.length - 1] : undefined;
  return { trips, selectedTrip: asked ?? next ?? latest ?? null };
}

/** The pure half: overlaid events + the pet's facts → the view. */
export function buildTravelView(params: {
  pet: TravelViewPet;
  events: readonly ViewEvent[];
  tripId: string | null;
  now: Date;
}): TravelView {
  const { pet, events, now } = params;
  const { trips, selectedTrip } = selectTrip(deriveTrips(events), params.tripId, now);
  const cvis = deriveCvis(events);

  if (!selectedTrip || !isCorridorId(selectedTrip.corridorId)) {
    return { trips, selectedTrip: null, cvis, corridor: null, airline: null, compliance: null };
  }

  const corridor = getCorridor(selectedTrip.corridorId);
  const airline =
    selectedTrip.airlineId && isAirlineId(selectedTrip.airlineId)
      ? getAirline(selectedTrip.airlineId)
      : null;

  const libreta: TravelComplianceEvent[] = events
    .filter((e) => e.eventType !== "event_amended")
    .map((e) => ({ eventType: e.eventType, payload: e.payload, occurredAt: e.occurredAt }));

  const compliance = deriveTravelCompliance({
    now,
    origin: {
      country: pet.jurisdictionCountry ?? "AR",
      province: pet.jurisdictionProvince,
      locality: pet.jurisdictionLocality,
    },
    // The trip names its corridor, so no destination has to be inferred from
    // domestic moves (they only matter when NO corridor resolves).
    destinations: [],
    corridors: [corridor],
    travelDate: new Date(`${selectedTrip.travelDate}T00:00:00Z`),
    events: libreta,
    pet: {
      species: pet.species,
      dateOfBirth: pet.dateOfBirth,
      birthDateIsEstimated: pet.birthDateIsEstimated,
      breed: pet.breed,
    },
    airline,
    modality: airline ? selectedTrip.intendedModality : null,
    confirmedDocuments: selectedTrip.documentsConfirmed,
  });

  return { trips, selectedTrip, cvis, corridor, airline, compliance };
}

/**
 * The owner's trips and the semáforo of one of them. Refuses — before reading
 * anything — a viewer who is not a travel titular (canAccessTravel).
 */
export async function loadTravelView(params: {
  pet: TravelViewPet;
  viewer: TravelViewer;
  tripId?: string | null;
  now?: Date;
}): Promise<LoadTravelViewResult> {
  const { pet, viewer } = params;
  if (!canAccessTravel(viewer.accessPath, viewer.holderRole)) {
    return { ok: false, code: "forbidden" };
  }

  const rows = await db
    .select({
      id: petEvents.id,
      petId: petEvents.petId,
      eventType: petEvents.eventType,
      occurredAt: petEvents.occurredAt,
      recordedAt: petEvents.recordedAt,
      payload: petEvents.payload,
    })
    .from(petEvents)
    .where(
      and(eq(petEvents.petId, pet.id), inArray(petEvents.eventType, [...TRAVEL_VIEW_EVENT_TYPES])),
    )
    .orderBy(asc(petEvents.occurredAt));

  return {
    ok: true,
    view: buildTravelView({
      pet,
      events: overlayAmendments(rows),
      tripId: params.tripId ?? null,
      now: params.now ?? new Date(),
    }),
  };
}

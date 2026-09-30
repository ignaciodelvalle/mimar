// What `/api/v1/pets/{publicToken}/travel` answers (viajes-fase-2, D4/D5).
//
// GET is a READ with the envelope (`payloadVersion`, `issuedAt`, `staleAfter`):
// the owner's trips, their CVIs, and the SERVER-computed semáforo of one trip.
// The native screen draws it as it comes; it never re-derives a rule. That is
// what makes web and phone show the same state (spec mobile-travel-screen).
//
// POST answers a BARE ACK, no envelope — the split every command surface on
// `/api/v1` makes (see `PetMoveRecordedV1`, `VaccineReminderCommandAckV1`): a
// `payloadVersion` and a staleness window describe a READ, and an
// acknowledgement of something that just happened has neither.
//
// NOTHING HERE PROMISES. `semaforoLabel` is the server's es-AR wording ("Sin
// pendientes detectados" for green), and `disclaimers` travel with every
// reading. A client shows both; it does not write its own.

export const PET_TRAVEL_PAYLOAD_VERSION = 1;

/**
 * How long a client may present a cached copy as current.
 *
 * SIXTY SECONDS: nobody else writes a titular's trip, so the reading only
 * moves when this owner records something or a day turns over — and the
 * owner's own write already refetches.
 */
export const PET_TRAVEL_STALE_AFTER_MS = 60_000;

/**
 * What every airline block says, on the web and on the phone (design D5).
 *
 * THE HOME IS HERE AND NOT IN `lib/domain/travel-copy.ts`, which re-exports it:
 * the native screen draws the airline block too, and it cannot import server
 * code. One constant in the package both sides already share is how the two
 * surfaces cannot drift into two wordings of the same warning.
 */
export const PET_TRAVEL_AIRLINE_NOTICE = "Verificá con tu aerolínea";

/**
 * The three groups of obligations, in the order both surfaces list them. Same
 * reason for living here as `PET_TRAVEL_AIRLINE_NOTICE`.
 */
export const PET_TRAVEL_GROUP_LABELS = {
  destino: "Destino",
  aerolinea: "Aerolínea",
  libreta: "Libreta",
} as const;

export type PetTravelSemaforoV1 = "rojo" | "amarillo" | "verde" | "sin_datos";

/** One trip still on, as the owner recorded it (after corrections). */
export type PetTravelTripV1 = {
  /** The handle `cancel_trip` takes, and `?trip=` selects. */
  tripEventId: string;
  corridorId: string;
  /** es-AR name of the corridor ("Chile"). */
  corridorLabel: string;
  /** `YYYY-MM-DD`. */
  travelDate: string;
  mode: "air" | "land" | "sea" | null;
  airlineId: string | null;
  airlineName: string | null;
  intendedModality: "cabin" | "hold" | "cargo" | null;
};

export type PetTravelCviV1 = {
  eventId: string;
  cviNumber: string;
  /** `YYYY-MM-DD`. */
  issuedDate: string;
  /** `YYYY-MM-DD`, when the owner copied it. */
  validUntil: string | null;
};

/** Where a rule came from and how fresh the reading of it is. */
export type PetTravelSourceV1 = {
  kind: "corridor" | "airline";
  label: string;
  sourceUrl: string;
  /** `YYYY-MM-DD` a person last checked it. */
  lastVerifiedAt: string;
  /** Neither `expired` nor `unverified` ever reads as settled. */
  freshness: "fresh" | "expired" | "unverified";
};

export type PetTravelObligationV1 = {
  id: string;
  /** Destino, Aerolínea or Libreta — the three lists the screen draws. */
  group: "destino" | "aerolinea" | "libreta";
  label: string;
  state: string;
  detail: string | null;
  requirementLevel: "blocker" | "warning" | "info";
  contributingJurisdictions: string[];
  sources: PetTravelSourceV1[];
  /** "Verificá — …" when a source is expired or unverified; else null. */
  freshnessNotice: string | null;
  legalFootnote: string;
};

export type PetTravelComplianceV1 = {
  semaforo: PetTravelSemaforoV1;
  /** The server's label for `semaforo`. Draw it verbatim. */
  semaforoLabel: string;
  /** Worst first. */
  obligations: PetTravelObligationV1[];
  corridors: {
    id: string;
    label: string;
    version: string;
    effectiveFrom: string;
    sourceUrl: string;
  }[];
};

export type PetTravelV1 = {
  payloadVersion: typeof PET_TRAVEL_PAYLOAD_VERSION;
  issuedAt: string;
  staleAfter: string;
  publicToken: string;
  petName: string;
  /** Upcoming or recent trips, earliest first. */
  trips: PetTravelTripV1[];
  /** The trip `compliance` reads; null when no trip is on. */
  selectedTripEventId: string | null;
  /** Null when no trip is on — there is nothing to check against. */
  compliance: PetTravelComplianceV1 | null;
  /** The most recently issued first. */
  cvis: PetTravelCviV1[];
  /** Shown with every reading, whatever its colour. */
  disclaimers: string[];
  /** What the record-trip form offers. */
  options: {
    corridors: { id: string; label: string }[];
    airlines: { id: string; name: string }[];
  };
  capabilities: {
    /** False for a deceased animal: the writers refuse it. */
    canRecord: boolean;
  };
  /** The web /viaje page, absolute — where the PDF is generated (design D5). */
  exportWebUrl: string;
};

/**
 * `replayed` is true when the `Idempotency-Key` resolved to a write that
 * already happened: nothing was appended, and `eventId` is the first write's.
 * A client that retried after a timeout reads it to know its first attempt
 * landed. `changed` on the cancel half says the same thing about STATE: a trip
 * already cancelled answers `changed: false`, never a refusal.
 */
export type PetTravelCommandAckV1 =
  | { command: "record_trip"; eventId: string; replayed: boolean }
  | { command: "record_cvi"; eventId: string; replayed: boolean }
  | { command: "cancel_trip"; tripEventId: string; changed: boolean };

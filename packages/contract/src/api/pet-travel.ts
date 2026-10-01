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

/**
 * The semáforo's words, on the web, on the phone and in the PDF. Same reason
 * for living here as `PET_TRAVEL_AIRLINE_NOTICE`: the server sends
 * `semaforoLabel` from this table, and a native test pins the same table, so a
 * reworded colour cannot reach one surface and miss the other.
 *
 * NOTHING HERE PROMISES. Red says something is pending, not that the animal
 * may not travel (PO 2026-10-01): miMAR reads the libreta against rules it
 * copied; the authority and the airline decide.
 */
export const PET_TRAVEL_SEMAFORO_LABELS: Record<PetTravelSemaforoV1, string> = {
  rojo: "Hay requisitos pendientes",
  amarillo: "Revisar pendientes",
  verde: "Sin pendientes detectados",
  // A foreign destination is on record but no corridor was resolved for it:
  // nothing was checked, so none of the three colours applies.
  sin_datos: "Verificación no disponible",
};

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
  /**
   * Only on the papers-to-carry obligation: each document, and whether the
   * owner ticked "Lo tengo" for it on THIS trip (`confirm_trip_document`).
   * Null on every other obligation. Optional on the wire so a server older
   * than the client still parses.
   */
  documents?: PetTravelDocumentV1[] | null;
};

/** One paper the trip asks for, and whether the owner said they have it. */
export type PetTravelDocumentV1 = {
  /** The document as the rule names it — also the key the command takes. */
  label: string;
  confirmed: boolean;
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
 * already cancelled answers `changed: false`, never a refusal. The document
 * tick answers the same way: ticking a document already ticked is
 * `changed: false`.
 */
export type PetTravelCommandAckV1 =
  | { command: "record_trip"; eventId: string; replayed: boolean }
  | { command: "record_cvi"; eventId: string; replayed: boolean }
  | { command: "cancel_trip"; tripEventId: string; changed: boolean }
  | { command: "confirm_trip_document"; tripEventId: string; changed: boolean };

/**
 * `POST /api/v1/pets/{publicToken}/travel/export[?trip=]` — the travel PDF, as
 * a bare ack (task 6.5).
 *
 * THE SAME PDF THE WEB HANDS OUT. The server renders it from the same reading
 * `GET` returns for that trip (`loadTravelView`), stores it in the private
 * `travel-exports` bucket and signs a download link; the web's "Descargar
 * documentación de viaje" button gets the same link from the same use-case.
 * The app downloads the file and hands it to the share sheet. No PDF is ever
 * drawn on the phone, so paper and screen cannot disagree.
 *
 * A POST, not a GET: every export stores a file and writes an audit row.
 */
export type PetTravelExportV1 = {
  /** Signed download link to the PDF. Valid until `expiresAt`, no auth header. */
  pdfUrl: string;
  /** ISO instant; the link stops working after it (24 hours). */
  expiresAt: string;
};

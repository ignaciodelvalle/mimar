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

//
// THE v14 REDESIGN ADDS, NEVER CHANGES (2026-10-07, "Viaje en pasos"). Every
// field below marked "v14" is OPTIONAL on the wire: a v13 app reading a v14
// server ignores it, and a v14 app reading a v13 server finds it absent and
// falls back to what v13 showed (all 20 airlines, every mode, every modality).
// That is why `payloadVersion` stays at 1.

import type { TravelCorridorId } from "../input/pet-travel.ts";

export const PET_TRAVEL_PAYLOAD_VERSION = 1;

/** How a trip goes. The wire value `land` is "En auto o en micro". */
export type PetTravelModeV1 = "air" | "land" | "sea";

/** Where the animal flies. */
export type PetTravelModalityV1 = "cabin" | "hold" | "cargo";

/**
 * v14 — the modes each destination offers, in the order the form lists them.
 * A SUGGESTION for the form, not a rule the server enforces: a v13 client may
 * still record any mode, and the server accepts it. When a destination offers
 * one mode only, the form skips the question.
 */
export const CORRIDOR_MODES: Record<TravelCorridorId, readonly PetTravelModeV1[]> = {
  chile: ["air", "land"],
  uruguay: ["air", "sea", "land"],
  brasil: ["air", "land"],
  ue_espana: ["air"],
  usa: ["air"],
};

/** v14 — the es-AR words of each mode, as the form and the trip header say them. */
export const PET_TRAVEL_MODE_LABELS: Record<PetTravelModeV1, string> = {
  air: "En avión",
  land: "En auto o en micro",
  sea: "En barco",
};

/** v14 — the es-AR words of each modality, as the form and the trip header say them. */
export const PET_TRAVEL_MODALITY_LABELS: Record<PetTravelModalityV1, string> = {
  cabin: "En cabina",
  hold: "En bodega",
  cargo: "Como carga",
};

/**
 * v14 — the seal a requirement carries when the libreta meets it ONLY through
 * entries without professional verification (`evidence: "declared"`). PO
 * 2026-10-07: for travel, only what a matriculated vet or an institution
 * recorded counts as verified; the owner's own entry, an organisation without
 * matrícula and a vet whose matrícula is not validated are declared. One
 * wording for all of them — "Declarado por vos" was false for the last two —
 * and no pronoun, so it agrees with a vaccine and a microchip alike.
 */
export const PET_TRAVEL_DECLARED_SEAL =
  "Sin verificación profesional · falta el registro de tu veterinaria";

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
  /**
   * v14 — who PUBLISHES the rule, for the "Fuente:" line: "SENASA, requisitos
   * para Chile", "Reglamento de Ejecución (UE) 2026/636", "LATAM, política de
   * mascotas". `label` stays the corridor or airline the rule belongs to.
   * Absent on a v13 server: fall back to `label`.
   */
  issuerLabel?: string;
};

/**
 * v14 — what backs a requirement the libreta answers:
 *   · `verified` — met by entries a matriculated vet or an institution recorded;
 *   · `declared` — it WOULD be met, but only on the owner's own entries (or an
 *                  organisation's without matrícula). Never counted as met: the
 *                  requirement stays at `warning` ("Atención") and shows
 *                  PET_TRAVEL_DECLARED_SEAL;
 *   · `none`     — not met, or nothing on record.
 * Null on obligations the libreta does not answer (destination rules, papers,
 * airline policy). Absent on a v13 server.
 */
export type PetTravelEvidenceV1 = "verified" | "declared" | "none";

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
  /** v14 — see PetTravelEvidenceV1. */
  evidence?: PetTravelEvidenceV1 | null;
};

/**
 * v14 — the one-tap action a requirement offers, by what resolves it:
 *   · `record_paper`   — the destination's paper: "Cargar el CZI" (the CVI form);
 *   · `ask_vet`        — the vet records it (a dose, a chip, a titre):
 *                        "Pedírselo a mi veterinaria", the share sheet with the
 *                        trip PDF;
 *   · `send_to_vet`    — the same share, when the owner already declared it
 *                        (`evidence: "declared"`): "Mandar a mi veterinaria";
 *   · `record_weight`  — the owner may record a weight;
 *   · `confirm_papers` — the papers-to-carry checklist ("Para llevar").
 */
export type PetTravelActionKindV1 =
  | "record_paper"
  | "ask_vet"
  | "send_to_vet"
  | "record_weight"
  | "confirm_papers";

/**
 * v14 — rule type → action. The KEY is the rule type, which is the obligation
 * `id` up to its first ":" (`document_issuance_window_days:senasa_cvi`). A rule
 * type absent here offers no action (an airline policy, a destination permit):
 * its "Ver detalle" says who decides.
 */
export const PET_TRAVEL_RULE_ACTIONS: Readonly<Record<string, PetTravelActionKindV1>> = {
  document_issuance_window_days: "record_paper",
  rabies_vaccination_to_travel_wait_days: "ask_vet",
  rabies_vaccination_min_age_days: "ask_vet",
  rabies_vaccination_max_days_before_travel: "ask_vet",
  required_vaccines: "ask_vet",
  parasite_treatment_window_days: "ask_vet",
  parasite_treatment_min_days_before: "ask_vet",
  microchip_required: "ask_vet",
  microchip_before_vaccination_required: "ask_vet",
  rabies_titer_test_required: "ask_vet",
  rabies_titer_test_wait_days: "ask_vet",
  max_weight_kg: "record_weight",
  required_documents: "confirm_papers",
};

/** v14 — the button words of each action. `record_paper` names the paper. */
export const PET_TRAVEL_ACTION_LABELS: Record<
  Exclude<PetTravelActionKindV1, "record_paper">,
  string
> = {
  ask_vet: "Pedírselo a mi veterinaria",
  send_to_vet: "Mandar a mi veterinaria",
  record_weight: "Anotar el peso",
  confirm_papers: "Ver los papeles",
};

/** v14 — "Cargar el CZI": the record_paper button, from the corridor's paper. */
export function petTravelRecordPaperLabel(paperShortName: string): string {
  return `Cargar el ${paperShortName}`;
}

/** v14 — the rule type an obligation id is about (its id up to the first ":"). */
export function petTravelRuleTypeOf(obligationId: string): string {
  const colon = obligationId.indexOf(":");
  return colon === -1 ? obligationId : obligationId.slice(0, colon);
}

/**
 * v14 — the action an obligation offers, or null. A requirement met only on
 * the owner's word asks the vet to record it (`send_to_vet`); one already met
 * offers nothing.
 */
export function petTravelObligationAction(obligation: {
  id: string;
  requirementLevel: "blocker" | "warning" | "info";
  evidence?: PetTravelEvidenceV1 | null;
}): PetTravelActionKindV1 | null {
  // Met already — or met by a verified entry and only kept amber by a stale
  // source, which no vet visit fixes.
  if (obligation.requirementLevel === "info" || obligation.evidence === "verified") return null;
  const kind = PET_TRAVEL_RULE_ACTIONS[petTravelRuleTypeOf(obligation.id)] ?? null;
  if (kind === "ask_vet" && obligation.evidence === "declared") return "send_to_vet";
  return kind;
}

/** v14 — the paper a destination asks for, named the way that destination names it. */
export type PetTravelPaperV1 = {
  /** "Certificado Zoosanitario de Importación (CZI)". */
  name: string;
  /** "CZI" — for "Cargar el CZI" and the papers line. */
  shortName: string;
};

/** v14 — one destination the form offers. */
export type PetTravelCorridorOptionV1 = {
  id: string;
  label: string;
  /** v14 — the paper this destination asks for. */
  paper?: PetTravelPaperV1;
  /**
   * v14 — the destination's deadlines as sentences, for the date step ("La
   * antirrábica tiene que tener al menos 21 días el día del viaje."). Built by
   * the SERVER from the corridor's rules and nothing about the animal: they are
   * the rules, never a verdict.
   */
  leadHints?: string[];
  /**
   * v14 — the longest wait the destination declares, in days (21 for the
   * antirrábica). A departure closer than this to today switches the date
   * step's box to its warning tone. Null when it declares no wait.
   */
  leadDays?: number | null;
};

/** v14 — one modality an airline publishes, for the "¿Dónde viaja?" step. */
export type PetTravelAirlineModalityV1 = {
  modality: PetTravelModalityV1;
  /** `restricted`: offered with conditions (only some routes, some passengers). */
  offered: "yes" | "restricted";
  /** What the airline publishes as its weight limit, when it publishes one. */
  maxWeightKg: number | null;
  /** True when that limit counts the bag or crate. */
  includesCarrier: boolean;
};

/** One airline the form offers. */
export type PetTravelAirlineOptionV1 = {
  id: string;
  name: string;
  /**
   * v14 — the destinations miMAR lists this airline FIRST for. A suggested
   * order maintained by miMAR (PO 2026-10-07), never a rule: every airline
   * stays reachable through "Buscar otra aerolínea".
   */
  corridors?: string[];
  /**
   * v14 — the modalities this airline publishes as offered (anything but
   * "no"), in cabin → hold → cargo order. Empty when it publishes none.
   */
  modalities?: PetTravelAirlineModalityV1[];
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
    corridors: PetTravelCorridorOptionV1[];
    airlines: PetTravelAirlineOptionV1[];
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
 * v14 — WHICH input the server refused, beside `travel_input_invalid`.
 *
 * The code stays `travel_input_invalid` (a v13 app keeps its one sentence);
 * the body gains `reason`, so a v14 app can say the one thing that is wrong
 * instead of three causes at once (QA 2026-10-07, copy 1). The sentences live
 * in PET_TRAVEL_REFUSAL_MESSAGES, which the web's Server Actions answer with
 * too — the two surfaces cannot word the same refusal twice.
 */
export const PET_TRAVEL_REFUSAL_REASONS = [
  "TRAVEL_DATE_INVALID",
  "TRAVEL_DATE_OUT_OF_RANGE",
  "AIRLINE_UNKNOWN",
  "AIRLINE_NOT_AIR",
  "MODALITY_NOT_AIR",
  "CVI_NUMBER_REQUIRED",
  "ISSUED_DATE_INVALID",
  "ISSUED_DATE_FUTURE",
  "ISSUED_DATE_TOO_OLD",
  "VALID_UNTIL_INVALID",
  "VALID_UNTIL_BEFORE_ISSUED",
  "VALID_UNTIL_TOO_FAR",
  "DOCUMENT_NOT_LISTED",
] as const;
export type PetTravelRefusalReasonV1 = (typeof PET_TRAVEL_REFUSAL_REASONS)[number];

/** v14 — the es-AR sentence of each refusal reason, on the web and on the phone. */
export const PET_TRAVEL_REFUSAL_MESSAGES: Record<PetTravelRefusalReasonV1, string> = {
  TRAVEL_DATE_INVALID: "Ingresá una fecha de viaje válida.",
  TRAVEL_DATE_OUT_OF_RANGE: "La fecha de viaje tiene que ser desde ayer y hasta dentro de un año.",
  AIRLINE_UNKNOWN: "Elegí una aerolínea de la lista.",
  AIRLINE_NOT_AIR: "Si elegís una aerolínea, el viaje tiene que ser aéreo.",
  MODALITY_NOT_AIR: "Cabina, bodega o carga solo aplican a un viaje aéreo.",
  CVI_NUMBER_REQUIRED: "Ingresá el número del certificado.",
  ISSUED_DATE_INVALID: "Ingresá una fecha de emisión válida.",
  ISSUED_DATE_FUTURE: "La fecha de emisión no puede ser futura.",
  ISSUED_DATE_TOO_OLD: "La fecha de emisión tiene que ser de los últimos doce meses.",
  VALID_UNTIL_INVALID: "Ingresá una fecha de vencimiento válida.",
  VALID_UNTIL_BEFORE_ISSUED: "El vencimiento no puede ser anterior a la emisión.",
  VALID_UNTIL_TOO_FAR: "Revisá el vencimiento: no puede superar un año desde la emisión.",
  DOCUMENT_NOT_LISTED: "Ese documento no figura entre los que pide este viaje.",
};

/** v14 — the 400 body of a `travel_input_invalid`: the code, plus why. */
export type PetTravelInputInvalidV1 = {
  error: "travel_input_invalid";
  /** Absent on a v13 server. */
  reason?: PetTravelRefusalReasonV1;
};

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

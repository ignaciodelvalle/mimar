// VIAJE — turning what the owner picked into what the contract accepts, and
// what the server read into what a person sees (viajes-fase-2, task 6.2).
//
// PURE, like every other view-model in this app: it owns the es-AR sentence for
// every form state and every acknowledgement, and nothing here touches the
// network.
//
// THE SEMÁFORO IS NOT COMPUTED HERE, AND THAT IS THE WHOLE DESIGN. Its colour,
// its label ("Sin pendientes detectados" for green), every obligation's state
// and every source's freshness arrive from `GET /pets/{token}/travel`, which
// reads the same loader the web's /viaje page renders from. What lives here is
// ARRANGEMENT — which group an obligation is listed under, how a date is
// printed — never a verdict. A second rule engine on the phone would be the one
// way web and phone could disagree about whether a dog may board.
//
// NOTHING HERE PROMISES. The words that could — the semáforo label, the
// disclaimers — are the server's, drawn verbatim; the words that are shared
// between both surfaces (the airline notice, the group headings) come from the
// contract, so neither surface can reword them alone.
//
// THE VALIDATION IS THE SERVER'S OWN SCHEMA, imported and not re-stated — the
// rule `mudanza-view-model.ts` follows. The contract carries codes; the words
// for them are this file's.

import {
  PET_TRAVEL_AIRLINE_NOTICE,
  PET_TRAVEL_GROUP_LABELS,
  type PetTravelCommandAckV1,
  type PetTravelComplianceV1,
  type PetTravelCviV1,
  type PetTravelObligationV1,
  type PetTravelSemaforoV1,
  type PetTravelSourceV1,
  type PetTravelTripV1,
} from "@dim/contract/api";
import {
  type PetTravelCommandInput,
  type PetTravelCommandInputCode,
  type TRAVEL_MODALITIES,
  type TRAVEL_MODES,
  firstPetTravelCommandInputCode,
  petTravelCommandInputSchema,
} from "@dim/contract/input";

import { dateInputToIso, isoToDateInput } from "../ui/date-input";
import type { CalloutTone } from "../ui/kit";

export type TravelMode = (typeof TRAVEL_MODES)[number];
export type TravelModality = (typeof TRAVEL_MODALITIES)[number];
export type ObligationGroup = PetTravelObligationV1["group"];

// ---------- Reading ----------------------------------------------------------

/**
 * The semáforo's colour, as a callout tone. `sin_datos` is NEUTRAL, not a
 * warning and not green: nothing was checked, so none of the colours applies.
 */
export function semaforoTone(semaforo: PetTravelSemaforoV1): CalloutTone {
  switch (semaforo) {
    case "rojo":
      return "err";
    case "amarillo":
      return "warn";
    case "verde":
      return "ok";
    case "sin_datos":
      return "neutral";
  }
}

/** "Chile, 12/11/2026" — how a trip is named, as on the web. */
export function tripLabel(trip: PetTravelTripV1): string {
  return `${trip.corridorLabel}, ${isoToDateInput(trip.travelDate)}`;
}

const MODALITY_WORD: Record<TravelModality, string> = {
  cabin: "cabina",
  hold: "bodega",
  cargo: "carga",
};

/** "Chile, 12/11/2026 · LATAM, en cabina" — the line under the semáforo. */
export function tripSummary(trip: PetTravelTripV1): string {
  if (trip.airlineName === null) return tripLabel(trip);
  const where = trip.intendedModality ? `, en ${MODALITY_WORD[trip.intendedModality]}` : "";
  return `${tripLabel(trip)} · ${trip.airlineName}${where}`;
}

/** The trip `compliance` reads, from the list the payload carries. */
export function selectedTrip(
  trips: readonly PetTravelTripV1[],
  selectedTripEventId: string | null,
): PetTravelTripV1 | null {
  if (selectedTripEventId === null) return null;
  return trips.find((t) => t.tripEventId === selectedTripEventId) ?? null;
}

export type ObligationSection = {
  group: ObligationGroup;
  title: string;
  /** Only on the airline group: the notice, with the airline's name. */
  airlineNotice: string | null;
  obligations: PetTravelObligationV1[];
};

const GROUP_ORDER: readonly ObligationGroup[] = ["destino", "aerolinea", "libreta"];

/**
 * The obligations in the web's three lists, in the web's order.
 *
 * THE SAME TWO OMISSIONS THE WEB MAKES (`viaje/page.tsx`): the airline group
 * is left out when the trip names no airline — "no airline selected" means no
 * airline section, per spec — and an EMPTY group is left out except Destino,
 * which always answers, even if only to say nothing applies.
 */
export function obligationSections(
  compliance: PetTravelComplianceV1,
  trip: PetTravelTripV1,
): ObligationSection[] {
  const sections: ObligationSection[] = [];
  for (const group of GROUP_ORDER) {
    if (group === "aerolinea" && trip.airlineName === null) continue;
    const obligations = compliance.obligations.filter((o) => o.group === group);
    if (obligations.length === 0 && group !== "destino") continue;
    sections.push({
      group,
      title: PET_TRAVEL_GROUP_LABELS[group],
      airlineNotice:
        group === "aerolinea" && trip.airlineName !== null
          ? `${PET_TRAVEL_AIRLINE_NOTICE}: ${trip.airlineName}`
          : null,
      obligations,
    });
  }
  return sections;
}

/** The web's body under the airline notice, with the airline named. */
export function airlineNoticeBody(airlineName: string): string {
  return `Lo que sigue es la política que ${airlineName} publica. Puede cambiar sin aviso: confirmala antes de reservar.`;
}

/** The web's empty sentence for a group with nothing in it. */
export const NO_OBLIGATIONS_LINE = "Sin requisitos para el contexto de viaje registrado.";

const LEVEL_LABEL: Record<PetTravelObligationV1["requirementLevel"], string> = {
  blocker: "Bloqueante",
  warning: "Atención",
  info: "Informativo",
};

/** The badge the web puts beside each obligation, as words. */
export function requirementLevelLabel(level: PetTravelObligationV1["requirementLevel"]): string {
  return LEVEL_LABEL[level];
}

/** "Exigido por: Chile · Argentina", or null when nobody is named. */
export function contributorsLine(obligation: PetTravelObligationV1): string | null {
  if (obligation.contributingJurisdictions.length === 0) return null;
  return `Exigido por: ${obligation.contributingJurisdictions.join(" · ")}`;
}

/** "Fuente: SENASA, revisada el 01/09/2026" — the web's source line. */
export function sourceLine(source: PetTravelSourceV1): string {
  return `Fuente: ${source.label}, revisada el ${isoToDateInput(source.lastVerifiedAt)}`;
}

/** "AR-123: emitido el 01/10/2026, válido hasta el 11/10/2026". */
export function cviLine(cvi: PetTravelCviV1): string {
  const until = cvi.validUntil ? `, válido hasta el ${isoToDateInput(cvi.validUntil)}` : "";
  return `${cvi.cviNumber}: emitido el ${isoToDateInput(cvi.issuedDate)}${until}`;
}

export const NO_TRIP_TITLE = "Todavía no hay un viaje registrado";

export function noTripLine(petName: string): string {
  return `Registrá el destino y la fecha para ver qué pide el país, qué publica la aerolínea y qué dice la libreta de ${petName}.`;
}

/**
 * NOT the web's "Lo emite SENASA antes del viaje.": naming a state body with no
 * norm citation is what `state-endorsement-fence.test.ts` refuses on a
 * citizen-facing file, and the sentence reads fine without it.
 */
export const NO_CVI_LINE =
  "Todavía no registraste un CVI. Cargalo cuando tengas el certificado para este viaje.";

// ---------- Forms ------------------------------------------------------------

/** The record-trip form. `""` means "not chosen" on every picker. */
export type TripDraft = {
  corridorId: string;
  /** `DD/MM/AAAA`, as `DateField` stores it. */
  travelDate: string;
  mode: TravelMode | "";
  airlineId: string;
  intendedModality: TravelModality | "";
};

export const EMPTY_TRIP_DRAFT: TripDraft = {
  corridorId: "",
  travelDate: "",
  mode: "",
  airlineId: "",
  intendedModality: "",
};

export type CviDraft = {
  cviNumber: string;
  /** `DD/MM/AAAA`. */
  issuedDate: string;
  /** `DD/MM/AAAA`, or `""` when the certificate does not say. */
  validUntil: string;
};

export const EMPTY_CVI_DRAFT: CviDraft = { cviNumber: "", issuedDate: "", validUntil: "" };

export const MODE_LABELS: Record<TravelMode, string> = {
  air: "En avión",
  land: "Por tierra",
  sea: "En barco",
};

export const MODALITY_LABELS: Record<TravelModality, string> = {
  cabin: "En cabina",
  hold: "En bodega",
  cargo: "Como carga",
};

export type TravelCommandResult =
  | { ok: true; input: PetTravelCommandInput }
  | { ok: false; code: PetTravelCommandInputCode | null; message: string };

/** One sentence per input code. No code falls through to a generic shrug. */
export function travelInputCodeMessage(code: PetTravelCommandInputCode | null): string {
  switch (code) {
    case "CORRIDOR_REQUIRED":
      return "Elegí el país de destino.";
    case "TRAVEL_DATE_REQUIRED":
      return "Escribí la fecha de salida.";
    case "TRAVEL_DATE_INVALID":
      return "Escribí la fecha de salida como DD/MM/AAAA.";
    case "CVI_NUMBER_REQUIRED":
      return "Escribí el número del CVI, como figura en el certificado.";
    case "ISSUED_DATE_REQUIRED":
      return "Escribí la fecha de emisión del CVI.";
    case "ISSUED_DATE_INVALID":
      return "Escribí la fecha de emisión como DD/MM/AAAA.";
    case "VALID_UNTIL_INVALID":
      return "Escribí la fecha de vencimiento como DD/MM/AAAA, o dejala vacía.";
    case "VALID_UNTIL_BEFORE_ISSUED":
      return "La fecha de vencimiento no puede ser anterior a la de emisión.";
    case "TRIP_ID_REQUIRED":
      return "No pudimos identificar ese viaje. Volvé a abrir la pantalla.";
    case "COMMAND_REQUIRED":
    case null:
      return "No pudimos armar el pedido. Revisá los datos y volvé a intentar.";
  }
}

function fromParse(raw: unknown): TravelCommandResult {
  const parsed = petTravelCommandInputSchema.safeParse(raw);
  if (parsed.success) return { ok: true, input: parsed.data };
  const code = firstPetTravelCommandInputCode(parsed.error);
  return { ok: false, code, message: travelInputCodeMessage(code) };
}

/**
 * REGISTRAR UN VIAJE, from the form.
 *
 * Every blank picker is sent as `null`, which the contract reads as "not
 * stated". The date goes through `dateInputToIso`, which converts the shape
 * and judges nothing — the schema says whether it is a real day.
 */
export function buildTrip(draft: TripDraft): TravelCommandResult {
  return fromParse({
    command: "record_trip",
    // An unchosen corridor is sent as `undefined` so the schema answers
    // CORRIDOR_REQUIRED, not an "invalid enum" nobody could read.
    corridorId: draft.corridorId === "" ? undefined : draft.corridorId,
    travelDate: dateInputToIso(draft.travelDate),
    mode: draft.mode === "" ? null : draft.mode,
    airlineId: draft.airlineId === "" ? null : draft.airlineId,
    intendedModality: draft.intendedModality === "" ? null : draft.intendedModality,
  });
}

/** REGISTRAR UN CVI — the owner copies it off the certificate SENASA issued. */
export function buildCvi(draft: CviDraft): TravelCommandResult {
  return fromParse({
    command: "record_cvi",
    cviNumber: draft.cviNumber,
    issuedDate: dateInputToIso(draft.issuedDate),
    validUntil: draft.validUntil.trim() === "" ? null : dateInputToIso(draft.validUntil),
  });
}

/** CANCELAR UN VIAJE — a correction appended through the amendment path. */
export function buildCancelTrip(tripEventId: string): TravelCommandResult {
  return fromParse({ command: "cancel_trip", tripEventId });
}

/** The two-step cancel's question, naming the trip — the web's wording. */
export function cancelQuestion(trip: PetTravelTripV1): string {
  return `¿Cancelar el viaje a ${tripLabel(trip)}? Deja de figurar en esta pantalla y en el semáforo.`;
}

/**
 * What the screen says once a command landed.
 *
 * A REPLAY IS A SUCCESS and reads as one — in the past, "ya estaba" — never as
 * a refusal: the key recognised a write that had already happened, which is
 * exactly what a retry after a lost response is for.
 */
export function travelAckMessage(ack: PetTravelCommandAckV1): string {
  switch (ack.command) {
    case "record_trip":
      return ack.replayed ? "Ese viaje ya estaba registrado." : "Viaje registrado.";
    case "record_cvi":
      return ack.replayed ? "Ese CVI ya estaba registrado." : "CVI registrado.";
    case "cancel_trip":
      return ack.changed ? "Viaje cancelado." : "Ese viaje ya estaba cancelado.";
  }
}

// ---------- Date bounds -------------------------------------------------------

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * The days the native calendar offers. BOTH MIRROR A SERVER REFUSAL, which is
 * the `DateField` rule (`minimumDate`/`maximumDate` never invent one): a trip
 * from yesterday to a year ahead, a CVI issued in the last year and not in the
 * future. The typed path is not bounded; the server still judges.
 */
export function travelDateBounds(now: Date): { minimumDate: Date; maximumDate: Date } {
  const today = startOfDay(now);
  return { minimumDate: addDays(today, -1), maximumDate: addDays(today, 365) };
}

export function cviIssuedBounds(now: Date): { minimumDate: Date; maximumDate: Date } {
  const today = startOfDay(now);
  return { minimumDate: addDays(today, -365), maximumDate: today };
}

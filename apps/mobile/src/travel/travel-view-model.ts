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
  PET_TRAVEL_ACTION_LABELS,
  PET_TRAVEL_DECLARED_SEAL,
  PET_TRAVEL_MODALITY_LABELS,
  PET_TRAVEL_MODE_LABELS,
  type PetTravelActionKindV1,
  type PetTravelCommandAckV1,
  type PetTravelComplianceV1,
  type PetTravelCorridorOptionV1,
  type PetTravelCviV1,
  type PetTravelDocumentV1,
  type PetTravelObligationV1,
  type PetTravelPaperV1,
  type PetTravelSemaforoV1,
  type PetTravelSourceV1,
  type PetTravelTripV1,
  petTravelObligationAction,
  petTravelRecordPaperLabel,
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

/**
 * "en cabina", "en bodega", "como carga" — the contract's words, lowercased
 * for the middle of a line, so the header and the wizard's summary say what
 * the form said ("Como carga", never "en carga").
 */
function modalityPhrase(modality: TravelModality): string {
  return PET_TRAVEL_MODALITY_LABELS[modality].toLowerCase();
}

/** "Chile, 12/11/2026 · LATAM, en cabina" — the line under the semáforo. */
export function tripSummary(trip: PetTravelTripV1): string {
  if (trip.airlineName === null) return tripLabel(trip);
  const where = trip.intendedModality ? `, ${modalityPhrase(trip.intendedModality)}` : "";
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

/**
 * "Dom 15/11/2026 · LATAM, en cabina" — the trip header's second line.
 *
 * THE WAY OF TRAVELLING IS SAID EVEN WITHOUT AN AIRLINE (QA 2026-10-07, copy
 * 9): a trip by road read "Chile, 15/10/2026" as if nothing else were known.
 */
export function tripMetaLine(trip: PetTravelTripV1, weekday: string | null): string {
  const date = isoToDateInput(trip.travelDate);
  const when = weekday === null ? date : `${weekday} ${date}`;
  if (trip.airlineName !== null) {
    const where = trip.intendedModality ? `, ${modalityPhrase(trip.intendedModality)}` : "";
    return `${when} · ${trip.airlineName}${where}`;
  }
  if (trip.mode !== null) return `${when} · ${MODE_LABELS[trip.mode]}`;
  return when;
}

/** One paper of the trip, with the obligation that lists it. */
export type TripPaper = { document: PetTravelDocumentV1; obligationId: string };

/**
 * One obligation that lists papers, with its papers. KEPT WHOLE, not only as
 * ticks: its freshness notice, sources and legal note are drawn in "Para
 * llevar" too — an outdated source never reads as settled because the rows
 * under it became checkboxes.
 */
export type PaperGroup = { obligation: PetTravelObligationV1; papers: TripPaper[] };

/** A paper's row key: the same paper may be listed by two obligations. */
export function paperKey(paper: TripPaper): string {
  return `${paper.obligationId}:${paper.document.label}`;
}

/**
 * The trip's reading, split by WHAT IS LEFT TO DO rather than by who asks
 * (Destino, Aerolínea, Libreta was the old split; "Exigido por" keeps the
 * origin inside each requirement's detail).
 *
 *   · `pending` — `blocker` and `warning`: something is still missing;
 *   · `done`    — `info`: nothing left to do;
 *   · `papers`  — every paper the trip asks to carry, from the obligations
 *                 that list them. Those obligations are NOT in the other two:
 *                 a paper is ticked in "Para llevar", not resolved by a vet.
 *
 * ARRANGEMENT ONLY: `requirementLevel` is the server's, and so is the order
 * inside each list (worst first).
 */
export type TripReadingSplit = {
  pending: PetTravelObligationV1[];
  done: PetTravelObligationV1[];
  papers: TripPaper[];
  /** The same papers, grouped under the obligation that lists them. */
  paperGroups: PaperGroup[];
};

export function splitObligations(compliance: PetTravelComplianceV1 | null): TripReadingSplit {
  const split: TripReadingSplit = { pending: [], done: [], papers: [], paperGroups: [] };
  if (compliance === null) return split;
  for (const obligation of compliance.obligations) {
    const documents = obligationDocuments(obligation);
    if (documents.length > 0) {
      const group: PaperGroup = { obligation, papers: [] };
      for (const document of documents) {
        const paper = { document, obligationId: obligation.id };
        split.papers.push(paper);
        group.papers.push(paper);
      }
      split.paperGroups.push(group);
      continue;
    }
    if (obligation.requirementLevel === "info") split.done.push(obligation);
    else split.pending.push(obligation);
  }
  return split;
}

/**
 * "3 cosas por resolver · 2 ya están" under the semáforo. Counting, not
 * judging: the colour above it is the server's.
 */
export function pendingCountLine(split: TripReadingSplit): string | null {
  const pending = split.pending.length;
  const done = split.done.length;
  if (pending === 0 && done === 0) return null;
  if (pending === 0) return done === 1 ? "1 requisito revisado" : `${done} requisitos revisados`;
  const left = pending === 1 ? "1 cosa por resolver" : `${pending} cosas por resolver`;
  if (done === 0) return left;
  return `${left} · ${done === 1 ? "1 ya está" : `${done} ya están`}`;
}

/** "2 de 3" — the papers the owner said they have, over the papers asked. */
export function papersCountLabel(papers: readonly TripPaper[]): string {
  const ticked = papers.filter((p) => p.document.confirmed).length;
  return `${ticked} de ${papers.length}`;
}

export type TripModuleId = "falta" | "llevar" | "listo" | "papeles";

/**
 * THE OPENING RULE (design, 2026-10-07): only the first module with work in
 * it opens by itself. With requirements pending, "Lo que falta"; with none,
 * "Para llevar" while a paper is unticked; with everything done, none — the
 * night before the trip the screen is the checklist, not the detail.
 */
export function initialOpenModule(split: TripReadingSplit): TripModuleId | null {
  if (split.pending.length > 0) return "falta";
  if (split.papers.some((p) => !p.document.confirmed)) return "llevar";
  return null;
}

/** The seal a requirement met only on the owner's word wears. */
export function declaredSeal(obligation: PetTravelObligationV1): string | null {
  return obligation.evidence === "declared" ? PET_TRAVEL_DECLARED_SEAL : null;
}

/** The paper this trip's destination asks for, when the server names it. */
export function tripPaper(
  corridors: readonly PetTravelCorridorOptionV1[],
  corridorId: string,
): PetTravelPaperV1 | null {
  return corridors.find((c) => c.id === corridorId)?.paper ?? null;
}

/**
 * The paper's short name for buttons ("Cargar el CZI"). "CVI" when the server
 * does not name one — what every destination's paper was called before.
 */
export function paperShortName(paper: PetTravelPaperV1 | null): string {
  return paper?.shortName ?? "CVI";
}

/** The button a requirement offers, or null when nothing on the phone resolves it. */
export function obligationActionLabel(
  obligation: PetTravelObligationV1,
  paper: PetTravelPaperV1 | null,
): { kind: PetTravelActionKindV1; label: string } | null {
  const kind = petTravelObligationAction(obligation);
  if (kind === null || kind === "confirm_papers") return null;
  const label =
    kind === "record_paper"
      ? petTravelRecordPaperLabel(paperShortName(paper))
      : PET_TRAVEL_ACTION_LABELS[kind];
  return { kind, label };
}

/**
 * The message suggested beside the trip PDF when it goes to the vet. A
 * suggestion: the share sheet is the owner's, and so is what they send.
 */
export function vetShareMessage(petName: string, trip: PetTravelTripV1): string {
  return `Hola, te mando el PDF del viaje de ${petName} a ${tripLabel(trip)}. Tiene lo que pide el destino y lo que todavía falta registrar en su libreta.`;
}

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

/**
 * "Fuente: SENASA, requisitos para Chile, revisada el 01/09/2026" — who
 * PUBLISHES the rule, not the country it is about (QA 2026-10-07, copy 5).
 * An older server sends no `issuerLabel`, and the line falls back to `label`.
 */
export function sourceLine(source: PetTravelSourceV1): string {
  const who = source.issuerLabel ?? source.label;
  return `Fuente: ${who}, revisada el ${isoToDateInput(source.lastVerifiedAt)}`;
}

/**
 * What a paper's line says under it (PO 2026-10-01) — the web's words. It
 * records what the OWNER said; it never says the paper is valid.
 */
export function documentStatusLine(document: PetTravelDocumentV1): string {
  return document.confirmed ? "Lo tenés, según indicaste" : "Sin confirmar";
}

/** The papers an obligation lists; an older server sends none. */
export function obligationDocuments(obligation: PetTravelObligationV1): PetTravelDocumentV1[] {
  return obligation.documents ?? [];
}

/** "AR-123: emitido el 01/10/2026, válido hasta el 11/10/2026". */
export function cviLine(cvi: PetTravelCviV1): string {
  const until = cvi.validUntil ? `, válido hasta el ${isoToDateInput(cvi.validUntil)}` : "";
  return `${cvi.cviNumber}: emitido el ${isoToDateInput(cvi.issuedDate)}${until}`;
}

/** The empty screen's call, naming the animal. */
export function noTripTitle(petName: string): string {
  return `Planeá un viaje y te mostramos qué le falta a ${petName}`;
}

export const NO_TRIP_LINE =
  "Comparamos su libreta con lo que pide el destino y lo que publica la aerolínea.";

/**
 * NOT the web's "Lo emite SENASA antes del viaje.": naming a state body with no
 * norm citation is what `state-endorsement-fence.test.ts` refuses on a
 * citizen-facing file, and the sentence reads fine without it.
 *
 * NOT "para este viaje" any more (QA 2026-10-07, copy 9): the certificate on
 * record belongs to the animal, not to one trip.
 */
export const NO_CVI_LINE = "Todavía no cargaste un CVI.";

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

/** The contract's words, shared with the web ("En auto o en micro" is `land`). */
export const MODE_LABELS: Record<TravelMode, string> = PET_TRAVEL_MODE_LABELS;

export const MODALITY_LABELS: Record<TravelModality, string> = PET_TRAVEL_MODALITY_LABELS;

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
    case "DOCUMENT_REQUIRED":
      return "No pudimos identificar ese documento. Volvé a abrir la pantalla.";
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

/**
 * "LO TENGO" for one paper of a trip, or the tick taken back — a correction
 * appended through the amendment path, as on the web (PO 2026-10-01).
 */
export function buildConfirmDocument(
  tripEventId: string,
  document: string,
  confirmed: boolean,
): TravelCommandResult {
  return fromParse({ command: "confirm_trip_document", tripEventId, document, confirmed });
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
    case "confirm_trip_document":
      return ack.changed ? "Documento actualizado." : "Ese documento ya estaba así.";
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

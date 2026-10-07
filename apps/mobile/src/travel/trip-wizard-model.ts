// "NUEVO VIAJE" IN FOUR STEPS — the pure half of the trip wizard (viaje
// redesign, PO-approved 2026-10-07).
//
// ONE QUESTION PER SCREEN, AND EACH ANSWER TRIMS THE NEXT ONE: the destination
// decides which ways of travelling are offered (`CORRIDOR_MODES`, shared with
// the web through the contract), the destination puts its own airlines first
// (`options.airlines[].corridors`), and the airline decides whether cabin, hold
// or cargo is asked (`options.airlines[].modalities`). Never more than six
// options on screen.
//
// EVERY TRIMMING FIELD IS OPTIONAL ON THE WIRE. A server older than this app
// sends none of them, and then the wizard shows the full lists the old form
// showed — all twenty airlines, all three modalities — and still writes a
// valid `record_trip`. Nothing here may turn "the server did not say" into "this
// airline does not fly there": the airline order is a SUGGESTION (PO
// 2026-10-07) and "Buscar otra aerolínea" always searches all of them.
//
// NO VERDICT LIVES HERE. The countdown is date arithmetic, the lead hints are
// the server's sentences drawn verbatim, and the semáforo stays the server's.

import {
  CORRIDOR_MODES,
  PET_TRAVEL_REFUSAL_MESSAGES,
  type PetTravelAirlineModalityV1,
} from "@dim/contract/api";
import type { TravelCorridorId } from "@dim/contract/input";

import type { TravelModality, TravelMode, TripDraft } from "./travel-view-model";

// ---------- Steps -------------------------------------------------------------

export type WizardStepId = "destino" | "modo" | "aerolinea" | "fecha";

/** Where the wizard is, plus the answers that are not fields of the draft. */
export type WizardState = {
  step: WizardStepId;
  draft: TripDraft;
  /**
   * Whether "¿Cómo viajan?" was answered. "Todavía no sé" is an answer that
   * leaves `draft.mode` blank, so the blank alone cannot say whether the
   * airline step is still ahead.
   */
  modeAnswered: boolean;
  /** Whether "¿Con qué aerolínea?" was answered — "Todavía no sé" included. */
  airlineAnswered: boolean;
};

export const EMPTY_WIZARD_DRAFT: TripDraft = {
  corridorId: "",
  travelDate: "",
  mode: "",
  airlineId: "",
  intendedModality: "",
};

export function startWizard(corridorId: string | null = null): WizardState {
  const base: WizardState = {
    step: "destino",
    draft: EMPTY_WIZARD_DRAFT,
    modeAnswered: false,
    airlineAnswered: false,
  };
  if (corridorId === null) return base;
  // The empty screen's destination shortcuts open the wizard on its SECOND
  // step: the destination is already answered.
  return chooseCorridor(base, corridorId);
}

/** The ways of travelling a destination allows, in the contract's order. */
export function modesFor(corridorId: string): readonly TravelMode[] {
  if (corridorId === "") return [];
  return (CORRIDOR_MODES as Record<string, readonly TravelMode[] | undefined>)[corridorId] ?? [];
}

/**
 * The steps this trip goes through, given what is answered so far.
 *
 * "¿Cómo viajan?" is skipped when the destination allows ONE way (Spain and
 * the United States: only by air). The airline step is there only for a trip
 * by air — or while that is still unknown, so the count does not shrink under
 * the person before they have answered anything.
 */
export function stepsFor(state: WizardState): WizardStepId[] {
  const { draft } = state;
  const steps: WizardStepId[] = ["destino"];
  const modes = modesFor(draft.corridorId);
  if (draft.corridorId === "" || modes.length !== 1) steps.push("modo");
  const airPossible = draft.corridorId === "" || modes.includes("air");
  if (draft.mode === "air" || (airPossible && !state.modeAnswered)) steps.push("aerolinea");
  steps.push("fecha");
  return steps;
}

/** "Paso 2 de 4" — the number and the total, as `stepsFor` counts them. */
export function stepPosition(state: WizardState): { index: number; total: number } {
  const steps = stepsFor(state);
  const at = steps.indexOf(state.step);
  return { index: at < 0 ? 0 : at, total: steps.length };
}

function nextStep(state: WizardState): WizardState {
  const steps = stepsFor(state);
  const at = steps.indexOf(state.step);
  const next = steps[Math.min(at + 1, steps.length - 1)] ?? "fecha";
  return { ...state, step: next };
}

/**
 * One step back, KEEPING every answer: back is for reviewing, not for undoing.
 * Null on the first step — the wizard itself is what closes then.
 */
export function previousStep(state: WizardState): WizardState | null {
  const steps = stepsFor(state);
  const at = steps.indexOf(state.step);
  if (at <= 0) return null;
  return { ...state, step: steps[at - 1] ?? "destino" };
}

/**
 * Paso 1 answered. A DIFFERENT destination drops what depended on the old one
 * (its mode, its airline); picking the same one again keeps them. A destination
 * with one way of travelling answers "¿Cómo viajan?" by itself.
 */
export function chooseCorridor(state: WizardState, corridorId: string): WizardState {
  const changed = corridorId !== state.draft.corridorId;
  const modes = modesFor(corridorId);
  const only = modes.length === 1 ? (modes[0] ?? null) : null;
  const draft: TripDraft = changed
    ? { ...state.draft, corridorId, mode: only ?? "", airlineId: "", intendedModality: "" }
    : state.draft;
  return nextStep({
    ...state,
    step: "destino",
    draft,
    modeAnswered: changed ? only !== null : state.modeAnswered,
    airlineAnswered: changed ? false : state.airlineAnswered,
  });
}

/** Paso 2 answered; `null` is "Todavía no sé", which skips the airline. */
export function chooseMode(state: WizardState, mode: TravelMode | null): WizardState {
  const draft: TripDraft =
    mode === "air"
      ? { ...state.draft, mode }
      : { ...state.draft, mode: mode ?? "", airlineId: "", intendedModality: "" };
  return nextStep({
    ...state,
    step: "modo",
    draft,
    modeAnswered: true,
    airlineAnswered: mode === "air" ? state.airlineAnswered : false,
  });
}

/**
 * The airline picked (or changed). It does NOT advance: the same screen folds
 * the list into one row and asks where the animal travels.
 */
export function chooseAirline(state: WizardState, airlineId: string): WizardState {
  const changed = airlineId !== state.draft.airlineId;
  return {
    ...state,
    draft: {
      ...state.draft,
      airlineId,
      intendedModality: changed ? "" : state.draft.intendedModality,
    },
    airlineAnswered: false,
  };
}

/** "Cambiar" on the folded airline row: the list comes back. */
export function clearAirline(state: WizardState): WizardState {
  return {
    ...state,
    draft: { ...state.draft, airlineId: "", intendedModality: "" },
    airlineAnswered: false,
  };
}

/** "Todavía no sé" for the airline: nothing chosen, on to the date. */
export function skipAirline(state: WizardState): WizardState {
  return nextStep({
    ...state,
    step: "aerolinea",
    draft: { ...state.draft, airlineId: "", intendedModality: "" },
    airlineAnswered: true,
  });
}

/** Paso 3 answered: where on board (`null` is "Todavía no sé"). */
export function chooseModality(state: WizardState, modality: TravelModality | null): WizardState {
  return nextStep({
    ...state,
    step: "aerolinea",
    draft: { ...state.draft, intendedModality: modality ?? "" },
    airlineAnswered: true,
  });
}

// ---------- Destination search -------------------------------------------------

/** The two-letter code drawn beside each destination. Display only. */
export const CORRIDOR_CODES: Record<TravelCorridorId, string> = {
  chile: "CL",
  uruguay: "UY",
  brasil: "BR",
  ue_espana: "ES",
  usa: "US",
};

/**
 * What a person may type for each destination. Synonyms so "Europa" or "EEUU"
 * find their corridor, and so "Perú" finds NOTHING — which is what lets the
 * wizard say honestly that miMAR does not check that destination.
 */
const CORRIDOR_SYNONYMS: Record<TravelCorridorId, readonly string[]> = {
  chile: ["chile"],
  uruguay: ["uruguay"],
  brasil: ["brasil", "brazil"],
  ue_espana: ["espana", "spain", "ue", "union europea", "europa"],
  usa: ["estados unidos", "eeuu", "ee uu", "usa", "eua", "norteamerica"],
};

/** NFD's combining marks (U+0300–U+036F), so "ñ" folds to "n" and "é" to "e". */
function withoutMarks(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x300 || code > 0x36f) out += char;
  }
  return out;
}

/** Lowercase, accents folded, punctuation as spaces. */
export function normalizeQuery(text: string): string {
  return withoutMarks(text.normalize("NFD"))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * The destinations that match what was typed, in the order the server lists
 * them. An empty query matches all of them.
 */
export function matchCorridors<C extends { id: string; label: string }>(
  corridors: readonly C[],
  query: string,
): C[] {
  const q = normalizeQuery(query);
  if (q === "") return [...corridors];
  return corridors.filter((corridor) => {
    const names = [
      normalizeQuery(corridor.label),
      ...((CORRIDOR_SYNONYMS as Record<string, readonly string[] | undefined>)[corridor.id] ?? []),
    ];
    return names.some((name) => name.startsWith(q) || name.split(" ").some((w) => w.startsWith(q)));
  });
}

// ---------- Airlines -------------------------------------------------------------

/** The most suggested airlines drawn before "Buscar otra aerolínea". */
export const MAX_SUGGESTED_AIRLINES = 4;
/** The most search results drawn at once. */
export const MAX_AIRLINE_RESULTS = 6;

/** The fields of an airline option this wizard reads; all but two optional. */
export type WizardAirline = {
  id: string;
  name: string;
  corridors?: readonly string[] | null;
  modalities?: readonly PetTravelAirlineModalityV1[] | null;
};

export type AirlineChoices =
  /** The server says which airlines fly there: those first, then search. */
  | { kind: "suggested"; airlines: WizardAirline[] }
  /** An older server: no order to suggest, so every airline, as before. */
  | { kind: "all"; airlines: WizardAirline[] };

/**
 * The airlines offered BEFORE searching.
 *
 * With `corridors` on the payload: the destination's own, up to four. Without
 * it (an older server), or when no airline names this destination, every
 * airline — a list nobody filtered is honest; an empty one would not be.
 */
export function airlineChoices(
  airlines: readonly WizardAirline[],
  corridorId: string,
): AirlineChoices {
  const informed = airlines.some((a) => Array.isArray(a.corridors));
  if (!informed) return { kind: "all", airlines: [...airlines] };
  const serving = airlines.filter((a) => a.corridors?.includes(corridorId) ?? false);
  if (serving.length === 0) return { kind: "all", airlines: [...airlines] };
  return { kind: "suggested", airlines: serving.slice(0, MAX_SUGGESTED_AIRLINES) };
}

/** "Buscar otra aerolínea": over ALL of them, never only the suggested ones. */
export function searchAirlines(
  airlines: readonly WizardAirline[],
  query: string,
): { results: WizardAirline[]; more: boolean } {
  const q = normalizeQuery(query);
  const matches =
    q === ""
      ? [...airlines]
      : airlines.filter((a) => {
          const name = normalizeQuery(a.name);
          return name.startsWith(q) || name.split(" ").some((w) => w.startsWith(q));
        });
  return {
    results: matches.slice(0, MAX_AIRLINE_RESULTS),
    more: matches.length > MAX_AIRLINE_RESULTS,
  };
}

const ALL_MODALITIES: readonly TravelModality[] = ["cabin", "hold", "cargo"];

/**
 * Where the animal may travel on this airline. Only what the airline OFFERS
 * when the server says (`modalities`); all three when it does not.
 */
export function modalitiesFor(airline: WizardAirline | undefined): readonly TravelModality[] {
  const offered = airline?.modalities;
  if (!Array.isArray(offered) || offered.length === 0) return ALL_MODALITIES;
  return ALL_MODALITIES.filter((m) => offered.some((o) => o.modality === m));
}

// ---------- Dates ----------------------------------------------------------------

const DAY_MS = 86_400_000;

function utcDay(iso: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (match === null) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** Whole calendar days from `now`'s local day to `iso`; null when unreadable. */
export function daysUntil(iso: string, now: Date): number | null {
  const target = utcDay(iso);
  if (target === null) return null;
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / DAY_MS);
}

/**
 * "faltan 39 días", "sale mañana", "sale hoy", "viajó el 15/11" — arithmetic
 * on the date, never a verdict on the animal.
 */
export function countdownLabel(iso: string, now: Date): string | null {
  const days = daysUntil(iso, now);
  if (days === null) return null;
  if (days > 1) return `faltan ${days} días`;
  if (days === 1) return "sale mañana";
  if (days === 0) return "sale hoy";
  const [, month, day] = iso.split("-");
  return `viajó el ${day}/${month}`;
}

const WEEKDAYS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
const MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

/** "Dom" — the short weekday the trip header prints before the date. */
export function shortWeekday(iso: string): string | null {
  const t = utcDay(iso);
  if (t === null) return null;
  return (WEEKDAYS[new Date(t).getUTCDay()] ?? "").slice(0, 3);
}

/** "Domingo 15 de noviembre · faltan 39 días", under the date field. */
export function travelDateLine(iso: string, now: Date): string | null {
  const t = utcDay(iso);
  if (t === null) return null;
  const date = new Date(t);
  const day = `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} de ${MONTHS[date.getUTCMonth()]}`;
  const countdown = countdownLabel(iso, now);
  return countdown === null ? day : `${day} · ${countdown}`;
}

/**
 * What the airline publishes about one modality, as the line under it: "LATAM
 * publica hasta 7 kg con el bolso". Null when it publishes nothing to say. The
 * airline's words, attributed — never "Pampa entra".
 */
export function modalityCaption(
  airline: WizardAirline | undefined,
  modality: TravelModality,
): string | null {
  if (airline === undefined) return null;
  const published = airline.modalities?.find((m) => m.modality === modality);
  if (published === undefined) return null;
  if (published.maxWeightKg !== null) {
    const carrier = published.includesCarrier
      ? modality === "cabin"
        ? " con el bolso"
        : " con el canil"
      : "";
    return `${airline.name} publica hasta ${published.maxWeightKg} kg${carrier}`;
  }
  if (published.offered === "restricted") return `Con condiciones: confirmalo con ${airline.name}`;
  return null;
}

/**
 * The date step's own check, before any round trip: the window the server
 * enforces (from yesterday to a year ahead), said with the server's sentence
 * for the same refusal. Null when the date is inside it — or not a date yet,
 * which the contract's schema answers with its own sentence.
 */
export function travelDateRangeMessage(
  iso: string | null,
  bounds: { minimumDate: Date; maximumDate: Date },
): string | null {
  if (iso === null) return null;
  const day = utcDay(iso);
  if (day === null) return null;
  const min = Date.UTC(
    bounds.minimumDate.getFullYear(),
    bounds.minimumDate.getMonth(),
    bounds.minimumDate.getDate(),
  );
  const max = Date.UTC(
    bounds.maximumDate.getFullYear(),
    bounds.maximumDate.getMonth(),
    bounds.maximumDate.getDate(),
  );
  if (day < min || day > max) return PET_TRAVEL_REFUSAL_MESSAGES.TRAVEL_DATE_OUT_OF_RANGE;
  return null;
}

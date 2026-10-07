// The pure half of the /viaje screen (v14, "Viaje en pasos", design part 2):
// which module each requirement goes in, which module opens by itself, and the
// words of the trip header. No React here, so every rule is a plain test.
//
// NOTHING HERE DECIDES A VERDICT. The modules split the server's obligations by
// the server's `requirementLevel` (blocker or warning = "Lo que falta", info =
// "Ya está"); the countdown is date arithmetic; the semáforo label is drawn
// verbatim elsewhere.

import type { TravelObligation, TravelTrip } from "@/lib/projections/travel-compliance";
import { MODALITY_LABELS } from "@/lib/projections/travel-libreta-checks";
import { PET_TRAVEL_MODE_LABELS, type PetTravelModeV1 } from "@dim/contract/api";

export type TripModules = {
  /** Blockers and warnings, worst first — the papers obligation included. */
  falta: TravelObligation[];
  /** What is met, papers excluded (they have their own module). */
  yaEsta: TravelObligation[];
  /** The papers-to-carry obligation, when the trip lists papers. */
  papers: TravelObligation | null;
};

/** Splits a reading into the modules the screen draws. */
export function partitionObligations(obligations: readonly TravelObligation[]): TripModules {
  const papers = obligations.find((o) => o.key === "required_documents") ?? null;
  return {
    falta: obligations.filter((o) => o.requirementLevel !== "info"),
    yaEsta: obligations.filter((o) => o.requirementLevel === "info" && o !== papers),
    papers,
  };
}

/** How many papers the owner said they have, of how many the trip lists. */
export function papersTally(papers: TravelObligation | null): { done: number; total: number } {
  const documents = papers?.documents ?? [];
  return { done: documents.filter((d) => d.confirmed).length, total: documents.length };
}

/**
 * The one module that opens by itself (design part 2): "Lo que falta" when
 * something is pending; otherwise "Para llevar" when a paper is unticked;
 * otherwise none — a reading with nothing to do starts folded.
 */
export function moduleToOpen(modules: TripModules): "falta" | "llevar" | null {
  if (modules.falta.length > 0) return "falta";
  const { done, total } = papersTally(modules.papers);
  return done < total ? "llevar" : null;
}

/** The line under the semáforo: "3 cosas por resolver · 2 ya están". */
export function semaforoTally(modules: TripModules): string {
  const pending = modules.falta.length;
  const met = modules.yaEsta.length;
  if (pending === 0) {
    return `${met} ${met === 1 ? "requisito revisado" : "requisitos revisados"}`;
  }
  const what = `${pending} ${pending === 1 ? "cosa" : "cosas"} por resolver`;
  return met === 0 ? what : `${what} · ${met} ya ${met === 1 ? "está" : "están"}`;
}

const DAY_MS = 86_400_000;

function dayOf(iso: string): number {
  return Math.round(Date.parse(`${iso}T12:00:00Z`) / DAY_MS);
}

/** `YYYY-MM-DD` → `dd/mm`. */
function dayMonth(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}

/** Whether the trip's day is already behind `today` (both `YYYY-MM-DD`, AR days). */
export function isPastTrip(travelDate: string, today: string): boolean {
  return dayOf(travelDate) < dayOf(today);
}

/** "faltan 39 días", "sale mañana", "sale hoy", "viajó el 15/11". */
export function countdownLabel(travelDate: string, today: string): string {
  const days = dayOf(travelDate) - dayOf(today);
  if (days < 0) return `viajó el ${dayMonth(travelDate)}`;
  if (days === 0) return "sale hoy";
  if (days === 1) return "sale mañana";
  return `faltan ${days} días`;
}

const WEEKDAY = new Intl.DateTimeFormat("es-AR", { weekday: "long", timeZone: "UTC" });

/** "Domingo 15/11/2026". */
export function travelDayLabel(travelDate: string): string {
  const [y, m, d] = travelDate.split("-");
  const weekday = WEEKDAY.format(new Date(`${travelDate}T12:00:00Z`));
  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)} ${d}/${m}/${y}`;
}

function isMode(value: string | null): value is PetTravelModeV1 {
  return value === "air" || value === "land" || value === "sea";
}

/**
 * The header's second line: the day, then how the animal goes — the airline
 * and where it flies, or the mode when there is no airline (QA copy 9: a trip
 * by land used to read as if nothing was said about it).
 */
export function tripMetaLine(trip: TravelTrip, airlineName: string | null): string {
  const day = travelDayLabel(trip.travelDate);
  if (airlineName) {
    const where = trip.intendedModality ? `, en ${MODALITY_LABELS[trip.intendedModality]}` : "";
    return `${day} · ${airlineName}${where}`;
  }
  return isMode(trip.mode) ? `${day} · ${PET_TRAVEL_MODE_LABELS[trip.mode]}` : day;
}

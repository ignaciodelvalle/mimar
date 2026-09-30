// The words the travel surfaces say about a trip (viajes-fase-2, design D5).
//
// ONE HOME for the semáforo's labels, so the /viaje page, the v1 payload the
// native screen draws, and (Phase 7) the PDF cannot say three different things
// about the same state.
//
// NOTHING HERE PROMISES. miMAR reads the libreta against rules it copied from
// SENASA, the destination and the airline; it cannot say an animal may board.
// The green state therefore says what was checked — "no pending item was
// detected" — and never "apto", "cumple", "en orden" or "listo para viajar".
// Pinned by app/(app)/mis-mascotas/[publicToken]/viaje/TravelSemaforo.test.tsx.

import { PET_TRAVEL_AIRLINE_NOTICE, PET_TRAVEL_GROUP_LABELS } from "@dim/contract/api";

/**
 * The four states of the semáforo. Declared here, not imported from the
 * projection, so lib/domain depends on nothing above it; the projection's
 * `TravelSemaforo` is assignable to it and a test pins the two together.
 */
export type TravelSemaforoState = "rojo" | "amarillo" | "verde" | "sin_datos";

export const TRAVEL_SEMAFORO_LABELS: Record<TravelSemaforoState, string> = {
  // Pending PO sign-off (design open question): the rojo wording.
  rojo: "Hay requisitos que bloquean el viaje",
  amarillo: "Revisar pendientes",
  verde: "Sin pendientes detectados",
  // A foreign destination is on record but no corridor was resolved for it:
  // nothing was checked, so none of the three colours applies.
  sin_datos: "Verificación no disponible",
};

/**
 * What the airline block always says (design D5). Declared in the contract,
 * because the native screen draws it too and cannot import this file.
 */
export const TRAVEL_AIRLINE_NOTICE = PET_TRAVEL_AIRLINE_NOTICE;

/** The three groups of obligations on /viaje, in the order they are listed. */
export const TRAVEL_GROUP_LABELS = PET_TRAVEL_GROUP_LABELS;

/** Strings no travel surface may ever show (spec honesty-and-copy). */
export const TRAVEL_FORBIDDEN_COPY = /\bapto\b|\bcumple\b|en orden|listo para viajar/i;

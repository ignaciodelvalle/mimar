// The shared edge of the three travel writers (viajes-fase-2, design D4):
// who may write, whether the animal can still travel, whether the dates are
// plausible, and the titular's own read of the trips already recorded.
//
// Pure except `loadOverlaidMovements`, which is the ONE read of travel rows the
// writers make — for the duplicate check and the cancel target. It runs only
// after `travelAuthzRefusal` has admitted a travel titular, so no non-titular
// ever reaches it (fenced by __tests__/travel-private-read-coverage.test.ts,
// list TITULAR_OR_WRITER).

import { and, asc, eq, inArray } from "drizzle-orm";

import { db, petEvents } from "@/db";
import { overlayAmendments } from "@/lib/infra/amendment";
import { canAccessTravel } from "@/lib/infra/pet-access";
import { isAirlineId } from "@/lib/reference/airlines";
import { isoDateInAr } from "@/lib/utils/format";
import { isRealArDay } from "@dim/contract/input";

import type { MovementTx } from "../movement/types";
import type { RecordCviInput, RecordTripInput, TravelActor, TravelPet } from "./types";

/** A refusal before any read: the code plus the es-AR sentence the web shows. */
export type EdgeRefusal = {
  code: "forbidden" | "pet_deceased" | "input_invalid";
  error: string;
};

/**
 * The travel window (design D4): a trip may be recorded from yesterday — the
 * owner registering on arrival — up to a year ahead. Further out is a typo far
 * more often than a plan, and a corridor's rules a year from now are not the
 * ones this registry carries.
 */
export const TRIP_DAYS_BEFORE_TODAY = 1;
export const TRIP_DAYS_AFTER_TODAY = 365;

/** A CVI is issued days before a trip; one older than a year is of no use. */
export const CVI_MAX_AGE_DAYS = 365;

/** No CVI is valid for longer than this after issue. */
export const CVI_MAX_VALIDITY_DAYS = 365;

const DAY_MS = 86_400_000;

/** Days since the epoch of a real `YYYY-MM-DD`, or null. */
function dayNumber(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !isRealArDay(value)) return null;
  return Math.round(Date.parse(`${value}T12:00:00Z`) / DAY_MS);
}

/** Today's Argentine calendar day, as a day number. */
function todayNumber(now: Date): number {
  return dayNumber(isoDateInAr(now)) ?? Math.round(now.getTime() / DAY_MS);
}

/**
 * The access rule, once for every door: a travel titular on the person path
 * (canAccessTravel — owner, co-owner, foster), and an animal that is not
 * registered deceased. The not-a-titular sentence does not say what a trip is:
 * a caretaker reaching this learns only that this is the titular's to do.
 */
export function travelAuthzRefusal(pet: TravelPet, actor: TravelActor): EdgeRefusal | null {
  if (!canAccessTravel(actor.accessPath, actor.holderRole)) {
    return {
      code: "forbidden",
      error: "Solo quien es titular de la mascota puede registrar viajes.",
    };
  }
  if (pet.status === "deceased") {
    return {
      code: "pet_deceased",
      error: "Esta mascota está registrada como fallecida y no acepta nuevos registros.",
    };
  }
  return null;
}

/** Plausibility of a trip (design D4). */
export function tripInputRefusal(input: RecordTripInput, now: Date): EdgeRefusal | null {
  const day = dayNumber(input.travelDate);
  if (day === null) {
    return { code: "input_invalid", error: "Ingresá una fecha de viaje válida." };
  }
  const today = todayNumber(now);
  if (day < today - TRIP_DAYS_BEFORE_TODAY || day > today + TRIP_DAYS_AFTER_TODAY) {
    return {
      code: "input_invalid",
      error: "La fecha de viaje tiene que ser desde ayer y hasta dentro de un año.",
    };
  }
  if (input.airlineId !== null) {
    if (!isAirlineId(input.airlineId)) {
      return { code: "input_invalid", error: "Elegí una aerolínea de la lista." };
    }
    if (input.mode !== null && input.mode !== "air") {
      return {
        code: "input_invalid",
        error: "Si elegís una aerolínea, el viaje tiene que ser aéreo.",
      };
    }
  }
  if (input.intendedModality !== null && input.mode !== null && input.mode !== "air") {
    return {
      code: "input_invalid",
      error: "Cabina, bodega o carga solo aplican a un viaje aéreo.",
    };
  }
  return null;
}

/** Plausibility of a CVI (design D4). */
export function cviInputRefusal(input: RecordCviInput, now: Date): EdgeRefusal | null {
  if (input.cviNumber.trim().length === 0) {
    return { code: "input_invalid", error: "Ingresá el número del CVI." };
  }
  const issued = dayNumber(input.issuedDate);
  if (issued === null) {
    return { code: "input_invalid", error: "Ingresá una fecha de emisión válida." };
  }
  const today = todayNumber(now);
  if (issued > today) {
    return { code: "input_invalid", error: "La fecha de emisión no puede ser futura." };
  }
  if (issued < today - CVI_MAX_AGE_DAYS) {
    return {
      code: "input_invalid",
      error: "La fecha de emisión tiene que ser de los últimos doce meses.",
    };
  }
  if (input.validUntil !== null) {
    const until = dayNumber(input.validUntil);
    if (until === null) {
      return { code: "input_invalid", error: "Ingresá una fecha de vencimiento válida." };
    }
    if (until < issued) {
      return {
        code: "input_invalid",
        error: "El vencimiento no puede ser anterior a la emisión.",
      };
    }
    if (until > issued + CVI_MAX_VALIDITY_DAYS) {
      return {
        code: "input_invalid",
        error: "Revisá el vencimiento: no puede superar un año desde la emisión.",
      };
    }
  }
  return null;
}

/** The comparable form of a CVI number: no spaces, upper case. */
export function normalizeCviNumber(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

/**
 * The pet's movement rows with every correction folded in (overlayAmendments),
 * read by a travel titular's writer only. `executor` is the write
 * transaction when the read decides a refusal, so it sees what the per-pet lock
 * serialized.
 */
export async function loadOverlaidMovements(petId: string, executor: typeof db | MovementTx = db) {
  const rows = await executor
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
      and(
        eq(petEvents.petId, petId),
        inArray(petEvents.eventType, ["movement_recorded", "event_amended"]),
      ),
    )
    .orderBy(asc(petEvents.occurredAt));
  return overlayAmendments(rows).filter((e) => e.eventType === "movement_recorded");
}

"use server";

// Thin Server Actions for the owner's trips (viajes-fase-2, design D4).
//
// Each one: requireTitularAccess (the pet exists, the caller holds it, and is
// not a caretaker) → parse the form → call the SAME use-case
// `POST /api/v1/pets/{publicToken}/travel` calls → revalidate /viaje. The
// narrower travel rule (canAccessTravel: owner, co-owner, foster on the person
// path) and the deceased refusal live in the use-case, so the two doors cannot
// disagree about them.
//
// IDEMPOTENCY. Each form mounts with a hidden `idempotencyKey` (a UUID minted
// client-side, renewed after a success), so a double submit of one form is ONE
// event — the replay answers the first write's id.

import { revalidatePath } from "next/cache";

import { requireTitularAccess } from "@/lib/infra/pet-access";
import { CORRIDOR_IDS, type CorridorId } from "@/lib/reference/cross-border-corridors";

import { cancelTrip } from "./application/travel/cancel-trip";
import { recordCvi } from "./application/travel/record-cvi";
import { recordTrip } from "./application/travel/record-trip";
import type { TravelActor, TravelFormState } from "./application/travel/types";

const UUID_RE = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "").trim();
}

function optionalField(formData: FormData, name: string): string | null {
  return field(formData, name) || null;
}

/** The form's idempotency key, or null when absent or not UUID-shaped. */
function idempotencyKeyOf(formData: FormData): string | null {
  const key = field(formData, "idempotencyKey");
  return UUID_RE.test(key) ? key : null;
}

function pick<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function viajePath(publicToken: string): string {
  return `/mis-mascotas/${publicToken}/viaje`;
}

export async function recordTripAction(
  publicToken: string,
  _previous: TravelFormState,
  formData: FormData,
): Promise<TravelFormState> {
  const access = await requireTitularAccess(publicToken);
  if (!access.ok) return { error: access.error };
  const actor: TravelActor = {
    userId: access.user.id,
    accessPath: access.accessPath,
    holderRole: access.holderRole,
    eventAuthorship: access.eventAuthorship,
  };

  const corridorId = pick<CorridorId>(optionalField(formData, "corridorId"), CORRIDOR_IDS);
  if (!corridorId) return { error: "Elegí el destino del viaje." };

  const result = await recordTrip({
    pet: access.pet,
    actor,
    input: {
      corridorId,
      travelDate: field(formData, "travelDate"),
      mode: pick(optionalField(formData, "mode"), ["air", "land", "sea"] as const),
      airlineId: optionalField(formData, "airlineId"),
      intendedModality: pick(optionalField(formData, "intendedModality"), [
        "cabin",
        "hold",
        "cargo",
      ] as const),
    },
    clientIdempotencyKey: idempotencyKeyOf(formData),
  });
  if (!result.ok) return { error: result.error };

  revalidatePath(viajePath(publicToken));
  return { error: null, ok: true };
}

export async function recordCviAction(
  publicToken: string,
  _previous: TravelFormState,
  formData: FormData,
): Promise<TravelFormState> {
  const access = await requireTitularAccess(publicToken);
  if (!access.ok) return { error: access.error };
  const actor: TravelActor = {
    userId: access.user.id,
    accessPath: access.accessPath,
    holderRole: access.holderRole,
    eventAuthorship: access.eventAuthorship,
  };

  const result = await recordCvi({
    pet: access.pet,
    actor,
    input: {
      cviNumber: field(formData, "cviNumber"),
      issuedDate: field(formData, "issuedDate"),
      validUntil: optionalField(formData, "validUntil"),
    },
    clientIdempotencyKey: idempotencyKeyOf(formData),
  });
  if (!result.ok) return { error: result.error };

  revalidatePath(viajePath(publicToken));
  return { error: null, ok: true };
}

export async function cancelTripAction(
  publicToken: string,
  _previous: TravelFormState,
  formData: FormData,
): Promise<TravelFormState> {
  const access = await requireTitularAccess(publicToken);
  if (!access.ok) return { error: access.error };
  const actor: TravelActor = {
    userId: access.user.id,
    accessPath: access.accessPath,
    holderRole: access.holderRole,
    eventAuthorship: access.eventAuthorship,
  };

  const tripEventId = field(formData, "tripEventId");
  if (!UUID_RE.test(tripEventId)) return { error: "No encontramos ese viaje." };

  const result = await cancelTrip({
    pet: access.pet,
    actor,
    tripEventId,
    clientIdempotencyKey: idempotencyKeyOf(formData),
  });
  if (!result.ok) return { error: result.error };

  revalidatePath(viajePath(publicToken));
  return { error: null, ok: true };
}

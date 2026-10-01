"use server";

// Thin Server Actions for the owner's trips (viajes-fase-2, design D4).
//
// Each one: requireTitularAccess (the pet exists, the caller holds it, and is
// not a caretaker) → parse the form → call the SAME use-case
// `POST /api/v1/pets/{publicToken}/travel` calls → return `redirectTo` /viaje.
//
// NO revalidatePath. These forms sit ON /viaje, and revalidating the route the
// form is on hands the client router the Next 15.5 production transition that
// never commits (lib/ui/full-page-action-nav.ts): the write landed, and the
// button said "Registrando…" forever. Found by e2e/viaje.spec.ts; jsdom cannot
// see it. The form navigates as a full document instead (useActionRedirect).
// The
// narrower travel rule (canAccessTravel: owner, co-owner, foster on the person
// path) and the deceased refusal live in the use-case, so the two doors cannot
// disagree about them.
//
// IDEMPOTENCY. Each form mounts with a hidden `idempotencyKey` (a UUID minted
// client-side, renewed after a success), so a double submit of one form is ONE
// event — the replay answers the first write's id.

import { requireTitularAccess } from "@/lib/infra/pet-access";
import { CORRIDOR_IDS, type CorridorId } from "@/lib/reference/cross-border-corridors";

import { cancelTrip } from "./application/travel/cancel-trip";
import { confirmTripDocument } from "./application/travel/confirm-trip-document";
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

  // The page opens on the trip just recorded.
  return {
    error: null,
    ok: true,
    redirectTo: `${viajePath(publicToken)}?viaje=${encodeURIComponent(result.eventId)}`,
  };
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

  return { error: null, ok: true, redirectTo: viajePath(publicToken) };
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

  return { error: null, ok: true, redirectTo: viajePath(publicToken) };
}

/**
 * "Lo tengo" for one paper the trip asks for, or the tick taken back (PO
 * 2026-10-01). The same use-case `POST /api/v1/pets/{publicToken}/travel`
 * `confirm_trip_document` runs.
 *
 * A tick ALWAYS travels with a key: the page mints one per render, and a post
 * without one gets a fresh one here. The amendment's derived fallback key
 * hashes the change, and tick → untick → tick repeats a change — a derived key
 * would answer the third as a replay of the first and leave the paper unticked.
 * A double submit is still one write: the use-case answers `changed: false`
 * when the state already matches.
 */
export async function confirmTripDocumentAction(
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
  const document = field(formData, "document");
  if (!document) return { error: "Ese documento no figura entre los que pide este viaje." };

  const result = await confirmTripDocument({
    pet: access.pet,
    actor,
    tripEventId,
    document,
    confirmed: field(formData, "confirmed") === "true",
    clientIdempotencyKey: idempotencyKeyOf(formData) ?? crypto.randomUUID(),
  });
  if (!result.ok) return { error: result.error };

  return {
    error: null,
    ok: true,
    redirectTo: `${viajePath(publicToken)}?viaje=${encodeURIComponent(tripEventId)}`,
  };
}

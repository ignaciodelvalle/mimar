// Travel writer types (viajes-fase-2, design D4).
//
// Three use-cases — record a trip, record a SENASA CVI, cancel a trip — shared
// by the web's Server Actions (src/modules/pets/travel-actions.ts) and the
// bearer door (`POST /api/v1/pets/{publicToken}/travel`), so the two surfaces
// meet at one module and cannot drift into two notions of who may write a trip
// or what counts as a duplicate (owner-surface parity).

import type { OwnershipRole, Pet } from "@/db";
import type { PetAccessPath, PetEventAuthorship } from "@/lib/infra/pet-access";
import type { CorridorId } from "@/lib/reference/cross-border-corridors";

/**
 * Who is writing, as the door resolved it. The use-case decides
 * `canAccessTravel(accessPath, holderRole)` itself — the doors resolve access
 * three different ways and the rule must be applied once, here.
 */
export type TravelActor = {
  userId: string;
  accessPath: PetAccessPath | null;
  holderRole: OwnershipRole | string | null;
  eventAuthorship: PetEventAuthorship;
};

export type TravelPet = Pick<Pet, "id" | "publicToken" | "name" | "status">;

export type RecordTripInput = {
  corridorId: CorridorId;
  /** `YYYY-MM-DD`, the day the animal leaves. */
  travelDate: string;
  mode: "air" | "land" | "sea" | null;
  /** A registry slug (lib/reference/airlines.ts). Implies `mode = "air"`. */
  airlineId: string | null;
  intendedModality: "cabin" | "hold" | "cargo" | null;
};

export type RecordCviInput = {
  cviNumber: string;
  /** `YYYY-MM-DD`, as printed on the certificate. */
  issuedDate: string;
  /** `YYYY-MM-DD`, the certificate's last valid day, when the owner has it. */
  validUntil: string | null;
};

/**
 * Why a travel write was refused. Each maps to one `/api/v1` code and one es-AR
 * sentence on the web.
 *
 * - `forbidden`        — the caller is not a travel titular (a caretaker, a
 *                        user-held shelter_custody row, the org path).
 * - `pet_deceased`     — the animal is registered deceased.
 * - `input_invalid`    — a date outside the plausible window, an unknown
 *                        airline, an airline on a non-air trip, or a CVI valid
 *                        until a day before it was issued.
 * - `trip_duplicate`   — a trip to the same corridor on the same day is already
 *                        recorded and not cancelled.
 * - `cvi_duplicate`    — a CVI with the same number is already recorded.
 * - `trip_not_found`   — the trip to cancel is not a trip of this animal.
 * - `write_failed`     — the transaction failed.
 */
export type TravelRefusalCode =
  | "forbidden"
  | "pet_deceased"
  | "input_invalid"
  | "trip_duplicate"
  | "cvi_duplicate"
  | "trip_not_found"
  | "write_failed";

export type TravelWriteResult =
  | { ok: true; eventId: string; replayed: boolean }
  | { ok: false; code: TravelRefusalCode; error: string };

export type CancelTripResult =
  | { ok: true; tripEventId: string; changed: boolean }
  | { ok: false; code: TravelRefusalCode; error: string };

/**
 * What the web's travel forms (`useActionState`) receive back. `error` is the
 * es-AR sentence the form renders; `ok` flips on success so the form can reset
 * and mint a fresh idempotency key for the next submission. `redirectTo` is the
 * N3 post-action navigation (lib/ui/use-action-redirect.ts): /viaje reloads as
 * a full document, because revalidating the route the form sits on rides the
 * same Next 15.5 transition that never commits in production.
 */
export type TravelFormState = { error: string | null; ok?: boolean; redirectTo?: string };

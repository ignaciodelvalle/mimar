// The three travel commands behind `POST /api/v1/pets/{publicToken}/travel`
// (viajes-fase-2, design D4).
//
// SAME USE-CASES AS THE WEB. `recordTrip`, `recordCvi` and `cancelTrip` under
// src/modules/pets/application/travel/ are what the web's travel actions call
// too, which is what the owner-surface parity fence joins on.
//
// WHO MAY RUN THEM is decided INSIDE the use-cases (`canAccessTravel`: the
// person path in TRAVEL_TITULAR_ROLES — owner, co-owner, foster). This door
// hands them the resolved holder; it does not restate the rule. What it adds is
// the surface's own split: a caller who may not see the animal at all gets
// `not_found`, like every door here; a caller who holds it and is not a travel
// titular gets `travel_forbidden` (403).
//
// EVERY EVENT IS SIGNED `OWNER_AUTHORSHIP`: only the person path reaches a
// write, so there is no org authorship to carry.

import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import {
  OWNER_AUTHORSHIP,
  type PetHolderAccess,
  resolvePetHolderAccess,
} from "@/lib/infra/pet-access";
import { reportError } from "@/lib/infra/report-error";
import { cancelTrip } from "@/src/modules/pets/application/travel/cancel-trip";
import { recordCvi } from "@/src/modules/pets/application/travel/record-cvi";
import { recordTrip } from "@/src/modules/pets/application/travel/record-trip";
import type { TravelActor, TravelRefusalCode } from "@/src/modules/pets/application/travel/types";
import type { PetTravelCommandAckV1 } from "@dim/contract/api";
import type { PetTravelCommandInput } from "@dim/contract/input";

/**
 * The pre-write read: the access query only. THE WRITES ARE OUTSIDE ANY
 * BUDGET, for the reason every write on this surface records: racing a
 * transaction against a timer produces a 503 for a write that then commits.
 */
const RESOLVE_BUDGET_MS = 8_000;

const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/** The 503 this endpoint answers for every degraded pre-write read. */
export function unavailable() {
  return apiV1Error("temporarily_unavailable", 503, {
    "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
  });
}

export type TravelCommandContext = {
  publicToken: string;
  userId: string;
  idempotencyKey: string;
  input: PetTravelCommandInput;
};

/** Everything from the access guard to the command. */
export async function runPetTravelCommand(ctx: TravelCommandContext) {
  let access: PetHolderAccess;
  try {
    access = await withDbBudgetOrThrow(
      resolvePetHolderAccess(ctx.publicToken, ctx.userId),
      RESOLVE_BUDGET_MS,
      "api-v1-travel-access",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  // A pet this caller may not touch and a pet that does not exist answer
  // IDENTICALLY, as every other endpoint on this surface does.
  if (access.kind === "none") return apiV1Error("not_found", 404);

  const actor: TravelActor =
    access.kind === "owner"
      ? {
          userId: ctx.userId,
          accessPath: "owner",
          holderRole: access.holderRole,
          eventAuthorship: OWNER_AUTHORSHIP,
        }
      : {
          userId: ctx.userId,
          accessPath: "org",
          holderRole: null,
          eventAuthorship: access.eventAuthorship,
        };
  const pet = access.pet;
  const input = ctx.input;

  try {
    switch (input.command) {
      case "record_trip": {
        const result = await recordTrip({
          pet,
          actor,
          input: {
            corridorId: input.corridorId,
            travelDate: input.travelDate,
            mode: input.mode,
            airlineId: input.airlineId,
            intendedModality: input.intendedModality,
          },
          clientIdempotencyKey: ctx.idempotencyKey,
        });
        if (!result.ok) return refusal(result.code, ctx.userId);
        const body: PetTravelCommandAckV1 = {
          command: "record_trip",
          eventId: result.eventId,
          replayed: result.replayed,
        };
        return apiV1Json(body, { status: 200 });
      }
      case "record_cvi": {
        const result = await recordCvi({
          pet,
          actor,
          input: {
            cviNumber: input.cviNumber,
            issuedDate: input.issuedDate,
            validUntil: input.validUntil,
          },
          clientIdempotencyKey: ctx.idempotencyKey,
        });
        if (!result.ok) return refusal(result.code, ctx.userId);
        const body: PetTravelCommandAckV1 = {
          command: "record_cvi",
          eventId: result.eventId,
          replayed: result.replayed,
        };
        return apiV1Json(body, { status: 200 });
      }
      case "cancel_trip": {
        const result = await cancelTrip({
          pet,
          actor,
          tripEventId: input.tripEventId,
          clientIdempotencyKey: ctx.idempotencyKey,
        });
        if (!result.ok) return refusal(result.code, ctx.userId);
        const body: PetTravelCommandAckV1 = {
          command: "cancel_trip",
          tripEventId: result.tripEventId,
          changed: result.changed,
        };
        return apiV1Json(body, { status: 200 });
      }
      default: {
        const unhandled: never = input;
        throw new Error(`Unhandled travel command: ${JSON.stringify(unhandled)}`);
      }
    }
  } catch (err) {
    reportError("api-v1-travel", err, { userId: ctx.userId });
    return apiV1Error("travel_failed", 500);
  }
}

/**
 * A use-case refusal, as a code from the contract's vocabulary. The use-case's
 * es-AR sentence is NOT echoed: this surface answers with a code and nothing
 * else.
 */
function refusal(code: TravelRefusalCode, userId: string) {
  switch (code) {
    case "forbidden":
      return apiV1Error("travel_forbidden", 403);
    case "pet_deceased":
      return apiV1Error("travel_not_allowed", 409);
    case "input_invalid":
      return apiV1Error("travel_input_invalid", 400);
    case "trip_duplicate":
      return apiV1Error("trip_duplicate", 409);
    case "cvi_duplicate":
      return apiV1Error("cvi_duplicate", 409);
    case "trip_not_found":
      return apiV1Error("trip_not_found", 404);
    case "write_failed":
      reportError("api-v1-travel", new Error("travel write failed"), { userId });
      return apiV1Error("travel_failed", 500);
    default: {
      const unhandled: never = code;
      throw new Error(`Unhandled travel refusal: ${JSON.stringify(unhandled)}`);
    }
  }
}

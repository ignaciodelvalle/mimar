// The one command behind `POST /api/v1/pets/{publicToken}/move`.
//
// Split out of `route.ts` the way editar, lost mode and compartir split theirs:
// that file asks "is this request well formed", this one asks "may this command
// run, and what exactly does it do".
//
// WHO MAY RUN IT — SHARED WITH THE WEB, NOT COPIED FROM IT
// ---------------------------------------------------------------------------
// The web's `/mis-mascotas/{token}/mudanza` page and its `recordMoveAction` both
// gate on `requireTitularAccess`, whose page comment states the rule and the
// reason: "a move rewrites the pet's jurisdiction, which is deny-list row
// `jurisdiction-change` — the one with a legal edge, since the province decides
// which authority the animal answers to."
//
// `requireTitularAccess` is a COOKIE-SESSION guard: it opens a Supabase client of
// its own and answers a redirect-shaped refusal, so a bearer door cannot call it.
// What it decomposes into can be, and is: `resolvePetHolderAccess` — the
// authorization RULE, extracted precisely so "a second door can enforce the SAME
// rule BY CONSTRUCTION rather than by resemblance" — followed by
// `isTitularHolder`, which is the predicate `requireTitularAccess` ITSELF calls.
// So this is not a copy of the guard with a citation; it is the guard's own two
// halves, and the two doors cannot drift into disagreeing about who a titular is.
//
// WHAT THAT ADMITS, said plainly because a narrower rule would look safer and be
// wrong: a co-owner passes, a FOSTER passes, and the ORG path passes. That is
// `isTitularHolder`'s deny-list shape ("A DENY and not an allow-list … an
// allow-list silently narrows the roles the web admits the first time somebody
// adds a role to the system"), and the only refusal is a person-path CARETAKER.
//
// AND WHAT IT DOES NOT CHECK: the animal being DECEASED. `recordMoveAction` uses
// `requireTitularAccess` and not `requireAlivePetAccess`, so the web records a
// move for a deceased animal today. This door does the same rather than
// inventing a gate the browser does not have — a phone that refused what the
// browser allows is not parity either.
//
// ART. 16 (Ley 25.326) IS INSIDE THE RESOLVER AND THIS FILE ADDS NO SECOND READ.
// `resolvePetHolderAccess` filters `isNull(pets.deletedAt)` on BOTH of its paths
// (closed 2026-08-28), so an erased animal answers `{ kind: "none" }` here and
// this door 404s it like a token that never existed. That is why nothing in this
// directory spells `unerasedPetByToken` or `publicPetByToken`: there is no second
// lookup of `pets` to spell it in, and the pet row the command writes against is
// the one the guard already read.
//
// NO `Idempotency-Key`, AND THAT IS A CONTRACT RATHER THAN AN OMISSION. Neither
// `recordMovementWriter` nor `recordJurisdictionMove` takes a
// `clientIdempotencyKey`. What they have instead is a REFUSAL: the second
// identical request finds the animal already living at the destination and comes
// back `move_same_locality` (409), so a replay cannot append a second
// `movement_recorded`. That is a stronger promise than absorbing one, and it is
// the same shape `/shares` and `/profile` state — requiring a header the writer
// would ignore is a client believing it holds a guarantee nobody made.

import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import {
  OWNER_AUTHORSHIP,
  type PetHolderAccess,
  isTitularHolder,
  resolvePetHolderAccess,
} from "@/lib/infra/pet-access";
import { reportError } from "@/lib/infra/report-error";
import { recordJurisdictionMove } from "@/src/modules/pets/application/movement/record-jurisdiction-move";
import type { PetMoveRecordedV1 } from "@dim/contract/api";
import type { PetMoveCommandInput } from "@dim/contract/input";

/**
 * The pre-write reads: the access query and the catalog resolution.
 *
 * The WRITE is deliberately outside any budget, for the reason lost mode
 * records: `withDbBudgetOrThrow` races a promise against a timer and rejects,
 * which does not abort a Postgres transaction. Wrapping the write would produce
 * a 503 for a transaction that then COMMITS — the client sees failure, the
 * animal's jurisdiction has moved, and the two disagree forever.
 */
const RESOLVE_BUDGET_MS = 8_000;

const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/** The 503 this endpoint answers for every degraded pre-write read. */
export function unavailable() {
  return apiV1Error("temporarily_unavailable", 503, {
    "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
  });
}

export type MoveCommandContext = {
  publicToken: string;
  userId: string;
  input: PetMoveCommandInput;
};

/** Everything from the access guard to the command. */
export async function runPetMoveCommand(ctx: MoveCommandContext) {
  let access: PetHolderAccess;
  try {
    access = await withDbBudgetOrThrow(
      resolvePetHolderAccess(ctx.publicToken, ctx.userId),
      RESOLVE_BUDGET_MS,
      "api-v1-move-access",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  // A pet this caller may not touch and a pet that does not exist answer
  // IDENTICALLY, as every other endpoint on this surface does.
  if (access.kind === "none") return apiV1Error("not_found", 404);

  // The titular rule, through the predicate the cookie guard itself calls. The
  // arguments are the two the guard passes: `accessPath` and `holderRole`, which
  // is `null` on the org path — and null is why an org member passes, since org
  // access is capability-gated separately and a deny here would be the wrong gate
  // at the wrong layer.
  const holderRole = access.kind === "owner" ? access.holderRole : null;
  if (!isTitularHolder(access.kind === "owner" ? "owner" : "org", holderRole)) {
    // 403 AND NOT 404, and the distinction is `PetAccessFailureReason`'s own:
    // "pretending the pet does not exist to someone who is legitimately caring
    // for it is a lie the UI cannot recover from".
    return apiV1Error("move_forbidden", 403);
  }

  return recordMove(ctx, access);
}

/**
 * MUDANZA — the animal's Argentine jurisdiction, through the shared use-case.
 *
 * The event is signed the way the cookie door signs it: `OWNER_AUTHORSHIP` on the
 * person path — exported precisely so a native write cannot re-declare it and end
 * up signed `authorVerified: true` by accident — and, on the org path, the
 * authorship `resolvePetHolderAccess` computed from the acting member's own
 * validated matrícula.
 */
async function recordMove(
  ctx: MoveCommandContext,
  access: Extract<PetHolderAccess, { kind: "owner" | "org" }>,
) {
  const input = ctx.input;

  let result: Awaited<ReturnType<typeof recordJurisdictionMove>>;
  try {
    result = await recordJurisdictionMove({
      pet: access.pet,
      recordedByUserId: ctx.userId,
      eventAuthorship: access.kind === "owner" ? OWNER_AUTHORSHIP : access.eventAuthorship,
      destination: {
        provinceCode: input.provinceCode,
        localityName: input.localityName,
        // A2-alta-asentar-03 — the row the person tapped, when the client says.
        localityIndecId: input.localityIndecId,
      },
      reason: input.reason,
    });
  } catch (err) {
    // The catalog lookup is a database read and it is the one call in this path
    // that can throw something other than a domain refusal. A pooler outage here
    // is NOT "esa localidad no existe" — answering `move_destination_invalid` to
    // it would send somebody hunting for a spelling mistake in a town that is
    // spelled correctly.
    if (err instanceof DbBudgetExceededError) return unavailable();
    reportError("api-v1-move/record_move", err);
    return apiV1Error("move_failed", 500);
  }

  if (!result.ok) {
    switch (result.code) {
      case "destination_invalid":
        return apiV1Error("move_destination_invalid", 400);
      case "same_locality":
        // 409 AND NOT 400. Nothing about the request is malformed — the person
        // picked a real place, and it happens to be the one the animal already
        // lives in. A 400 would tell a client to fix its payload.
        return apiV1Error("move_same_locality", 409);
      case "write_failed":
        // The use-case's message is the writer's own prose. It is NOT echoed:
        // this surface answers with a code from the contract's vocabulary and
        // nothing else, so a client cannot come to depend on a sentence.
        reportError("api-v1-move/record_move", result.error);
        return apiV1Error("move_failed", 500);
      default: {
        const unhandled: never = result.code;
        throw new Error(`Unhandled move failure: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  const body: PetMoveRecordedV1 = {
    command: "record_move",
    eventId: result.eventId,
    // THE CANONICAL PAIR, not the one that was posted — see `PetMoveRecordedV1`.
    jurisdiction: { province: result.province, locality: result.locality },
  };
  return apiV1Json(body, { status: 200 });
}

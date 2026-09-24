// The three commands behind `POST /api/v1/pets/{publicToken}/rehome`.
//
// CLOSES THREE ENTRIES IN `DECLARED_DIVERGENCES`
// (`scripts/check-owner-surface-parity.ts`):
// `write:requestRehomeSponsorshipAction→requestRehomeSponsorship`,
// `write:withdrawRehomeRequestAction→withdrawRehomeRequest` and
// `write:withdrawRehomeSponsorshipAction→withdrawRehomeSponsorship`. The app
// could already READ the arrangement (`OwnerPetRehomeBannerV1`); it could ask
// for nothing, cancel nothing, end nothing. This reaches the IDENTICAL
// use-cases the web's three actions reach under
// `src/modules/rehome/application/`, which is what the fence joins on.
//
// WHO MAY RUN ANY OF THEM is the web's own door, read verbatim: `requireTitularAccess`
// PLUS the live `owner` row (`src/modules/rehome/actions.ts`, "AUTH-SCOPE
// CONTRACT"). `isLegalOwner` in `./payload.ts` is that rule on the bearer
// surface, checked once here for all three, and the use-cases re-assert the
// owner row themselves (defence in depth, as they do for the cookie door). A
// co-owner is REFUSED, and that is the one place this surface is narrower than
// `isTitularHolder` — spec REQ-14, consent is the legal owner's alone.
//
// THE REFUSALS ARE MAPPED BY NAMED CONSTANT, NEVER BY PARSING A SENTENCE. The
// use-cases' failure arm is es-AR prose (api-invariants §3); every sentence
// they can answer with is exported from `domain/rehome-rules.ts` under a name,
// and `refusal()` below compares against the name. What remains unnamed is
// decided PER COMMAND and said here: for `request_sponsorship` the only
// unnamed refusals left are `validateSponsorCoverage`'s two templated
// sentences (the org does not cover the zone; the pet has no province) and
// both mean "pick a different org", so they land on `rehome_org_invalid`; for
// the two withdraws anything unnamed is a writer fault and lands on
// `rehome_failed` with the sentence reported, not echoed.
//
// THE `Idempotency-Key` IS HONOURED FOR THE TWO WITHDRAWS, and the ledger is
// asked BEFORE the state guard — inside the use-cases, under the pet advisory
// lock. See their headers; this file only threads the key through and reports
// `replayed` in the ack. `request_sponsorship` takes no key and a replay of it
// answers `rehome_already_open`, the "re-read, do not re-send" shape.
//
// NOTIFICATIONS GO THROUGH THE CANONICAL SERVICE, as the cookie door's do
// (`src/modules/rehome/actions.ts` — "This module is NOT in the baseline and
// must never be added to it"), post-commit and best-effort: a dead SMTP must
// never roll back the titular's exit.

import { db } from "@/db";
import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { createNotificationsBulk } from "@/lib/infra/notification-service";
import { type PetHolderAccess, resolvePetHolderAccess } from "@/lib/infra/pet-access";
import { reportError } from "@/lib/infra/report-error";
import { requestRehomeSponsorship } from "@/src/modules/rehome/application/request-rehome-sponsorship";
import type { NewNotification } from "@/src/modules/rehome/application/types";
import { withdrawRehomeRequest } from "@/src/modules/rehome/application/withdraw-rehome-request";
import { withdrawRehomeSponsorship } from "@/src/modules/rehome/application/withdraw-rehome-sponsorship";
import {
  NOT_A_REQUEST_ERROR,
  NOT_TITULAR_ERROR,
  NO_ACTIVE_SPONSORSHIP_ERROR,
  NO_PENDING_REQUEST_ERROR,
  OPEN_REQUEST_PENDING_ERROR,
  OPEN_SPONSORSHIP_RUNNING_ERROR,
  ORG_NOT_ELIGIBLE_ERROR,
  ORG_NOT_FOUND_ERROR,
  ORG_NOT_VERIFIED_ERROR,
  PET_DECEASED_ERROR,
  PET_LOST_ERROR,
  REQUEST_ALREADY_ANSWERED_ERROR,
  REQUEST_NOT_SENDER_ERROR,
} from "@/src/modules/rehome/domain/rehome-rules";
import { RehomeRepository } from "@/src/modules/rehome/infrastructure/rehome-repository";
import type { ApiV1ErrorCode, RehomeCommandAckV1 } from "@dim/contract/api";
import type { RehomeCommandInput } from "@dim/contract/input";

import { isLegalOwner } from "./payload";

/**
 * The pre-write reads: the access query and the org lookup.
 *
 * THE WRITES ARE DELIBERATELY OUTSIDE ANY BUDGET, for the reason every write on
 * this surface records: `withDbBudgetOrThrow` races a promise against a timer
 * and rejects, which does not abort a Postgres transaction. Wrapping a write
 * would produce a 503 for a mutation that then COMMITS — and here that mutation
 * ends an org's custody of an animal.
 */
const RESOLVE_BUDGET_MS = 8_000;

const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/** The 503 this endpoint answers for every degraded pre-write read. */
export function unavailable() {
  return apiV1Error("temporarily_unavailable", 503, {
    "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
  });
}

/** The sentence the use-cases answer when the pet vanished between the guard and the write. */
const PET_NOT_FOUND_ERROR = "Mascota no encontrada.";

export type RehomeCommandContext = {
  publicToken: string;
  userId: string;
  input: RehomeCommandInput;
  /** Present for the two withdraws (the route requires it there); null for the ask. */
  idempotencyKey: string | null;
};

function deps() {
  return {
    repo: RehomeRepository,
    now: () => new Date(),
    transaction: db.transaction.bind(db) as <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>,
  };
}

/** Everything from the access guard to the command. */
export async function runRehomeCommand(ctx: RehomeCommandContext) {
  let access: PetHolderAccess;
  try {
    access = await withDbBudgetOrThrow(
      resolvePetHolderAccess(ctx.publicToken, ctx.userId),
      RESOLVE_BUDGET_MS,
      "api-v1-rehome-access",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  // A pet this caller may not touch and a pet that does not exist answer
  // IDENTICALLY, as every other endpoint on this surface does.
  if (access.kind === "none") return apiV1Error("not_found", 404);

  // 403 AND NOT 404 for a holder who is not the legal owner: they hold the
  // animal, and "pretending the pet does not exist to someone who is
  // legitimately caring for it is a lie the UI cannot recover from"
  // (`PetAccessFailureReason`'s own words for `not-titular`).
  if (!isLegalOwner(access)) return apiV1Error("rehome_forbidden", 403);

  try {
    switch (ctx.input.command) {
      case "request_sponsorship":
        return await requestSponsorship(ctx, ctx.input.orgPublicToken);
      case "withdraw_request":
        return await withdrawRequest(ctx);
      case "withdraw_sponsorship":
        return await withdrawSponsorship(ctx);
      default: {
        const unhandled: never = ctx.input;
        throw new Error(`Unhandled rehome command: ${JSON.stringify(unhandled)}`);
      }
    }
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    reportError("api-v1-rehome", err, { userId: ctx.userId });
    return apiV1Error("rehome_failed", 500);
  }
}

async function requestSponsorship(ctx: RehomeCommandContext, orgPublicToken: string) {
  // The token → id resolution the web form never needs (it posts ids). An
  // unknown token is the same refusal as an ineligible org: pick from the list.
  const org = await withDbBudgetOrThrow(
    RehomeRepository.findOrgByPublicToken(orgPublicToken),
    RESOLVE_BUDGET_MS,
    "api-v1-rehome-org",
  );
  if (!org) return apiV1Error("rehome_org_invalid", 400);

  const result = await requestRehomeSponsorship(
    { petPublicToken: ctx.publicToken, titularUserId: ctx.userId, targetOrgId: org.id },
    deps(),
  );
  if (!result.ok) return refusal("request_sponsorship", result.error, ctx.userId);

  await flushNotifications(result.notifications);
  return ack({
    command: "request_sponsorship",
    requestCasePublicCode: result.value.casePublicCode,
    orgDisplayName: result.value.orgDisplayName,
  });
}

async function withdrawRequest(ctx: RehomeCommandContext) {
  const result = await withdrawRehomeRequest(
    {
      petPublicToken: ctx.publicToken,
      titularUserId: ctx.userId,
      clientIdempotencyKey: ctx.idempotencyKey,
    },
    deps(),
  );
  if (!result.ok) return refusal("withdraw_request", result.error, ctx.userId);

  await flushNotifications(result.notifications);
  return ack({
    command: "withdraw_request",
    requestCasePublicCode: result.value.casePublicCode,
    replayed: result.value.replayed,
  });
}

async function withdrawSponsorship(ctx: RehomeCommandContext) {
  const result = await withdrawRehomeSponsorship(
    {
      petPublicToken: ctx.publicToken,
      titularUserId: ctx.userId,
      clientIdempotencyKey: ctx.idempotencyKey,
    },
    deps(),
  );
  if (!result.ok) return refusal("withdraw_sponsorship", result.error, ctx.userId);

  await flushNotifications(result.notifications);
  return ack({
    command: "withdraw_sponsorship",
    listingCasePublicCode: result.value.listingCasePublicCode,
    orgPublicToken: result.value.sponsoringOrganizationPublicToken,
    replayed: result.value.replayed,
  });
}

/**
 * The use-cases' sentences, mapped to codes BY NAME — see the header for the
 * per-command rule that decides what the unnamed remainder means.
 */
const NAMED_REFUSALS: ReadonlyArray<[string, ApiV1ErrorCode, number]> = [
  [PET_NOT_FOUND_ERROR, "not_found", 404],
  [NOT_TITULAR_ERROR, "rehome_forbidden", 403],
  [REQUEST_NOT_SENDER_ERROR, "rehome_forbidden", 403],
  [PET_LOST_ERROR, "rehome_not_allowed", 409],
  [PET_DECEASED_ERROR, "rehome_not_allowed", 409],
  [OPEN_REQUEST_PENDING_ERROR, "rehome_already_open", 409],
  [OPEN_SPONSORSHIP_RUNNING_ERROR, "rehome_already_open", 409],
  [ORG_NOT_FOUND_ERROR, "rehome_org_invalid", 400],
  [ORG_NOT_ELIGIBLE_ERROR, "rehome_org_invalid", 400],
  [ORG_NOT_VERIFIED_ERROR, "rehome_org_invalid", 400],
  [NO_PENDING_REQUEST_ERROR, "rehome_nothing_to_withdraw", 409],
  [NO_ACTIVE_SPONSORSHIP_ERROR, "rehome_nothing_to_withdraw", 409],
  [REQUEST_ALREADY_ANSWERED_ERROR, "rehome_nothing_to_withdraw", 409],
  [NOT_A_REQUEST_ERROR, "rehome_nothing_to_withdraw", 409],
];

function refusal(command: RehomeCommandInput["command"], error: string, userId: string) {
  for (const [sentence, code, status] of NAMED_REFUSALS) {
    if (error === sentence) return apiV1Error(code, status);
  }
  if (command === "request_sponsorship") {
    // The unnamed remainder of `requestRehomeSponsorship` is the coverage
    // rule's two templated sentences — both "pick a different org".
    return apiV1Error("rehome_org_invalid", 400);
  }
  // The use-case's message is its own prose. NOT echoed — this surface answers
  // with a code and nothing else, the same rule every sibling applies.
  reportError(`api-v1-rehome/${command}`, new Error(error), { userId });
  return apiV1Error("rehome_failed", 500);
}

/**
 * Flush post-tx, best-effort, through the canonical write path — idempotent on
 * `dedupeKey`, dead-lettered on failure. Never throws: the primary write
 * already committed and must not be undone by a notice that did not send.
 */
async function flushNotifications(pending: NewNotification[]): Promise<void> {
  if (pending.length === 0) return;
  try {
    await createNotificationsBulk(pending);
  } catch (err) {
    reportError("api-v1-rehome/notifications", err);
  }
}

function ack(body: RehomeCommandAckV1) {
  return apiV1Json(body, { status: 200 });
}

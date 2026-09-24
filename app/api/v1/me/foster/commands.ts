// The two tránsito commands a volunteer can send, and the refusal table that
// translates the use-cases' es-AR prose into the wire vocabulary.
//
// NO PET GUARD, AND ITS ABSENCE IS THE DESIGN — mirroring `caretaker-grants/commands.ts`'s
// note for its own `accept`/`reject`: the volunteer holds no `ownerships` row
// on this animal until they accept, so there is nothing for a pet guard to
// resolve. The addressee match (`proposal.volunteerUserId === userId`) runs
// INSIDE the use-cases, exactly as it does for the web.
//
// TRANSLATING PROSE INTO CODES, WITHOUT COPYING THE PROSE WHERE IT CAN BE READ
// ---------------------------------------------------------------------------
// `UseCaseResult`'s failure arm is an untyped `string` written for a web form
// (api-invariants.md §3). `Motivo de rechazo inválido.` is asked FROM
// `validateRejectionReason` at module load, so a reword moves with no edit
// here. The other five sentences live inside `accept-foster-proposal.ts` /
// `reject-foster-proposal.ts` use-case BODIES with nothing exported to import,
// so the table matches literals — pinned by
// `__tests__/api-v1-me-foster-route.test.ts`, which every one of the two
// use-cases can return. A reworded sentence falls through to `foster_failed`
// (500), which is loud rather than silently wrong: it never widens access.

import { db } from "@/db";
import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import { createNotificationsBulk } from "@/lib/infra/notification-service";
import { acceptFosterProposal } from "@/src/modules/foster/application/accept-foster-proposal";
import { listFosterHubForVolunteer } from "@/src/modules/foster/application/list-foster-hub-for-volunteer";
import { rejectFosterProposal } from "@/src/modules/foster/application/reject-foster-proposal";
import type { NewNotification } from "@/src/modules/foster/application/types";
import { validateRejectionReason } from "@/src/modules/foster/domain/proposal-rules";
import { FosterRepository } from "@/src/modules/foster/infrastructure/foster-repository";
import type { ApiV1ErrorCode, FosterCommandAckV1 } from "@dim/contract/api";
import type { FosterCommandInput } from "@dim/contract/input";

const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/** The 503 this endpoint answers for every degraded read. */
export function unavailable() {
  return apiV1Error("temporarily_unavailable", 503, {
    "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
  });
}

export type FosterCommandContext = {
  userId: string;
  input: FosterCommandInput;
};

function ack(body: FosterCommandAckV1) {
  return apiV1Json(body, { status: 200 });
}

// ---------------------------------------------------------------------------
// The refusal table
// ---------------------------------------------------------------------------

type Rule = { code: ApiV1ErrorCode; status: number; matches: (error: string) => boolean };

function exact(sentence: string): (error: string) => boolean {
  return (error) => error === sentence;
}

/** Asks `validateRejectionReason` for its own sentence, so the table cannot drift from it. */
function invalidReasonRefusal(): string {
  const result = validateRejectionReason("__not_a_real_reason__");
  if (result.ok) {
    // A validator that stopped refusing an unknown reason means the rule
    // moved. Failing loudly at module load beats a table entry that silently
    // matches nothing.
    throw new Error(
      "foster/commands: validateRejectionReason no longer refuses an unknown reason; the refusal table is stale.",
    );
  }
  return result.error;
}

const RULES: readonly Rule[] = [
  // ---- nothing to act on (404) --------------------------------------------
  { code: "not_found", status: 404, matches: exact("Propuesta no encontrada.") },

  // ---- the CALLER is not this proposal's addressee (403) ------------------
  { code: "foster_forbidden", status: 403, matches: exact("Esta propuesta no es para vos.") },

  // ---- the proposal is no longer answerable (409) --------------------------
  //
  // FOUR SENTENCES, ONE CODE: the proposal itself resolved (accepted,
  // rejected, cancelled, expired), the org lost custody in the meantime, or
  // the pet's co-foster state changed underneath it. The client's move is
  // identical in all four — re-read the hub.
  {
    code: "foster_already_resolved",
    status: 409,
    matches: exact("Esta propuesta ya no está activa."),
  },
  {
    code: "foster_already_resolved",
    status: 409,
    matches: exact("La organización ya no tiene custodia de esta mascota."),
  },
  {
    code: "foster_already_resolved",
    status: 409,
    matches: exact(
      "El estado del pet cambió: ahora tiene un tránsito activo que no admite co-foster.",
    ),
  },

  // ---- the CALLER'S OWN volunteer standing refuses the accept (409) -------
  //
  // THREE SENTENCES, ONE CODE: not enrolled, paused, or no slots left. One
  // move — fix the standing at "Ofrecerme como tránsito" — for all three.
  { code: "foster_not_eligible", status: 409, matches: exact("No estás inscripto en el pool.") },
  { code: "foster_not_eligible", status: 409, matches: exact("Tu inscripción no está activa.") },
  { code: "foster_not_eligible", status: 409, matches: exact("Ya no tenés slots disponibles.") },

  // ---- the reject reason was not one of the six (400) ----------------------
  //
  // Reachable only from a client out of step with the contract: the schema
  // requires a value from `FOSTER_REJECTION_REASONS` before the round trip.
  { code: "invalid_request", status: 400, matches: exact(invalidReasonRefusal()) },
];

/**
 * One use-case refusal, as a response.
 *
 * The fall-through is `foster_failed` / 500 — the honest answer for a
 * sentence this file does not recognise: it means the mapping is out of step
 * with a use-case, which IS a server defect. It is also the safe direction —
 * an unmapped refusal is still a refusal.
 */
export function fosterRefusal(error: string) {
  for (const rule of RULES) {
    if (rule.matches(error)) return apiV1Error(rule.code, rule.status);
  }
  return apiV1Error("foster_failed", 500);
}

/** Exported for the route test, which pins every literal the two use-cases return. */
export const FOSTER_REFUSAL_RULES = RULES;

// ---------------------------------------------------------------------------
// Side effects, post-tx, best-effort
// ---------------------------------------------------------------------------

/**
 * Notifications through the CANONICAL WRITE PATH
 * (`lib/infra/notification-service.ts`), never a raw write to the table —
 * `scripts/check-notifications-service.ts` bans one in new code, and this
 * file is new. It is a DEPARTURE from
 * `src/modules/foster/actions.ts`'s own `flushNotifications`, which still
 * writes directly and is grandfathered
 * (`scripts/notifications-service-baseline.json`) rather than migrated — the
 * baseline is debt to shrink, not a precedent to extend onto a file that did
 * not exist yet.
 *
 * `NewNotification` (the use-cases' own shape) CARRIES NO `dedupeKey`, unlike
 * `CreateNotificationInput`, which requires one. The web's raw insert needs
 * none because a `<button disabled>` after one click is its whole replay
 * defence; this door has no such guard, and neither command carries an
 * `Idempotency-Key` (see `foster.ts`'s header) — a retried POST is exactly
 * the case a dedupe key exists for. Synthesised here, at the one call site
 * that knows the two facts a notification's own shape does not carry — which
 * COMMAND produced it and for which PROPOSAL — from fields already stable
 * across a retry: the proposal token, the notification's own type and
 * addressee, and (for the D18 cascade, several rows sharing one type and one
 * addressee) the animal each row is about.
 */
async function flushNotifications(
  command: "accept" | "reject",
  proposalToken: string,
  pending: NewNotification[],
): Promise<void> {
  if (pending.length === 0) return;
  try {
    await createNotificationsBulk(
      pending.map((n) => ({
        ...n,
        dedupeKey: [
          "foster",
          command,
          proposalToken,
          n.userId,
          n.notificationType,
          n.relatedPetId ?? "none",
        ].join(":"),
      })),
    );
  } catch (e) {
    console.error("[api-v1-me-foster] notifications insert failed (it did succeed):", e);
  }
}

function deps() {
  return {
    repo: FosterRepository,
    transaction: db.transaction.bind(db) as <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>,
  };
}

// ---------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------

export async function runFosterCommand(ctx: FosterCommandContext) {
  switch (ctx.input.command) {
    case "accept":
      return await accept(ctx, ctx.input);
    case "reject":
      return await reject(ctx, ctx.input);
  }
}

async function accept(
  ctx: FosterCommandContext,
  input: Extract<FosterCommandInput, { command: "accept" }>,
) {
  const result = await acceptFosterProposal(
    {
      proposalPublicToken: input.proposalToken,
      allowCoFoster: input.allowCoFoster,
      responseNotes: input.responseNotes,
    },
    { ...deps(), actor: { user: { id: ctx.userId } } },
  );
  if (!result.ok) return fosterRefusal(result.error);

  await flushNotifications("accept", input.proposalToken, result.notifications);

  return ack({
    command: "accept",
    changed: true,
    proposalToken: input.proposalToken,
    fosterOwnershipId: result.value.fosterOwnershipId,
  });
}

async function reject(
  ctx: FosterCommandContext,
  input: Extract<FosterCommandInput, { command: "reject" }>,
) {
  const result = await rejectFosterProposal(
    {
      proposalPublicToken: input.proposalToken,
      rejectionReason: input.rejectionReason,
      responseNotes: input.responseNotes,
    },
    { ...deps(), actor: { user: { id: ctx.userId } } },
  );
  if (!result.ok) return fosterRefusal(result.error);

  await flushNotifications("reject", input.proposalToken, result.notifications);

  return ack({
    command: "reject",
    changed: true,
    proposalToken: input.proposalToken,
    fosterOwnershipId: null,
  });
}

// ---------------------------------------------------------------------------
// The hub read, budgeted by the caller (see route.ts).
// ---------------------------------------------------------------------------

/**
 * STATICALLY IMPORTED, deliberately — a per-call `await import()` of a module
 * the suite mocks silently drops one of two concurrent callers in vitest, a
 * defect this repo has already paid for once (`me/caretaker-grants/commands.ts`
 * carries the same note).
 */
export async function readFosterHub(args: { userId: string }) {
  return listFosterHubForVolunteer(args, { repo: FosterRepository });
}

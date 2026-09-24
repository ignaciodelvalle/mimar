// The five cuidador-temporal commands, and the two different authorization
// shapes that live in one file because the FEATURE has two.
//
// FIVE, NOT SEVEN — the scope of this surface, stated where a reader will look
// for it. `withdraw` (the caretaker stepping down) has a server action with no
// caller anywhere in `app/**`, and `return` has no action at all. Neither is
// reachable from a browser, so neither is here: a native-only way to end
// somebody else's arrangement is not parity. See `@dim/contract/input`'s
// `caretaker.ts` for the full note.
//
// TWO GUARDS, AND COLLAPSING THEM WOULD BREAK ONE OF THEM
// ---------------------------------------------------------------------------
//   · `designate` / `cancel` / `revoke` are TITULAR commands. The web guards all
//     three with `requireTitularAccess(petPublicToken)`
//     (`src/modules/caretakers/actions.ts:126,282,319`), which is
//     `requirePetAccess` plus ONE deny: a person-path holder whose ownership role
//     is `caretaker`. Mirrored here as exactly that deny over
//     `resolvePetHolderAccess`, copied from `lost/commands.ts` which faced the
//     same problem first. It is a DENY and not an allow-list, and the difference
//     is load-bearing: a CO-OWNER passes, a FOSTER passes, and the ORG path
//     passes, all three on the web, and an allow-list here would quietly narrow
//     them.
//   · `accept` / `reject` are INVITEE commands, and there is nothing pet-shaped
//     to guard: the caller holds NO ownership row on the animal — that is what an
//     invitation is. Their rule is an id-or-email match against the grant ROW,
//     inside the use-case, under the lock where a lock applies. A pet guard here
//     would refuse the one caller each command exists for and admit every
//     co-owner it is not for. Same shape, same reason, as `me/transfers`.
//
// `callerEmail` COMES FROM THE VERIFIED SESSION AND NEVER FROM THE BODY. It is
// what matches an invitation addressed to somebody who had no account when it
// was written, so a body that could name it would be a way to claim any open
// invitation whose address you could guess. The route reads it from
// `requireLiveUser`.
//
// THE PET TOKEN ON `cancel` AND `revoke` IS THE GUARD'S INPUT, NOT A CROSS-CHECK.
// Nothing here verifies that the named grant belongs to the named pet, and the
// web does not either. What makes a mismatched pair harmless is that the WRITERS
// check the thing that matters: `cancelCaretakerGrant` refuses unless
// `grantedByUserId === caller`, and `endCaretakerGrant` refuses `revoke` unless
// `actorUserId === grant.grantedByUserId`. A caller who names pet A and a grant
// they made on pet B ends up doing exactly what they could have done by naming
// pet B — and the audit row carries the use-case's OWN `petId`, so the log does
// not inherit the mismatch.
//
// TRANSLATING PROSE INTO CODES, WITHOUT COPYING THE PROSE WHERE IT CAN BE READ
// ---------------------------------------------------------------------------
// `UseCaseResult`'s failure arm is an untyped `string` carrying es-AR prose
// written for a web form (api-invariants.md §3). The table below does two
// different things, and the split is the point:
//
//   · Where the sentence lives in an EXPORTED DOMAIN FUNCTION, the table ASKS
//     that function for it at module load (`validateDesignation`, for all five of
//     its refusals). Reword the domain and the table moves with it, with no edit
//     here — parity by construction rather than by copy.
//   · Where the sentence lives inside a use-case BODY there is nothing to
//     import, so the table matches a literal and
//     `__tests__/api-v1-me-caretaker-grants-route.test.ts` pins every one the
//     five use-cases can return. The failure mode is stated rather than hidden: a
//     reworded sentence falls through to `caretaker_failed`, a 500 for something
//     that is not a server failure. It never widens access — an unmapped refusal
//     is still a refusal — and the test is what makes it loud.

import { auditLog, db } from "@/db";
import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { createNotificationsBulk } from "@/lib/infra/notification-service";
import { type PetHolderAccess, resolvePetHolderAccess } from "@/lib/infra/pet-access";
import { parseArDateEndOfDay, parseArDateStartOfDay } from "@/lib/utils/date-input-ar";
import { acceptCaretakerGrant } from "@/src/modules/caretakers/application/accept-caretaker-grant";
import { cancelCaretakerGrant } from "@/src/modules/caretakers/application/cancel-caretaker-grant";
import { designateCaretaker } from "@/src/modules/caretakers/application/designate-caretaker";
import { endCaretakerGrant } from "@/src/modules/caretakers/application/end-caretaker-grant";
import { listCaretakerGrantsForUser } from "@/src/modules/caretakers/application/list-caretaker-grants-for-user";
import { rejectCaretakerGrant } from "@/src/modules/caretakers/application/reject-caretaker-grant";
import type { NewNotification } from "@/src/modules/caretakers/application/types";
import { UNCONFIRMED_EMAIL_CARETAKER_ERROR } from "@/src/modules/caretakers/domain/grant-copy";
import { validateDesignation } from "@/src/modules/caretakers/domain/grant-rules";
import { MAX_GRANT_DURATION_DAYS } from "@/src/modules/caretakers/domain/types";
import { CaretakersRepository } from "@/src/modules/caretakers/infrastructure/caretakers-repository";
import type { ApiV1ErrorCode, CaretakerCommandAckV1 } from "@dim/contract/api";
import type { CaretakerCommandInput } from "@dim/contract/input";

const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/**
 * The two reads this file makes before a write: the hub list, and the pet-access
 * resolution the three titular commands run.
 *
 * THE WRITES ARE DELIBERATELY OUTSIDE ANY BUDGET, for the reason the events
 * endpoint records and `shares/commands.ts` repeats: `withDbBudgetOrThrow` races
 * a promise against a timer and rejects, which does not abort a Postgres
 * transaction. Wrapping a write would produce a 503 for a mutation that then
 * COMMITS — and on this surface that mutation grants or removes another person's
 * write access to an animal, so the client and the registry would disagree about
 * who is responsible for it.
 *
 * The reads each use-case does BEFORE its write — `findGrantByToken`,
 * `findOpenGrantsForPet` — are NOT covered, and that is a gap rather than a
 * decision: they happen inside a use-case call shared with the web, and there is
 * no seam in this file to bound them at. Said out loud because a constant named
 * for reads invites the opposite assumption.
 */
const READ_BUDGET_MS = 8_000;

/** The 503 this endpoint answers for every degraded read. */
export function unavailable() {
  return apiV1Error("temporarily_unavailable", 503, {
    "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
  });
}

export type CaretakerCommandContext = {
  userId: string;
  /** From the VERIFIED session. Never from the body — see the header. */
  callerEmail: string;
  /**
   * GoTrue's `email_confirmed_at` for the same session (A09-1). Verified says
   * the TOKEN is genuine; this says somebody proved the ADDRESS.
   */
  callerEmailConfirmed: boolean;
  input: CaretakerCommandInput;
};

function ack(body: CaretakerCommandAckV1) {
  return apiV1Json(body, { status: 200 });
}

// ---------------------------------------------------------------------------
// The refusal table
// ---------------------------------------------------------------------------

type Rule = { code: ApiV1ErrorCode; status: number; matches: (error: string) => boolean };

/** An exact sentence, taken from the domain function that owns it. */
function exact(sentence: string): (error: string) => boolean {
  return (error) => error === sentence;
}

/**
 * A sentence whose PREFIX is a pet's name, matched on its stable tail.
 *
 * `designateCaretaker` interpolates the animal at the FRONT ("Pampa ya tiene un
 * cuidador/a temporal activo."), so neither an exact match nor a prefix match
 * can reach it. The tail is the invariant half.
 */
function endsWith(tail: string): (error: string) => boolean {
  return (error) => error.endsWith(tail);
}

/**
 * Asks a domain validator for the sentence it returns, so the table cannot drift
 * from the rule it is translating.
 */
function domainRefusal(result: { ok: true } | { ok: false; error: string }): string {
  if (result.ok) {
    // A validator that stopped refusing the input we hand it here means the rule
    // moved. Failing loudly at module load beats a table entry that silently
    // matches nothing and degrades every one of its refusals to a 500.
    throw new Error(
      "caretaker-grants/commands: a domain validator no longer refuses its own negative case; the refusal table is stale.",
    );
  }
  return result.error;
}

const NOW_FOR_TABLE = new Date("2026-01-01T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function designationRefusal(over: {
  titularUserId?: string;
  inviteeUserId?: string | null;
  inviteeEmail?: string | null;
  startsAt?: Date;
  endsAt?: Date;
}): string {
  return domainRefusal(
    validateDesignation({
      titularUserId: "titular",
      inviteeUserId: "invitee",
      inviteeEmail: "invitee@example.com",
      startsAt: NOW_FOR_TABLE,
      endsAt: new Date(NOW_FOR_TABLE.getTime() + DAY_MS),
      now: NOW_FOR_TABLE,
      maxDurationDays: MAX_GRANT_DURATION_DAYS,
      ...over,
    }),
  );
}

const SELF_DESIGNATION = designationRefusal({ inviteeUserId: "titular" });
const MISSING_INVITEE = designationRefusal({ inviteeUserId: null, inviteeEmail: "" });
const INVALID_PERIOD = designationRefusal({ endsAt: NOW_FOR_TABLE });
const OVER_MAX_DURATION = designationRefusal({
  endsAt: new Date(NOW_FOR_TABLE.getTime() + (MAX_GRANT_DURATION_DAYS + 1) * DAY_MS),
});
const END_IN_PAST = designationRefusal({
  startsAt: new Date(NOW_FOR_TABLE.getTime() - 10 * DAY_MS),
  endsAt: new Date(NOW_FOR_TABLE.getTime() - DAY_MS),
});

/** The action's own refusal for an `endsAt` that is shaped like a date and is not one. */
const END_DATE_UNPARSEABLE = "Indicá hasta qué fecha va el cuidado.";

const RULES: readonly Rule[] = [
  // ---- the PERIOD is not one the domain accepts (400) ----------------------
  //
  // FOUR SENTENCES, ONE CODE, because the move is one move — pick different
  // dates — and the client holds `CARETAKER_MAX_DURATION_DAYS` so it can bound
  // its own picker before the round trip, exactly as the web form does.
  { code: "caretaker_period_invalid", status: 400, matches: exact(INVALID_PERIOD) },
  { code: "caretaker_period_invalid", status: 400, matches: exact(OVER_MAX_DURATION) },
  { code: "caretaker_period_invalid", status: 400, matches: exact(END_IN_PAST) },
  { code: "caretaker_period_invalid", status: 400, matches: exact(END_DATE_UNPARSEABLE) },

  // ---- the two parties are one account (400) -------------------------------
  { code: "caretaker_self", status: 400, matches: exact(SELF_DESIGNATION) },
  { code: "caretaker_self", status: 400, matches: exact("No podés aceptar tu propia invitación.") },

  // ---- the CALLER is not this command's party (403) ------------------------
  //
  // Each is a different rule — the addressee match, the granter check, the
  // titular check inside `endCaretakerGrant` — collapsed into one code because
  // the client's move is identical and because naming which rule refused would
  // describe somebody else's arrangement to a stranger.
  {
    code: "caretaker_forbidden",
    status: 403,
    matches: exact("Esta invitación no es para tu cuenta."),
  },
  // The addressee arm matched the ADDRESS and refused the ACCOUNT (A09-1). Same
  // code as its siblings on purpose: the sentence carries the remedy, and a code
  // of its own would let a client branch on "this address has an open
  // invitation", which is the oracle the 403 exists to avoid.
  {
    code: "caretaker_forbidden",
    status: 403,
    matches: exact(UNCONFIRMED_EMAIL_CARETAKER_ERROR),
  },
  { code: "caretaker_forbidden", status: 403, matches: exact("Esta invitación no es tuya.") },
  {
    code: "caretaker_forbidden",
    status: 403,
    matches: exact("Solo el titular puede finalizar el cuidado."),
  },
  {
    code: "caretaker_forbidden",
    status: 403,
    matches: exact("Solo el cuidador/a puede dar de baja su cuidado."),
  },
  {
    code: "caretaker_forbidden",
    status: 403,
    matches: exact("Solo el titular puede registrar la devolución."),
  },

  // ---- the invitation cannot survive a change of owner (409) ---------------
  //
  // BEFORE the `ya no está disponible` rules, though it shares no prefix with
  // them — placed here because it is the one refusal on this surface whose move
  // is neither "re-read" nor "ask again": the grant still reads pending and the
  // person who sent it can no longer re-send it.
  {
    code: "caretaker_granter_not_titular",
    status: 409,
    matches: exact(
      "Quien te invitó ya no es titular de esta mascota. Pedile al titular actual que te invite de nuevo.",
    ),
  },

  // ---- the period offered is already over (409) ---------------------------
  {
    code: "caretaker_expired",
    status: 409,
    matches: exact("El período de cuidado ya terminó. Pedile al titular que te invite de nuevo."),
  },

  // ---- this animal already has one (409) ----------------------------------
  {
    code: "caretaker_grant_exists",
    status: 409,
    matches: endsWith("ya tiene un cuidador/a temporal activo."),
  },
  {
    code: "caretaker_grant_exists",
    status: 409,
    matches: exact("Ya hay una invitación de cuidado pendiente para esta mascota."),
  },

  // ---- somebody already answered, or the world moved (409) ----------------
  //
  // The `«Finalizar ahora»` sentence lands here on purpose. Re-reading IS the
  // fix: the row comes back `accepted` with `canRevoke`, which is the same
  // instruction expressed as data the screen already renders.
  {
    code: "caretaker_already_resolved",
    status: 409,
    matches: exact("Esta invitación ya no está disponible."),
  },
  {
    code: "caretaker_already_resolved",
    status: 409,
    matches: exact("Esta invitación ya no está pendiente."),
  },
  {
    code: "caretaker_already_resolved",
    status: 409,
    matches: exact("El cuidado ya está activo. Usá «Finalizar ahora» para terminarlo."),
  },
  {
    code: "caretaker_already_resolved",
    status: 409,
    matches: exact("Este cuidado ya no está activo."),
  },

  // ---- nothing to act on (404) --------------------------------------------
  //
  // A grant that does not exist and one addressed to somebody else answer
  // DIFFERENTLY here, and that is deliberate rather than an oracle: the token is
  // 32 hex characters nobody guesses, and both web doors say the same two things
  // in the same two cases. What must never differ is the PET side, and it does
  // not — see `guardTitular`.
  { code: "not_found", status: 404, matches: exact("Invitación no encontrada.") },
  { code: "not_found", status: 404, matches: exact("Cuidado no encontrado.") },

  // ---- the body was wrong after all (400) ---------------------------------
  //
  // Reachable only from a client out of step with the contract: the schema
  // requires a well-shaped address before the round trip.
  { code: "invalid_request", status: 400, matches: exact(MISSING_INVITEE) },
];

/**
 * One use-case refusal, as a response.
 *
 * The fall-through is `caretaker_failed` / 500, the honest answer for a sentence
 * this file does not recognise: it means the mapping is out of step with a
 * use-case, which IS a server defect. It is also the safe direction — an unmapped
 * refusal is still a refusal, and nothing is granted by it.
 */
export function caretakerRefusal(error: string) {
  for (const rule of RULES) {
    if (rule.matches(error)) return apiV1Error(rule.code, rule.status);
  }
  return apiV1Error("caretaker_failed", 500);
}

/** Exported for the route test, which pins every literal the five use-cases return. */
export const CARETAKER_REFUSAL_RULES = RULES;

// ---------------------------------------------------------------------------
// Side effects, post-tx, best-effort
// ---------------------------------------------------------------------------

/**
 * Notifications through the CANONICAL WRITE PATH, never a raw insert.
 *
 * `src/modules/caretakers/README.md` makes this a rule of the module rather than
 * a preference: the sibling modules still hold their own raw insert into
 * `notifications` and are grandfathered into
 * `scripts/notifications-service-baseline.json`; caretakers is NOT in that
 * baseline and must never be added to it. The service buys idempotency
 * (ON CONFLICT (dedupe_key) DO NOTHING) and durability (a failed insert is
 * dead-lettered instead of vanishing into a console.error).
 *
 * Runs OUTSIDE the business transaction and swallows everything: a notification
 * is a CONSEQUENCE of a fact, not part of it, and a command that already
 * succeeded must not be reported as failed over one.
 */
async function flushNotifications(pending: NewNotification[]): Promise<void> {
  if (pending.length === 0) return;
  try {
    await createNotificationsBulk(pending);
  } catch (e) {
    console.error("[api-v1-caretaker-grants] notifications insert failed (it did succeed):", e);
  }
}

/**
 * One `audit_log` row, post-tx, best-effort.
 *
 * The `action` names are the WEB'S OWN — declared by migration 0202 — so a row
 * written from a phone is indistinguishable from one written in a browser, which
 * is the entire point of writing it here at all.
 */
async function flushAuditLog(entry: {
  actorUserId: string;
  action: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(auditLog).values(entry as typeof auditLog.$inferInsert);
  } catch (e) {
    console.error("[api-v1-caretaker-grants] auditLog insert failed (it did succeed):", e);
  }
}

function deps() {
  return {
    repo: CaretakersRepository,
    now: () => new Date(),
    transaction: db.transaction.bind(db) as <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>,
  };
}

// ---------------------------------------------------------------------------
// The titular guard
// ---------------------------------------------------------------------------

type TitularAccess = Extract<PetHolderAccess, { kind: "owner" } | { kind: "org" }>;

/**
 * `requireTitularAccess`, mirrored over a bearer session.
 *
 * The web's helper is `requirePetAccess` (cookie session) plus ONE deny: a
 * person-path holder whose ownership role is `caretaker`, because a caretaker
 * naming a sub-caretaker is deny-list row `caretaker-sub-designation`. Copied as
 * that deny and NOT as an allow-list, because an allow-list would silently narrow
 * the three roles the web admits — co_owner, foster, and the whole org path.
 *
 * A pet this caller may not touch and a pet that does not exist answer
 * IDENTICALLY, exactly as every other endpoint on this surface does.
 */
async function guardTitular(
  publicToken: string,
  userId: string,
): Promise<{ ok: true; access: TitularAccess } | { ok: false; response: Response }> {
  let access: PetHolderAccess;
  try {
    access = await withDbBudgetOrThrow(
      resolvePetHolderAccess(publicToken, userId),
      READ_BUDGET_MS,
      "api-v1-caretaker-grants-access",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return { ok: false, response: unavailable() };
    throw err;
  }

  if (access.kind === "none") return { ok: false, response: apiV1Error("not_found", 404) };
  if (access.kind === "owner" && access.holderRole === "caretaker") {
    return { ok: false, response: apiV1Error("caretaker_forbidden", 403) };
  }
  return { ok: true, access };
}

// ---------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------

export async function runCaretakerCommand(ctx: CaretakerCommandContext) {
  switch (ctx.input.command) {
    case "designate":
      return await designate(ctx, ctx.input);
    case "accept":
      return await accept(ctx, ctx.input);
    case "reject":
      return await reject(ctx, ctx.input);
    case "cancel":
      return await cancel(ctx, ctx.input);
    case "revoke":
      return await revoke(ctx, ctx.input);
  }
}

async function designate(
  ctx: CaretakerCommandContext,
  input: Extract<CaretakerCommandInput, { command: "designate" }>,
) {
  const guard = await guardTitular(input.petPublicToken, ctx.userId);
  if (!guard.ok) return guard.response;

  // THE DAYS BECOME INSTANTS HERE, exactly as `designateCaretakerAction` does it
  // (`actions.ts:129-135`): the first instant of the first Argentine day, and the
  // LAST instant of the last one, because "hasta el 15/09" promises the whole
  // 15th.
  //
  // NEITHER FALLBACK BELOW IS REACHABLE, and both stay. `parseArDateStartOfDay`
  // and `parseArDateEndOfDay` answer null for a malformed shape or an impossible
  // MONTH, and roll an impossible DAY over silently (`2026-02-31` → 3 March,
  // measured 2026-08-26) — so on their own they are not enough to trust a date
  // string with. The route parses this body against `caretakerCommandInputSchema`
  // first, and that schema's `isRealArDay` refuses every one of those cases with
  // `DATE_INVALID` before control arrives here. The guards are the belt to that
  // brace: they cost a comparison and they are what stops a future caller that
  // reaches these writers by another path from inheriting the rollover.
  const startsAt = parseArDateStartOfDay(input.startsAt) ?? new Date();
  const endsAt = parseArDateEndOfDay(input.endsAt);
  if (!endsAt) return caretakerRefusal(END_DATE_UNPARSEABLE);

  const result = await designateCaretaker(
    {
      petId: guard.access.pet.id,
      petName: guard.access.pet.name,
      petPublicToken: input.petPublicToken,
      titularUserId: ctx.userId,
      inviteeEmail: input.inviteeEmail,
      startsAt,
      endsAt,
      note: input.note,
    },
    { repo: CaretakersRepository, now: () => new Date() },
  );
  if (!result.ok) return caretakerRefusal(result.error);

  await flushNotifications(result.notifications);
  await flushAuditLog({
    actorUserId: ctx.userId,
    action: "caretaker_designated",
    payload: {
      grant_public_token: result.value.grantPublicToken,
      pet_id: guard.access.pet.id,
      // The invitee's address is a third party's PII. It is already stored on the
      // grant row (under the pii baseline) and the audit entry has to say WHO was
      // invited, so it rides — and nothing beyond it does. Same payload the web
      // action writes, so the two rows are indistinguishable.
      to_email: result.value.inviteeEmail,
      to_user_known: !result.value.inviteeNeedsAccount,
    },
  });

  // THE INVITATION E-MAIL IS NOT SENT FROM HERE, and that is a documented gap
  // rather than an oversight — the same one `me/transfers/commands.ts` records.
  // `designateCaretakerAction` calls `admin.auth.admin.inviteUserByEmail` with a
  // `redirectTo` pointing at the WEB page (`actions.ts:170-180`), a link into a
  // browser session, which is the only thing that flow can currently produce.
  // Firing it from a native write would send somebody a web magic link on a phone
  // that has this app installed, landing them where they did not ask to be.
  // `inviteeNeedsAccount` is on the wire instead, so the client can say plainly
  // that the address has no account and the person has to be told another way.
  // It matters MORE here than for a transfer: an invitee with no account gets no
  // in-app notification either (`designateCaretaker` only builds one when the
  // e-mail resolved), so `true` means nobody has been told anything at all.
  return ack({
    command: "designate",
    changed: true,
    grantToken: result.value.grantPublicToken,
    petPublicToken: null,
    inviteeNeedsAccount: result.value.inviteeNeedsAccount,
  });
}

async function accept(
  ctx: CaretakerCommandContext,
  input: Extract<CaretakerCommandInput, { command: "accept" }>,
) {
  // NO PET GUARD, and its absence is the design: the accepting user holds no
  // ownership row on this animal yet, so there is nothing for a pet guard to
  // resolve. The id-or-email match runs inside the use-case, and the H4
  // granter-still-titular check runs inside its transaction, under the lock.
  const result = await acceptCaretakerGrant(
    {
      grantPublicToken: input.grantToken,
      callerUserId: ctx.userId,
      callerEmail: ctx.callerEmail,
      callerEmailConfirmed: ctx.callerEmailConfirmed,
      // KEY 2 of the two-key public-contact model. Absent means NOT consented —
      // an unticked checkbox sends no field and silence is never consent.
      publicContactConsent: input.publicContactConsent === true,
    },
    deps(),
  );
  if (!result.ok) return caretakerRefusal(result.error);

  await flushNotifications(result.notifications);
  await flushAuditLog({
    actorUserId: ctx.userId,
    action: "caretaker_grant_accepted",
    payload: {
      grant_public_token: input.grantToken,
      public_contact_consent: input.publicContactConsent === true,
    },
  });

  // The animal is readable by the caller now, and its cockpit is where the web
  // sends them too. It can be null when the use-case could not read the pet back;
  // a client that treats null as "go to the list" matches the web's fallback.
  return ack({
    command: "accept",
    changed: true,
    grantToken: input.grantToken,
    petPublicToken: result.value.petPublicToken,
    inviteeNeedsAccount: null,
  });
}

async function reject(
  ctx: CaretakerCommandContext,
  input: Extract<CaretakerCommandInput, { command: "reject" }>,
) {
  const result = await rejectCaretakerGrant(
    {
      grantPublicToken: input.grantToken,
      callerUserId: ctx.userId,
      callerEmail: ctx.callerEmail,
      callerEmailConfirmed: ctx.callerEmailConfirmed,
    },
    { repo: CaretakersRepository, now: () => new Date() },
  );
  if (!result.ok) return caretakerRefusal(result.error);

  await flushNotifications(result.notifications);
  await flushAuditLog({
    actorUserId: ctx.userId,
    action: "caretaker_grant_rejected",
    payload: { grant_public_token: input.grantToken, pet_id: result.value.petId },
  });

  return ack({
    command: "reject",
    changed: true,
    grantToken: input.grantToken,
    petPublicToken: null,
    inviteeNeedsAccount: null,
  });
}

async function cancel(
  ctx: CaretakerCommandContext,
  input: Extract<CaretakerCommandInput, { command: "cancel" }>,
) {
  const guard = await guardTitular(input.petPublicToken, ctx.userId);
  if (!guard.ok) return guard.response;

  const result = await cancelCaretakerGrant(
    { grantPublicToken: input.grantToken, titularUserId: ctx.userId },
    { repo: CaretakersRepository, now: () => new Date() },
  );
  if (!result.ok) return caretakerRefusal(result.error);

  await flushNotifications(result.notifications);
  // Distinct from `caretaker_grant_revoked`: that one ends an ACTIVE arrangement,
  // this one withdraws an invitation nobody accepted yet. Same actor, different
  // fact, and the audit trail has to be able to tell them apart.
  await flushAuditLog({
    actorUserId: ctx.userId,
    action: "caretaker_grant_cancelled",
    payload: { grant_public_token: input.grantToken, pet_id: result.value.petId },
  });

  return ack({
    command: "cancel",
    changed: true,
    grantToken: input.grantToken,
    petPublicToken: null,
    inviteeNeedsAccount: null,
  });
}

async function revoke(
  ctx: CaretakerCommandContext,
  input: Extract<CaretakerCommandInput, { command: "revoke" }>,
) {
  const guard = await guardTitular(input.petPublicToken, ctx.userId);
  if (!guard.ok) return guard.response;

  const result = await endCaretakerGrant(
    { grantPublicToken: input.grantToken, action: "revoke", actorUserId: ctx.userId },
    deps(),
  );
  if (!result.ok) return caretakerRefusal(result.error);

  await flushNotifications(result.notifications);
  await flushAuditLog({
    actorUserId: ctx.userId,
    action: "caretaker_grant_revoked",
    // THE USE-CASE'S OWN `petId`, not the guarded pet's. Nothing cross-checks the
    // two (see the header), and an audit row must record the animal the write
    // actually touched.
    payload: { grant_public_token: input.grantToken, pet_id: result.value.petId },
  });

  return ack({
    command: "revoke",
    changed: true,
    grantToken: input.grantToken,
    petPublicToken: null,
    inviteeNeedsAccount: null,
  });
}

/**
 * The hub read, budgeted. Exported so the route reads nothing itself.
 *
 * STATICALLY IMPORTED, deliberately. A per-call `await import()` of a module the
 * suite mocks silently drops one of two concurrent callers in vitest — a defect
 * this repo has already paid for once — and there is nothing here a lazy import
 * would buy.
 */
export async function readCaretakerGrants(args: {
  userId: string;
  callerEmail: string;
  callerEmailConfirmed: boolean;
}) {
  return withDbBudgetOrThrow(
    listCaretakerGrantsForUser(args, { repo: CaretakersRepository }),
    READ_BUDGET_MS,
    "api-v1-me-caretaker-grants-list",
  );
}

// The four sharing commands, behind `POST /api/v1/pets/{publicToken}/shares`.
//
// Split out of `route.ts` for the reason lost mode split its own: that file's
// subject is "is this request well formed", and this one's is "may this command
// run, and what exactly does it do".
//
// WHO MAY RUN EACH ONE — VERIFIED AGAINST THE WEB, AND NOT UNIFORM
// ---------------------------------------------------------------------------
// Cited at the GUARD CALL rather than at the function that contains it — a
// function's first line drifts every time somebody adds a parameter, and the
// line that matters is the one naming the rule:
//
//   crear link      `createLibretaShareAction`  app/actions/libreta-share.ts:78
//   revocar link    `revokeLibretaShareAction`  app/actions/libreta-share.ts:92
//   abrir Tier-2    `enableTier2PublicAction`   app/actions/tier2-public.ts:19
//   cerrar Tier-2   `revokeTier2PublicAction`   app/actions/tier2-public.ts:25
//
// THREE OF THE FOUR are `requireTitularAccess`, which denies exactly one thing —
// a person-path holder whose ownership role is `caretaker`. A co-owner passes, a
// foster passes, and the ORG path passes. Mirrored here as a DENY by shape
// (`isTitular` in ./payload.ts), never as an allow-list, because an allow-list
// would quietly narrow the roles the web admits.
//
// THE FOURTH IS SIDEWAYS, NOT WIDER OR NARROWER. Revocation's shim guard is only
// `requireLiveUser`; the real rule lives in the writer and it is
// CREATOR-OR-ADMIN (`revoke-libreta-share.ts:35-44`). A co-owner who is a
// perfectly good titular cannot revoke a link they did not mint, and the writer
// says why: medical-history continuity. An endpoint that tidied the four into
// one rule would hand a co-owner a revocation the web denies them.
//
// AND CREATION IS NARROWED AGAIN ONE LAYER DOWN, BY THE WEB ITSELF.
// `createLibretaShareForUser` joins `ownerships` on `owner_user_id = $userId`
// (`create-libreta-share.ts:41`), which the ORG path has no row for — so an org
// member passes the guard and is refused by the writer. Both refusals are real
// on the web; this endpoint reports them together because they have one fix.
//
// TWO NARROWINGS THIS ENDPOINT PERFORMS THAT THE WEB DOES NOT, both documented
// rather than smuggled:
//
//   · THE SHARE MUST BELONG TO THE PET IN THE PATH. `revokeLibretaShareAction`
//     takes a bare row id and is not nested under an animal, so on the web an
//     admin can revoke any share from any page. This URL says
//     `/pets/{token}/shares`, and honouring a row id from another animal would
//     make that path segment a lie. See `find-share-for-pet.ts`.
//   · THE TIER-2 WINDOW IS ENUMERATED. `enable-tier2-public.ts:44` reads
//     `DURATION_MS[duration] ?? DAY_MS`, so an unknown string silently becomes
//     24 hours. Harmless for a `<form>` that can only post one of four values;
//     wrong for a JSON body, where a client sending `"7days"` would get a
//     24-hour window and a success it could not distinguish from what it asked
//     for. The contract refuses the unknown string instead.
//
// IDEMPOTENCY: NO HEADER, AND THAT IS A REFUSAL TO PROMISE
// ---------------------------------------------------------------------------
// None of the four writers takes a `clientIdempotencyKey` — there is no spine
// append here at all. All four are idempotent on the STATE instead: a duplicate
// create returns the EXISTING token rather than burning a slot
// (`create-libreta-share.ts:85-90`), a re-open of an equivalent Tier-2 window
// writes nothing (`enable-tier2-public.ts:54`), a re-request of permanent
// exposure returns early (`:36`), and revoking twice sets a flag that is already
// set. Demanding a header those four could not honour is the false promise
// `events/writers.ts` refuses to make for atestación PPP and embarazo.
//
// `changed` IS MEASURED, NEVER RE-DERIVED
// ---------------------------------------------------------------------------
// Every arm decides it by comparing state read BEFORE the call against state
// read after, or by membership in a set it already held. A second copy of the
// writers' own no-op rules here — "within a minute of the requested window",
// "same label and an equivalent expiry" — would be the exact drift this endpoint
// exists to avoid, and it would go wrong silently the day somebody tunes one.
//
// NOTHING IN THIS FILE READS `db` DIRECTLY. Every read is a named use-case in
// `src/modules/pets/application/**`, which is what lets the route test replace
// them one by one instead of mocking a query builder — and what keeps the module
// fence's dependency direction pointing the way it is supposed to.

import type { Pet } from "@/db";
import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { type PetHolderAccess, resolvePetHolderAccess } from "@/lib/infra/pet-access";
import { createLibretaShareForUser } from "@/src/modules/pets/application/libreta-share/create-libreta-share";
import { findShareForPet } from "@/src/modules/pets/application/libreta-share/find-share-for-pet";
import { getActiveLibretaShares } from "@/src/modules/pets/application/libreta-share/get-active-libreta-shares";
import { revokeLibretaShareForUser } from "@/src/modules/pets/application/libreta-share/revoke-libreta-share";
import { enableTier2Public } from "@/src/modules/pets/application/tier2-public/enable-tier2-public";
import {
  readTier2State,
  tier2StateDiffers,
} from "@/src/modules/pets/application/tier2-public/read-tier2-state";
import { revokeTier2Public } from "@/src/modules/pets/application/tier2-public/revoke-tier2-public";
import type { ShareCommandAckV1 } from "@dim/contract/api";
import type { ShareCommandInput } from "@dim/contract/input";

import { canMintShare, isTitular } from "./payload";

/**
 * The pre-write reads: the access query, the share probes and the Tier-2
 * before-snapshot.
 *
 * The WRITES are deliberately outside any budget, for the reason the events
 * endpoint records: `withDbBudgetOrThrow` races a promise against a timer and
 * rejects, which does not abort a Postgres transaction. Wrapping a write would
 * produce a 503 for a mutation that then COMMITS — the client sees failure, the
 * link exists, and the two disagree forever. The AFTER-snapshots are unbudgeted
 * for a related reason: by then the write has happened, and a timeout there must
 * not turn a successful command into a 503.
 */
const RESOLVE_BUDGET_MS = 8_000;

const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/** The 503 this endpoint answers for every degraded pre-write read. */
export function unavailable() {
  return apiV1Error("temporarily_unavailable", 503, {
    "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
  });
}

export type CommandContext = {
  publicToken: string;
  userId: string;
  input: ShareCommandInput;
};

function ack(body: ShareCommandAckV1) {
  return apiV1Json(body, { status: 200 });
}

/** Everything from the access guard to the command. */
export async function runShareCommand(ctx: CommandContext) {
  let access: PetHolderAccess;
  try {
    access = await withDbBudgetOrThrow(
      resolvePetHolderAccess(ctx.publicToken, ctx.userId),
      RESOLVE_BUDGET_MS,
      "api-v1-shares-access",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  // A pet this caller may not touch and a pet that does not exist answer
  // IDENTICALLY, exactly as every other endpoint on this surface does.
  if (access.kind === "none") return apiV1Error("not_found", 404);

  const accessPath = access.kind === "owner" ? "owner" : "org";
  const holderRole = access.kind === "owner" ? access.holderRole : null;

  const guard = checkCommandGuard(accessPath, holderRole, ctx.input);
  if (guard) return guard;

  const situation = checkSituation(access.pet.status, ctx.input);
  if (situation) return situation;

  try {
    return await dispatch(ctx, access.pet, accessPath);
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
}

/**
 * The refusals that are about the CALLER, and nothing else. `null` means run it.
 *
 * Revocation is ABSENT from this switch on purpose: its rule is creator-or-admin
 * over a row this function has not read, so it cannot be decided here. It is
 * enforced by the writer, and `revokeShare` maps the writer's refusal.
 */
function checkCommandGuard(
  accessPath: "owner" | "org",
  holderRole: string | null,
  input: ShareCommandInput,
) {
  switch (input.command) {
    case "create_libreta_share":
      // Two web refusals with one code — the guard's (a caretaker) and the
      // writer's (an org member with no `ownerships` row). Both are facts about
      // the CALLER, and neither has a different fix.
      return canMintShare(accessPath, holderRole) ? null : apiV1Error("share_forbidden", 403);
    case "enable_tier2":
    case "revoke_tier2":
      return isTitular(accessPath, holderRole) ? null : apiV1Error("share_forbidden", 403);
    case "revoke_libreta_share":
      return null;
  }
}

/**
 * The refusals that are about the ANIMAL — 409, not 403, the same split lost
 * mode makes.
 *
 * Exactly one exists. `enableTier2Public` THROWS for a deceased animal
 * (`enable-tier2-public.ts:23`) because the public credential of a deceased
 * animal is the in-memoriam page and medical detail has no purpose there.
 * Refusing here is what turns that throw into a code a client can switch on; the
 * throw stays as the backstop.
 *
 * REVOCATION IS NOT LISTED, for either feature. Closing an exposure must never
 * be refused on account of the animal's state — a deceased animal whose Tier-2
 * window is still open is precisely a case somebody needs to be able to shut.
 */
function checkSituation(status: string, input: ShareCommandInput) {
  if (input.command === "enable_tier2" && status === "deceased") {
    return apiV1Error("tier2_not_allowed", 409);
  }
  return null;
}

/**
 * THE WHOLE PET ROW TRAVELS, not an `{ id, status }` narrowing.
 *
 * `enableTier2Public` reads `tier2PublicPermanent` and `tier2PublicEnabledUntil`
 * off the object it is handed, and those two fields are what its desired-state
 * guards are made of (`enable-tier2-public.ts:36,:53`). A narrowed object hands
 * it `undefined` for both, every guard reads falsy, and the writer stops
 * recognising its own no-ops — it would write on every request while this
 * endpoint still reported `changed` correctly from the before/after snapshots.
 * A silent extra write and a lost idempotency guarantee, with nothing red.
 */
async function dispatch(ctx: CommandContext, pet: Pet, accessPath: "owner" | "org") {
  switch (ctx.input.command) {
    case "create_libreta_share":
      return createShare(ctx, ctx.input, pet.id, accessPath);
    case "revoke_libreta_share":
      return revokeShare(ctx, ctx.input, pet.id);
    case "enable_tier2":
      return enableTier2(ctx, ctx.input, pet);
    case "revoke_tier2":
      return revokeTier2(ctx, pet);
  }
}

async function createShare(
  ctx: CommandContext,
  input: Extract<ShareCommandInput, { command: "create_libreta_share" }>,
  petId: string,
  accessPath: "owner" | "org",
) {
  // The tokens this animal already holds, read BEFORE the write. It is the only
  // way to tell a fresh mint from the writer's own recognised duplicate, which
  // returns an EXISTING token and is indistinguishable from the outside. At most
  // five rows, on the partial index the cap count already uses.
  const before = await withDbBudgetOrThrow(
    getActiveLibretaShares(petId),
    RESOLVE_BUDGET_MS,
    "api-v1-shares-existing",
  );
  const existing = new Set(before.map((row) => row.shareToken));

  const result = await createLibretaShareForUser(ctx.userId, {
    petPublicToken: ctx.publicToken,
    expiresInDays: input.expiresInDays,
    label: input.label,
  });

  if ("error" in result) {
    // THE WRITER RETURNS PROSE, NOT A CODE, so the reason is DEDUCED from two
    // facts this endpoint already holds rather than matched against a Spanish
    // string a copy edit would silently break. The writer has exactly two
    // failure paths: the `ownerships` join, and the five-active cap. The join
    // uses the SAME predicate `resolvePetHolderAccess` just satisfied on the
    // person path — so when the caller reached us as `owner`, the join cannot be
    // what failed, and the cap is the only remaining answer.
    return accessPath === "owner"
      ? apiV1Error("share_limit_reached", 409)
      : apiV1Error("share_forbidden", 403);
  }

  return ack({
    command: "create_libreta_share",
    changed: !existing.has(result.shareToken),
    shareToken: result.shareToken,
    tier2Window: null,
  });
}

async function revokeShare(
  ctx: CommandContext,
  input: Extract<ShareCommandInput, { command: "revoke_libreta_share" }>,
  petId: string,
) {
  // THE NARROWING: the row must belong to the animal in the path. A row that
  // does not exist and a row that belongs to somebody else's animal answer
  // IDENTICALLY, because telling them apart is an oracle for which ids are real.
  const row = await withDbBudgetOrThrow(
    findShareForPet(input.shareId, petId),
    RESOLVE_BUDGET_MS,
    "api-v1-shares-row",
  );
  if (row === null) return apiV1Error("not_found", 404);

  // Read before the write, so `changed` is measured rather than assumed. An
  // already-revoked row is not reachable from the list — it filters them out —
  // but a replayed request is exactly what the flag exists for.
  const wasRevoked = row.revokedAt !== null;

  const result = await revokeLibretaShareForUser(ctx.userId, input.shareId);
  if ("error" in result) {
    // The row was found above, so the writer's "not found" is impossible here
    // and the only remaining refusal is creator-or-admin.
    return apiV1Error("share_forbidden", 403);
  }

  return ack({
    command: "revoke_libreta_share",
    changed: !wasRevoked,
    shareToken: null,
    tier2Window: null,
  });
}

async function enableTier2(
  ctx: CommandContext,
  input: Extract<ShareCommandInput, { command: "enable_tier2" }>,
  pet: Pet,
) {
  const before = await withDbBudgetOrThrow(
    readTier2State(pet.id),
    RESOLVE_BUDGET_MS,
    "api-v1-shares-tier2-before",
  );

  // The writer reads its window out of `FormData`, because it was written for a
  // `<form>`. Handing it one is not a workaround: it is the same value the web
  // posts, through the same door, which is what keeps the two from drifting. The
  // contract already refused anything the picker cannot produce.
  const form = new FormData();
  form.set("duration", input.window);
  await enableTier2Public(pet, ctx.publicToken, form);

  const after = await readTier2State(pet.id);

  return ack({
    command: "enable_tier2",
    changed: tier2StateDiffers(before, after),
    shareToken: null,
    tier2Window: input.window,
  });
}

async function revokeTier2(ctx: CommandContext, pet: Pet) {
  const before = await withDbBudgetOrThrow(
    readTier2State(pet.id),
    RESOLVE_BUDGET_MS,
    "api-v1-shares-tier2-before",
  );

  await revokeTier2Public(pet, ctx.publicToken);

  const after = await readTier2State(pet.id);

  return ack({
    command: "revoke_tier2",
    changed: tier2StateDiffers(before, after),
    shareToken: null,
    tier2Window: null,
  });
}

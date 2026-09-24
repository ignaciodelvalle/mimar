// The six lost-mode commands, behind `POST /api/v1/pets/{publicToken}/lost`.
//
// Split out of `route.ts` for the reason the events endpoint split its own
// writers: that file's subject is "is this request well formed", and this one's
// is "may this command run, and what exactly does it do". Different questions,
// different failure vocabularies, and the linter's complexity ceiling agrees.
//
// WHO MAY RUN EACH ONE — VERIFIED AGAINST THE WEB, AND NOT UNIFORM
// ---------------------------------------------------------------------------
// FOUR OF THE SIX are guarded on the web by `requirePetAccess(publicToken)`,
// cited at the guard call rather than at the function that contains it:
//
//   marcar perdida        `setPetLostAction`            actions.ts:851
//   actualizar avistaje   `updateLostLastSeenAction`    actions.ts:942
//   marcar encontrada     `setPetFoundAction`           actions.ts:1005
//   preferencias (5)      `setPetDisclosurePrefsAction` app/actions/lost-mode.ts:34
//
// Read literally, `requirePetAccess` is WIDER than the clinical writers' guard:
//
//   · Any CURRENT HOLDER on the person path — owner, co_owner, foster OR
//     caretaker. NOT titular-only, and this was verified rather than assumed:
//     `requireTitularAccess` exists and none of these four calls it.
//   · An ORG-path member of an organization holding an active ownership row.
//     NO capability check — `event.write` belongs to the ALIVE variant, not to
//     this one. A shelter with custody can mark an animal lost, which is rather
//     the point of a shelter having custody.
//   · It ACCEPTS a non-alive animal deliberately: the writers refuse a DECEASED
//     one themselves, with their own message. The guard is not where that is
//     decided, and this file mirrors the split rather than tidying it.
//
// THE TWO EXCEPTIONS, and both are narrowings the web performs itself:
//
//   · `discloseCaretakerContactWhenLost` — `setPetDisclosurePrefsAction` swaps
//     `requirePetAccess` for `requireTitularAccess` (app/actions/lost-mode.ts:33)
//     when `disclosureKeyRequiresTitular(key)` says so — the key set itself is
//     `TITULAR_ONLY_DISCLOSURE_KEYS`, in
//     `src/modules/pets/application/lost-mode/disclosure-scope.ts:34`, not in
//     the shim that reads it. It is KEY 1
//     of a two-key model: the caretaker consents at invitation accept (key 2),
//     the titular decides whether to publish (key 1). A caretaker who could flip
//     key 1 would hold both keys and the second would stop meaning anything.
//   · `reactivate_search` — `reactivateLostSearchAction` guards with
//     `requirePetAccess` AND THEN throws on `accessPath !== "owner"`
//     (app/actions/reactivate-lost-search.ts:17). The ORG path is refused, alone
//     on this surface. Mirrored exactly; an endpoint that "tidied" the commands
//     into one rule would hand an org member a reactivation the web denies them.
//
// THE SIXTH, `report_content`, HAS NO WEB COUNTERPART AT ALL and therefore no
// guard to mirror — so it takes the one the four above share, unchanged. Whoever
// may READ this feed may report an item on it. Its own docblock below says why
// that is the right shape rather than a shortcut, and why the word in every
// string a person reads is "reportar" and never "denunciar".
//
// IDEMPOTENCY, AND WHY THE HEADER IS NOT UNIFORM EITHER
// ---------------------------------------------------------------------------
// TWO of the six APPEND and only ONE of the two needs a header, which is the
// proof that the split is the STATE and not the append.
//
// `report_last_seen` writes a `note_added` onto the append-only spine, and
// `updateLostLastSeen` takes a `clientIdempotencyKey` and routes through
// `insertEventIdempotent`. Two sightings minutes apart are two facts, so it
// REQUIRES an `Idempotency-Key`, honours it, and reports the replay.
//
// The other five are idempotent on the state itself:
//   · `mark_lost` refuses an animal already lost.
//   · `mark_found` writes NOTHING for an animal that is not lost.
//   · `reactivate_search` returns the OPEN episode when one exists rather than
//     forking the search into two untracked cases.
//   · `set_disclosure` is a no-op when the value already matches.
//   · `report_content` appends `content_reported` — an append — but an item
//     already reported is not reported twice: the writer probes and answers
//     `alreadyReported`, and the item is hidden either way, because the feed's
//     exclusion is a set membership and not a count.
// Demanding a header those five cannot honour is exactly the false promise the
// events endpoint refuses to make for atestación PPP and embarazo, and the read
// payload's capability flags are how a client knows which command it is sending.
//
// WHAT THE SERVER DECIDES AND THE CLIENT MAY NOT
// ---------------------------------------------------------------------------
//   · THE ALERT FAN-OUT. `setPetLostWriter` broadcasts to the organizations in
//     the animal's jurisdiction, keyed by the episode's case id so a retry
//     re-notifies nobody. The wire carries no recipient and no jurisdiction.
//   · THE CASE. Opening the `lost_pet_episode`, stamping it on the
//     `status_changed` event, and closing it on recovery are the writer's, inside
//     its transaction. A client that named a case id would be able to attach a
//     sighting to somebody else's episode.
//   · THE RETROACTIVE IDENTIFIERS. A chip or tattoo in the enriched description
//     is recorded ONLY when the animal has no active canonical one, decided
//     against `pet_identifications` — a table a phone does not hold.
//   · WHO IS TOLD THE ANIMAL CAME HOME. Both reads live in
//     `found-notification-audience.ts` and are shared with the web action, so the
//     `role = 'owner'` filter that took months to find exists once.

import { CoordError, normalizeLocationForWrite } from "@/lib/domain/location-normalize";
import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import { findOpenCaseForPetAndKind } from "@/lib/infra/case-helpers";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import {
  OWNER_AUTHORSHIP,
  type PetHolderAccess,
  resolvePetHolderAccess,
} from "@/lib/infra/pet-access";
import { reportError } from "@/lib/infra/report-error";
import { reactivateLostSearch } from "@/src/modules/cases/application/reactivate-lost-search";
import {
  findBroadcastRecipientUserIds,
  resolveFoundConfirmationRecipient,
} from "@/src/modules/events/application/lifecycle/found-notification-audience";
import { reportLostFeedItem } from "@/src/modules/events/application/lifecycle/report-lost-feed-item-use-case";
import { setPetFound } from "@/src/modules/events/application/lifecycle/set-pet-found-use-case";
import { setPetLostWriter } from "@/src/modules/events/application/lifecycle/set-pet-lost-use-case";
import { updateLostLastSeen } from "@/src/modules/events/application/lifecycle/update-lost-last-seen-use-case";
import { flushNotifications } from "@/src/modules/events/application/writers";
import { EventsRepository } from "@/src/modules/events/infrastructure/events-repository";
import { setPetDisclosurePrefs } from "@/src/modules/pets/application/lost-mode/set-pet-disclosure-prefs";
import type { LostCommandAckV1, LostPetStatus } from "@dim/contract/api";
import { type LostCommandInput, TITULAR_ONLY_DISCLOSURE_KEYS } from "@dim/contract/input";

import { db } from "@/db";

/**
 * The pre-write reads: the access query and the open-case probe.
 *
 * The WRITES are deliberately outside any budget, for the reason the events
 * endpoint records: `withDbBudgetOrThrow` races a promise against a timer and
 * rejects, which does not abort a Postgres transaction. Wrapping the append
 * would produce a 503 for a transaction that then COMMITS — the client sees
 * failure, the ledger has the event, and the two disagree forever.
 */
const RESOLVE_BUDGET_MS = 8_000;

const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/** The 503 this endpoint answers for every degraded pre-write read. */
export function unavailable() {
  return apiV1Error("temporarily_unavailable", 503, {
    "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
  });
}

const TITULAR_ONLY: ReadonlySet<string> = new Set(TITULAR_ONLY_DISCLOSURE_KEYS);

/** The es-AR code `setPetLostWriter` answers for a malformed retroactive chip. */
const INVALID_CHIP = "INVALID_MICROCHIP_FORMAT";

type Authorship = {
  authorRole: string;
  authorOrganizationId: string | null;
  authorVerified: boolean;
};

export type CommandContext = {
  publicToken: string;
  userId: string;
  /** Present only for `report_last_seen`; the route refuses that one without it. */
  idempotencyKey: string | null;
  input: LostCommandInput;
};

/** Everything from the access guard to the command. */
export async function runLostCommand(ctx: CommandContext) {
  let access: PetHolderAccess;
  try {
    access = await withDbBudgetOrThrow(
      resolvePetHolderAccess(ctx.publicToken, ctx.userId),
      RESOLVE_BUDGET_MS,
      "api-v1-lost-access",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  // A pet this caller may not touch and a pet that does not exist answer
  // IDENTICALLY, exactly as every other endpoint on this surface does.
  if (access.kind === "none") return apiV1Error("not_found", 404);

  const guard = checkCommandGuard(access, ctx.input);
  if (guard) return guard;

  const situation = checkSituation(access.pet.status, ctx.input);
  if (situation) return situation;

  return dispatch(ctx, access);
}

/**
 * The two refusals that are about the CALLER, and nothing else.
 *
 * `null` means "run it". Both are narrowings the WEB performs on top of
 * `requirePetAccess`, and both are enforced here by the same shape the web uses
 * rather than by resemblance: one role comparison and one path comparison,
 * against the access record the guard already returned.
 */
function checkCommandGuard(
  access: Exclude<PetHolderAccess, { kind: "none" }>,
  input: LostCommandInput,
) {
  // `requireTitularAccess` denies exactly one thing: a person-path holder whose
  // role is `caretaker`. A co-owner passes, a foster passes, the org path
  // passes. Copied as a DENY and not as an allow-list, because an allow-list
  // here would quietly narrow the three roles the web admits.
  if (
    input.command === "set_disclosure" &&
    TITULAR_ONLY.has(input.key) &&
    access.kind === "owner" &&
    access.holderRole === "caretaker"
  ) {
    return apiV1Error("lost_forbidden", 403);
  }

  // The org path is refused for TWO commands on this surface, and the second
  // one is `report_content` — added after a fresh-context review named the
  // attack out loud.
  //
  // THE HIDE IS PET-GLOBAL. `notReportedClause` subtracts a reported item for
  // EVERY reader of that animal's record, not just for whoever reported it —
  // that is deliberate (a per-viewer feed would be a second truth about one
  // spine, and an abusive message is no less abusive to the next person). But
  // combined with an org-path reporter it becomes something nobody designed:
  // an organization holding `shelter_custody` could make a finder's "tengo a tu
  // perro, llamame" disappear from the OWNER's feed, counter and public
  // credential — silently, with no notice and no un-report. In a product that
  // has custody disputes as a first-class concept, that is a lever pointed at
  // the exact moment a search is about to end.
  //
  // A caretaker keeps the affordance: they are a person the TITULAR invited,
  // through a two-key model, and they are often the one actually reading the
  // feed. An organization is not that.
  //
  // Mirrored from `reactivate_search` rather than invented: that command is
  // refused on the org path alone for the same shape of reason — a shelter
  // holding custody may mark an animal lost and found, and may not reopen a
  // search the stale-case cron closed.
  if (
    (input.command === "reactivate_search" || input.command === "report_content") &&
    access.kind === "org"
  ) {
    return apiV1Error("lost_forbidden", 403);
  }

  return null;
}

/**
 * The refusals that are about the ANIMAL'S SITUATION.
 *
 * Every one is ALSO checked inside its writer — the same belt-and-braces the
 * events endpoint applies to a medication's source event, and for the same
 * reason: checked here the refusal carries a status a client can switch on,
 * checked there it is true regardless of which door called.
 *
 * `mark_found` is deliberately absent from the `lost`-requiring pair: "make this
 * animal not lost" is already satisfied for an animal that is not lost, so the
 * writer answers `alreadyActive` and this endpoint answers 200 with
 * `changed: false`. A 409 there would refuse somebody for asking for a state
 * that already holds.
 */
function checkSituation(status: string, input: LostCommandInput) {
  const deceased = status === "deceased";

  switch (input.command) {
    case "mark_lost":
      // A closed life record accepts no status change — the same code the events
      // endpoint uses for the same fact, because it is about the ANIMAL.
      if (deceased) return apiV1Error("event_not_allowed", 409);
      if (status === "lost") return apiV1Error("lost_already", 409);
      return null;

    case "mark_found":
      if (deceased) return apiV1Error("event_not_allowed", 409);
      return null;

    case "report_last_seen":
    case "reactivate_search":
      // A deceased animal is not `lost` — `pets.status` is one enum — so it
      // falls out here with the honest answer rather than through a second code.
      if (status !== "lost") return apiV1Error("pet_not_lost", 409);
      return null;

    case "set_disclosure":
      // NO situation gate at all, matching the web: `setPetDisclosurePrefs` has
      // no status check and its action accepts a non-alive animal. An owner
      // whose animal came home still gets to decide what a future search would
      // publish about them.
      return null;

    case "report_content":
      // NO situation gate either, and for a sharper reason than the preference
      // above. Every other command here asks something OF the animal's state;
      // this one objects to a sentence a stranger wrote. Gating it on `lost`
      // would mean an owner who marked their animal found can no longer take
      // down a message they received during the search — and the message would
      // still be in the spine, and its address would still be overlaid onto the
      // public credential the next time the animal went missing. The guard that
      // matters is the TARGET's, and it lives in the writer: the row must belong
      // to this animal and be one of the two authored kinds.
      return null;

    default: {
      const unhandled: never = input;
      throw new Error(`Unhandled lost command: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** Dispatch to the writer for this command, then answer. */
async function dispatch(ctx: CommandContext, access: Exclude<PetHolderAccess, { kind: "none" }>) {
  const { input } = ctx;
  const pet = access.pet;
  const authorship: Authorship =
    access.kind === "org" ? (access.eventAuthorship as Authorship) : { ...OWNER_AUTHORSHIP };

  switch (input.command) {
    case "mark_lost":
      return markLost(ctx, pet, authorship, input);
    case "report_last_seen":
      return reportLastSeen(ctx, pet, authorship, input);
    case "mark_found":
      return markFound(ctx, pet, authorship);
    case "set_disclosure":
      return setDisclosure(pet, input);
    case "reactivate_search":
      return reactivate(ctx, pet);
    case "report_content":
      return reportContent(ctx, pet, authorship, input);
  }
}

/** The acknowledgement every command answers with. */
function ack(command: LostCommandInput["command"], status: LostPetStatus, changed: boolean) {
  const payload: LostCommandAckV1 = { command, status, changed };
  return apiV1Json(payload, { status: 200 });
}

function makeTransaction() {
  return async <T>(cb: (tx: unknown) => Promise<T>) =>
    db.transaction(cb as Parameters<typeof db.transaction>[0]) as Promise<T>;
}

/** `pets` rows are typed by Drizzle; only these fields are read here. */
type PetRow = Exclude<PetHolderAccess, { kind: "none" }>["pet"];

/**
 * MARCAR PERDIDA — the one command that opens a case and fans out.
 *
 * The five disclosure toggles are REQUIRED by the contract rather than
 * optional, and that mirrors `parseDisclosurePrefsFromForm`'s fail-closed rule
 * exactly: a web form that omits the section entirely gets five `false`s rather
 * than inheriting the pet row's current values, because "section absent" means
 * no consent was expressed. A JSON client with optional fields would reach the
 * same writer through a door that inherits silently.
 */
async function markLost(
  ctx: CommandContext,
  pet: PetRow,
  eventAuthorship: Authorship,
  input: Extract<LostCommandInput, { command: "mark_lost" }>,
) {
  const { broadcastLostPet } = await import("@/lib/infra/lost-pet-broadcast");

  // ===================================================================
  // WHERE IT WAS LOST, CANONICALISED — the case is routed on this.
  // ===================================================================
  // The contract already refused a partial trio, so these three are all present
  // or all absent, and absent means "no lo sé": `setPetLostWriter` then falls
  // back to the animal's home jurisdiction, which is what every caller got
  // before this block existed.
  //
  // `locality: "strict"`, the same choice `appendBite` made and for the same
  // reason: the app picked from the INDEC catalogue, so the (province, locality)
  // pair can be VERIFIED, and a client that invents a locality is refused with a
  // 400 instead of writing a place that does not exist into a record a sanitary
  // authority acts on. The web's own `setPetLostAction` still normalises with
  // `locality: "none"` because a reverse-geocoded string is all a map pin gives
  // it — the divergence is deliberate and in the safe direction.
  let eventProvince: string | null = null;
  let eventLocality: string | null = null;
  if (input.provinceCode !== null) {
    try {
      const normalised = await normalizeLocationForWrite(
        {
          provinceCode: input.provinceCode,
          // The CODE is what a client may assert; the display name is the
          // catalogue's to decide.
          province: null,
          locality: input.localityName,
          localityIndecId: input.localityIndecId,
          // The pin is a separate field on this command and travels on its own.
          lat: null,
          lng: null,
          address: null,
        },
        { locality: "strict" },
      );
      eventProvince = normalised.province;
      eventLocality = normalised.locality;
    } catch {
      // `strict` throws on a pair the catalogue does not hold. That is a request
      // problem rather than a fact about the animal, so it is a 400 and not one
      // of the 409s.
      return apiV1Error("invalid_request", 400);
    }
  }

  const result = await setPetLostWriter(
    {
      petId: pet.id,
      petPublicToken: pet.publicToken,
      petName: pet.name,
      petStatus: pet.status,
      petSpecies: pet.species,
      petBreed: pet.breed,
      petColor: pet.color,
      petJurisdictionProvince: pet.jurisdictionProvince,
      petJurisdictionLocality: pet.jurisdictionLocality,
      ownerUserId: ctx.userId,
      // The web passes an empty string too: the broadcast copy names the ANIMAL,
      // not the person looking for it.
      ownerDisplayName: "",
      fromStatus: pet.status,
      recordedByUserId: ctx.userId,
      eventAuthorship: eventAuthorship as unknown as Record<string, unknown>,
      locationDescription: input.locationDescription,
      // STRINGS, because that is what `writePoint` parses and what the web's own
      // action hands over — the schema already held them to a real range.
      locationLat: input.locationLat == null ? null : String(input.locationLat),
      locationLng: input.locationLng == null ? null : String(input.locationLng),
      // Null when the person did not say, and the writer's fallback to the
      // animal's home jurisdiction is the defined behaviour for that.
      eventJurisdictionProvince: eventProvince,
      eventJurisdictionLocality: eventLocality,
      reason: input.reason,
      disclosurePrefs: input.disclosure,
      enrichedDescription: input.enrichedDescription ?? null,
    },
    {
      repo: new EventsRepository(),
      transaction: makeTransaction(),
      broadcastLostPet: broadcastLostPet as Parameters<
        typeof setPetLostWriter
      >[1]["broadcastLostPet"],
    },
  );

  if (result.error !== null) {
    // ONE string arm, and exactly ONE value in it a client can act on. The
    // status refusals were decided above, before the write; what is left is a
    // malformed retroactive chip — which the writer answers as a CODE and not as
    // prose, so this is a comparison and not a match against a sentence.
    if (result.error === INVALID_CHIP) return apiV1Error("lost_microchip_invalid", 400);
    reportError("api-v1-lost", new Error(result.error), { userId: ctx.userId });
    return apiV1Error("lost_failed", 500);
  }

  // Never `false`: the writer refuses an animal already lost and this endpoint
  // refused it earlier, so a success here always opened something.
  return ack("mark_lost", "lost", true);
}

/**
 * ACTUALIZAR EL AVISTAJE — the only command that appends.
 *
 * NOT a `lost → lost` status change, which is why it does not call
 * `setPetLostWriter` again: the original `status_changed` is the immutable
 * record of when the search opened, and this is a new fact layered on top. It
 * emits the SAME `note_added(kind: "sighting")` shape an anonymous finder's
 * report does, scoped to the open episode, so it counts toward the episode's
 * sighting total and appears in the feed for free.
 */
async function reportLastSeen(
  ctx: CommandContext,
  pet: PetRow,
  eventAuthorship: Authorship,
  input: Extract<LostCommandInput, { command: "report_last_seen" }>,
) {
  // THE OPEN EPISODE, probed here so the refusal carries a code a client can
  // act on — "reactivate, then update" — and probed AGAIN inside the use-case,
  // where it belongs. The page the web renders has the same race: the
  // stale-case cron can close the episode between the render and the submit.
  let openCase: Awaited<ReturnType<typeof findOpenCaseForPetAndKind>>;
  try {
    openCase = await withDbBudgetOrThrow(
      findOpenCaseForPetAndKind(pet.id, "lost_pet_episode"),
      RESOLVE_BUDGET_MS,
      "api-v1-lost-case",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!openCase) return apiV1Error("lost_episode_closed", 409);

  // THE WEB'S OWN NORMALIZER, called with the same options
  // (`locality: "none"` — this flow does not resolve against the INDEC catalog,
  // and coordinates are optional because a text-only update is a real thing to
  // want). Running it rather than trusting the schema is what keeps the two
  // doors on one coordinate rule.
  let normalized: Awaited<ReturnType<typeof normalizeLocationForWrite>>;
  try {
    normalized = await normalizeLocationForWrite(
      {
        province: null,
        provinceCode: null,
        locality: null,
        localityIndecId: null,
        lat: input.locationLat ?? null,
        lng: input.locationLng ?? null,
        address: input.locationDescription,
      },
      { locality: "none" },
    );
  } catch (err) {
    // The contract already refused an out-of-range pair, so this is the
    // backstop. It answers `invalid_request` because a coordinate the schema
    // accepted and the normalizer did not is a disagreement between two
    // versions of one rule, not a fact about the animal.
    if (err instanceof CoordError) return apiV1Error("invalid_request", 400);
    throw err;
  }

  // The web composes ONE `text` out of the address and the note, because
  // `note_added` has a single required `text` field. The address ALSO travels
  // separately as `location_description`, which is what the read model overlays
  // as the episode's place name.
  const text = [input.locationDescription, input.note].filter(Boolean).join(" — ") || null;

  const result = await updateLostLastSeen(
    {
      petId: pet.id,
      petStatus: pet.status,
      recordedByUserId: ctx.userId,
      eventAuthorship,
      text,
      locationDescription: input.locationDescription,
      locationLat: normalized.lat != null ? String(normalized.lat) : null,
      locationLng: normalized.lng != null ? String(normalized.lng) : null,
      clientIdempotencyKey: ctx.idempotencyKey,
    },
    { repo: new EventsRepository(), transaction: makeTransaction() },
  );

  if (result.error !== null) {
    reportError("api-v1-lost", new Error(result.error), { userId: ctx.userId });
    return apiV1Error("lost_failed", 500);
  }

  // A replay answers 200 with `changed: false`: the sighting the caller asked
  // for exists and nothing was appended twice.
  return ack("report_last_seen", "lost", !result.wasDuplicate);
}

/**
 * MARCAR ENCONTRADA — closes the episode and tells everyone who was looking.
 *
 * BOTH AUDIENCE READS ARE SHARED with the web action rather than re-typed: the
 * titular's own id for the second-person confirmation, and the audience of the
 * original broadcast so the resolution notice reaches exactly the people who
 * were asked to look.
 */
async function markFound(ctx: CommandContext, pet: PetRow, eventAuthorship: Authorship) {
  let ownerUserId: string;
  try {
    ownerUserId = await withDbBudgetOrThrow(
      resolveFoundConfirmationRecipient(pet.id, ctx.userId),
      RESOLVE_BUDGET_MS,
      "api-v1-lost-owner",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  const result = await setPetFound(
    {
      petId: pet.id,
      petStatus: pet.status,
      petPublicToken: pet.publicToken,
      petName: pet.name,
      petSex: pet.sex,
      recordedByUserId: ctx.userId,
      ownerUserId,
      eventAuthorship,
    },
    {
      repo: new EventsRepository(),
      transaction: makeTransaction(),
      findBroadcastRecipientUserIds,
      flushNotifications,
    },
  );

  return ack("mark_found", "active", !result.alreadyActive);
}

/**
 * PREFERENCIAS DE DIVULGACIÓN — one key at a time, exactly as the web toggles.
 *
 * ONE KEY AND NOT A PATCH OBJECT, deliberately. `setPetDisclosurePrefsAction`
 * takes one key and one boolean, and a bulk shape here would be a second write
 * path with its own partial-failure question ("three of six applied — is that a
 * success?") that the web has never had to answer.
 */
async function setDisclosure(
  pet: PetRow,
  input: Extract<LostCommandInput, { command: "set_disclosure" }>,
) {
  const changed = await setPetDisclosurePrefs(pet.id, pet.publicToken, input.key, input.value);
  return ack("set_disclosure", pet.status as LostPetStatus, changed);
}

/**
 * REPORTAR UN MENSAJE DEL FEED — the command with no web action behind it.
 *
 * THE GUARD IS THE HOLDER GUARD, NARROWED ONCE. `resolvePetHolderAccess` ran at
 * the top of `runLostCommand` and admits exactly the callers the web's
 * `requirePetAccess` admits; `checkCommandGuard` then refuses the ORG PATH for
 * this command, and its comment carries the reasoning at length. The short
 * version: the hide is pet-global by design, so an org holding
 * `shelter_custody` could have made a finder's "tengo a tu perro" vanish from
 * the owner's own cockpit. A caretaker keeps it — the titular invited them.
 *
 * THE HIDE IS PET-GLOBAL, IRREVERSIBLE AND HAS NO "HIDDEN ITEMS" VIEW, and that
 * is stated here rather than discovered later. Reporting is not a per-viewer
 * mute: the item leaves the record for everyone who reads it. There is no
 * un-report — the correction path is a future read rule, because the spine
 * cannot be edited. A titular and their caretaker can each hide from the other,
 * and neither is told. That is an accepted cost of the item-level model, not an
 * oversight, and it is why the ORG path — the one actor with a custody motive —
 * is the one refused.
 *
 * "REPORTAR" AND NEVER "DENUNCIAR", in every string a person reads. In this
 * product `denuncia` already names a Ley 14.346 animal-cruelty complaint — nine
 * kinds, four severities, routed to a real authority, `src/modules/welfare/**`.
 * Borrowing the word for content moderation would promise a legal proceeding
 * where there is a hidden message.
 *
 * NO `Idempotency-Key`. The writer is idempotent on the state — an item already
 * reported is not reported twice — so this answers `changed: false` rather than
 * appending a second identical objection. See the endpoint header's taxonomy:
 * the split is the state, not the append.
 */
async function reportContent(
  ctx: CommandContext,
  pet: PetRow,
  eventAuthorship: Authorship,
  input: Extract<LostCommandInput, { command: "report_content" }>,
) {
  const result = await reportLostFeedItem(
    {
      petId: pet.id,
      targetEventId: input.targetEventId,
      category: input.category,
      reason: input.reason,
      recordedByUserId: ctx.userId,
      eventAuthorship,
    },
    { repo: new EventsRepository(), transaction: makeTransaction() },
  );

  // ONE refusal arm, and it is a 400 with its own code rather than a 404: on
  // this surface 404 means "this animal is not yours", and a client that got one
  // here would navigate somebody away from a search that is running fine. The
  // contract's `lost_report_target_invalid` docblock carries the rest, including
  // why the three ways to be invalid answer identically.
  if (result.error === "TARGET_INVALID") return apiV1Error("lost_report_target_invalid", 400);

  return ack("report_content", pet.status as LostPetStatus, !result.alreadyReported);
}

/**
 * REACTIVAR LA BÚSQUEDA — the carve-out for a search the cron closed.
 *
 * NO EVENT AND NO STATUS WRITE: `pets.status` is already `lost`, and there is
 * nothing to change. It opens a fresh `lost_pet_episode`, and it refuses to open
 * a second one when the anti-race probe finds one already open — a
 * `lost_pet_episode` has no reopen path, so duplicate opens would fork the
 * search into two untracked cases.
 */
async function reactivate(ctx: CommandContext, pet: PetRow) {
  const result = await reactivateLostSearch({
    petId: pet.id,
    petPublicToken: pet.publicToken,
    petStatus: pet.status,
    jurisdictionProvince: pet.jurisdictionProvince,
    jurisdictionLocality: pet.jurisdictionLocality,
    openedByUserId: ctx.userId,
  });

  if (!result.ok) {
    // The one failure arm is "not lost", which `checkSituation` already refused
    // with its own code. Reaching here means the status changed underneath us.
    return apiV1Error("pet_not_lost", 409);
  }

  return ack("reactivate_search", "lost", !result.alreadyOpen);
}

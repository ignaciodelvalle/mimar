// Client-input contract for LOST MODE —
// `POST /api/v1/pets/{publicToken}/lost`.
//
// NOT ASIENTOS, AND THAT IS WHY THEY ARE NOT ON THE EVENTS ENDPOINT. Every kind
// behind `POST .../events` appends one row and answers with its id. These are
// FEATURE COMMANDS: they move `pets.status`, open and close a case, publish
// or unpublish an owner's own contact details, fan an alert out to the
// organizations in a jurisdiction, and take a stranger's message off the
// owner's own feed. `writers.ts` says so in its exclusion list, and this file is
// the other half of that sentence.
//
// ONE ENDPOINT, SIX COMMANDS, for the same reason the events endpoint has one
// URL and eleven kinds: six sibling URLs would be six copies of one bearer
// check, one limiter pair and one access guard, kept in agreement by hand.
//
// THE REFERENCE POINT is the web's own actions, field for field:
//   · `setPetLostAction`          `src/modules/events/actions.ts:845`
//   · `updateLostLastSeenAction`  `src/modules/events/actions.ts:935`
//   · `setPetFoundAction`         `src/modules/events/actions.ts:999`
//   · `setPetDisclosurePrefsAction` `app/actions/lost-mode.ts:15`
//   · `reactivateLostSearchAction`  `app/actions/reactivate-lost-search.ts:12`
// Every name below is the name that action reads out of its `FormData`, and
// every limit below is that action's limit.
//
// FIVE OF THE SIX, THAT IS. `report_content` has no web counterpart to mirror:
// it is new on this surface, it exists because a Google Play content-rating
// declaration says this app has it, and its own docblock below carries the
// reasoning the other five take from the action they copy.
//
// IDEMPOTENCY IS NOT UNIFORM, and the endpoint does not pretend otherwise. The
// split is "is this writer idempotent on the STATE" and NOT "does it append" —
// two of the six append and only one of the two needs a header.
//   · `report_last_seen` writes a `note_added` onto an append-only spine and its
//     use-case takes a `clientIdempotencyKey`; two sightings minutes apart are
//     two facts, so it requires an `Idempotency-Key` header and honours it.
//   · The other five are idempotent on the state itself: marking lost an animal
//     already lost is refused, marking found one already active writes nothing,
//     reactivating with an open episode returns that episode, setting a
//     preference to the value it already holds is a no-op, and reporting an item
//     already reported appends nothing because it is not a second fact.
// Demanding a header those five could not honour is the false promise
// `writers.ts` refuses to make for atestación PPP and embarazo.
//
// WHAT IS NOT HERE, AND WHY:
//   · `publicToken` — a PATH segment. A body naming it too would be a second
//     source for one identity.
//   · THE POSTER. `/mis-mascotas/{token}/cartel` is a React Server Component
//     that resolves the TITULAR's name and phone with its own `role = 'owner'`
//     query, filters them through the disclosure preferences, and renders a QR
//     generated server-side. None of it is exposed as JSON, and a native client
//     that rebuilt it would be re-implementing a privacy filter. Out of scope
//     until it has an endpoint of its own.
//   · THE FINDER FLOWS (`/p/{token}/encontre`, `/p/{token}/sighting`). Those are
//     the PUBLIC face, for a stranger holding the animal. This surface is the
//     owner's.

import { z } from "zod";

import { CONTENT_REPORT_CATEGORIES } from "../events/event-types.ts";

/**
 * The five disclosure toggles `setPetLostWriter` snapshots when an episode
 * opens, in the order the web's own wizard presents them.
 *
 * ALL FIVE ARE REQUIRED on `mark_lost`, and that is deliberate rather than
 * strict. `parseDisclosurePrefsFromForm` FAILS CLOSED — a form that omits the
 * section entirely gets five `false`s rather than inheriting whatever the pet
 * row already held — because "section absent" means no consent was expressed.
 * A JSON client with optional fields would reach the same writer through a
 * different door and inherit silently, which is the one direction this must not
 * drift in. Making them required means a client cannot ask for the ambiguity.
 */
export const LOST_DISCLOSURE_KEYS = [
  "discloseFirstNameWhenLost",
  "disclosePhoneWhenLost",
  "discloseEmailWhenLost",
  "discloseLastLocationWhenLost",
  "allowFinderFormWhenLost",
] as const;
export type LostDisclosureKey = (typeof LOST_DISCLOSURE_KEYS)[number];

/**
 * Every preference `set_disclosure` may flip — the five above plus the one the
 * wizard does not offer.
 *
 * `discloseCaretakerContactWhenLost` is KEY 1 of a TWO-KEY model
 * (`pets.disclose_caretaker_contact_when_lost`, migration 0193): the caretaker
 * consents at invitation accept (key 2), and the titular decides whether to
 * actually publish (key 1). It is therefore TITULAR-ONLY on the web, and the
 * server enforces that — see `TITULAR_ONLY_DISCLOSURE_KEYS` below and the guard
 * this contract cannot express, because whether a caller is the titular is the
 * server's answer and not a shape.
 */
export const DISCLOSURE_KEYS = [
  ...LOST_DISCLOSURE_KEYS,
  "discloseCaretakerContactWhenLost",
] as const;
export type DisclosureKey = (typeof DISCLOSURE_KEYS)[number];

/**
 * The preferences a CARETAKER must not write, mirrored from
 * `src/modules/pets/application/lost-mode/disclosure-scope.ts`.
 *
 * Carried in the contract so a client can HIDE the row rather than offer a
 * toggle that answers 403 — the same reason the read payload reports it. It is
 * an affordance hint and NOT the rule: the rule is `requireTitularAccess`, it
 * runs on the server, and a client that ignored this list would still be
 * refused.
 */
export const TITULAR_ONLY_DISCLOSURE_KEYS = ["discloseCaretakerContactWhenLost"] as const;
export type TitularOnlyDisclosureKey = (typeof TITULAR_ONLY_DISCLOSURE_KEYS)[number];

export const LOST_COMMAND_INPUT_CODES = [
  "COMMAND_REQUIRED",
  "DISCLOSURE_REQUIRED",
  "DISCLOSURE_KEY_INVALID",
  "DISCLOSURE_VALUE_REQUIRED",
  "COORDS_INVALID",
  "COORDS_OUT_OF_RANGE",
  "COORDS_INCOMPLETE",
  "LOST_JURISDICTION_INCOMPLETE",
  "REPORT_TARGET_REQUIRED",
  "REPORT_CATEGORY_INVALID",
  "REPORT_REASON_TOO_LONG",
] as const;
export type LostCommandInputCode = (typeof LOST_COMMAND_INPUT_CODES)[number];

/** An optional free-text field: absent, blank and `null` all mean "not stated". */
const optionalText = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v ? v : null));

/**
 * A latitude/longitude pair, or nothing.
 *
 * BOTH OR NEITHER, which is the web's own rule read literally:
 * `setPetLostAction` validates only `if (locationLatRaw && locationLngRaw)`, so
 * a half pair reaches `writePoint` and is silently discarded. A JSON client can
 * send a half pair by mistake in a way a map widget cannot, so this refuses it
 * rather than dropping half a fact on the floor — narrower than the web, in the
 * direction where being wrong is visible.
 *
 * The RANGE is the web's too, from the STEP 3 hardening that added it after
 * `Number.isFinite` alone let an out-of-range pin through.
 */
const coords = {
  // THE CODE LIVES ON THE FIELD, not in the refinement below, because zod's own
  // `z.number()` refuses `NaN` and `Infinity` as an INVALID TYPE — before any
  // refinement runs. A `Number.isFinite` check in `refineCoords` would be dead
  // code, and without the `error` here the refusal would carry zod's own message
  // and reach a client as "a field the app could not interpret".
  locationLat: z.number({ error: "COORDS_INVALID" }).nullish(),
  locationLng: z.number({ error: "COORDS_INVALID" }).nullish(),
};

function refineCoords(
  input: { locationLat?: number | null; locationLng?: number | null },
  ctx: z.RefinementCtx,
) {
  const lat = input.locationLat;
  const lng = input.locationLng;
  const hasLat = lat !== null && lat !== undefined;
  const hasLng = lng !== null && lng !== undefined;

  if (hasLat !== hasLng) {
    ctx.addIssue({ code: "custom", message: "COORDS_INCOMPLETE", path: ["locationLat"] });
    return;
  }
  if (!hasLat || !hasLng) return;

  // Both are FINITE numbers by the time a refinement sees them — see the note on
  // the fields — so this is only the range, which is the web's own STEP 3 check.
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    ctx.addIssue({ code: "custom", message: "COORDS_OUT_OF_RANGE", path: ["locationLat"] });
  }
}

/**
 * WHERE THE ANIMAL WENT MISSING — the jurisdiction of the EVENT, not the pet's.
 *
 * A dog that disappears in Córdoba while registered in CABA is Córdoba's
 * problem. `set-pet-lost-use-case` opens the `lost_pet_episode` case with a
 * jurisdiction, and until 2026-09-11 it had only one to give: the ANIMAL's home
 * one, copied from `pets.jurisdiction_*`. Every lost case in the system
 * therefore claims to have happened where the animal lives, and the alert
 * fan-out went to the same place.
 *
 * WHAT IT REACHES IS THE CASE AND THE ALERTS, not the lost listings: those
 * scope on the pet's own columns (`dashboards/perdidas.ts`,
 * `lost-listing-read.ts`). An earlier version of this note claimed otherwise
 * without checking. See the writer's own docblock for the full measurement.
 *
 * That is the same defect the bite work unit settled for `record-event`, and
 * these are the same three fields it introduced, for the same reasons:
 * a province CODE (what a client may assert), a locality NAME, and the INDEC id
 * that separates the 68 (province, name) collisions the catalogue ships. The
 * server canonicalises them; the display name is the catalogue's to decide.
 *
 * ABSENT IS A VALID ANSWER and means "no lo sé" — the writer's fall back to the
 * animal's home jurisdiction is the defined behaviour for it, and a person
 * marking a pet lost in a panic must not be stopped by a form field.
 */
const eventJurisdiction = {
  /** ISO 3166-2 (`"AR-X"`). The server canonicalises to the stored display name. */
  provinceCode: optionalText,
  localityName: optionalText,
  /** Disambiguates the 68 (province, name) collisions the INDEC catalogue ships. */
  localityIndecId: optionalText,
};

/**
 * THE THREE JURISDICTION FIELDS TRAVEL TOGETHER OR NOT AT ALL.
 *
 * Any proper subset produces a place that does not exist, because the writer
 * falls back to the animal's home jurisdiction FIELD BY FIELD: a province with
 * no locality routes the case to (new province, pet's locality) — a pair naming
 * nowhere, on a record an authority acts on, and nothing downstream would
 * notice. `refineBite` in `record-event.ts` refuses the identical shape for the
 * identical reason; this is that rule, for this command.
 *
 * ITS OWN FUNCTION rather than three more branches inside `refineCoords`: that
 * one answers a different question (is this point real?) and merging them would
 * make a single refinement that fails for two unrelated causes.
 */
function refineEventJurisdiction(
  input: {
    provinceCode?: string | null;
    localityName?: string | null;
    localityIndecId?: string | null;
  },
  ctx: z.RefinementCtx,
): void {
  const given = [input.provinceCode, input.localityName, input.localityIndecId].filter(
    (value) => value !== null && value !== undefined,
  ).length;
  if (given !== 0 && given !== 3) {
    ctx.addIssue({
      code: "custom",
      message: "LOST_JURISDICTION_INCOMPLETE",
      path: ["localityName"],
    });
  }
}

/**
 * The incident snapshot the web's wizard collects on its later steps.
 *
 * OPTIONAL AS A WHOLE and optional field by field, exactly as
 * `parseEnrichedDescriptionFromForm` reads it: the wizard lets a person mark an
 * animal lost in one tap and fill the description in afterwards, and a contract
 * that required any of it would make the fast path impossible.
 *
 * `microchipId` and the tattoo fields are RETROACTIVE IDENTIFIERS — the writer
 * only records them when the animal has no active canonical identifier of that
 * kind, and it validates the chip's format BEFORE opening its transaction. A
 * malformed one is refused with its own code rather than silently dropped.
 */
const enrichedDescription = z.object({
  color: optionalText,
  distinguishingFeatures: optionalText,
  accessoriesWhenLost: optionalText,
  behaviorNotes: optionalText,
  lastSeenContext: optionalText,
  microchipId: optionalText,
  tattooCode: optionalText,
  tattooLocation: optionalText,
  tattooDescription: optionalText,
});

const markLost = z
  .object({
    command: z.literal("mark_lost"),
    /** The web's `locationAddress` — where the animal was last seen, in words. */
    locationDescription: optionalText,
    ...coords,
    ...eventJurisdiction,
    /** The web's `reason` — the owner's own note about the disappearance. */
    reason: optionalText,
    disclosure: z.object(
      {
        discloseFirstNameWhenLost: z.boolean({ error: "DISCLOSURE_REQUIRED" }),
        disclosePhoneWhenLost: z.boolean({ error: "DISCLOSURE_REQUIRED" }),
        discloseEmailWhenLost: z.boolean({ error: "DISCLOSURE_REQUIRED" }),
        discloseLastLocationWhenLost: z.boolean({ error: "DISCLOSURE_REQUIRED" }),
        allowFinderFormWhenLost: z.boolean({ error: "DISCLOSURE_REQUIRED" }),
      },
      { error: "DISCLOSURE_REQUIRED" },
    ),
    enrichedDescription: enrichedDescription.nullish(),
  })
  .superRefine(refineCoords)
  .superRefine(refineEventJurisdiction);

const reportLastSeen = z
  .object({
    command: z.literal("report_last_seen"),
    locationDescription: optionalText,
    ...coords,
    // NO JURISDICTION HERE, and the omission is deliberate rather than an
    // oversight to be corrected later. A sighting appends a `note_added` to the
    // spine (`updateLostLastSeen`); it opens no case and routes nothing, so the
    // three fields would be contract surface no writer reads — which is how a
    // schema starts lying about what the system does. When a sighting learns to
    // move the case's jurisdiction, that is the work unit that adds them.
    /** The web's `reason` field on `UpdateLastSeenForm` — a free-text note. */
    note: optionalText,
  })
  .superRefine(refineCoords);

const markFound = z.object({ command: z.literal("mark_found") });

const setDisclosure = z.object({
  command: z.literal("set_disclosure"),
  key: z.enum(DISCLOSURE_KEYS, { error: "DISCLOSURE_KEY_INVALID" }),
  value: z.boolean({ error: "DISCLOSURE_VALUE_REQUIRED" }),
});

const reactivateSearch = z.object({ command: z.literal("reactivate_search") });

/**
 * REPORTAR UN MENSAJE DEL FEED — the sixth command, and the only one with no
 * counterpart on the web's own actions.
 *
 * WHY IT EXISTS. Google Play's IARC questionnaire declares this app as one where
 * users interact and CONTENT CAN BE REPORTED. A declaration describes the app as
 * published, so the affordance ships or the declaration is false.
 *
 * WHY "REPORT" AND NOT "BLOCK". Two of the three feed kinds are written by
 * ANONYMOUS members of the public — somebody who scanned a QR in the street and
 * typed into a form. There is no account behind them, so "block this user" has no
 * subject to name. The only honest analogue would be a valve that stops the pet
 * accepting reports at all, and a valve is a defence nobody uses when they need
 * it most: an owner searching for their animal will not close the channel the
 * message that finds it might arrive through. Reporting ONE item and having it
 * disappear is the protection that gets used.
 *
 * WHAT IT DOES TO THE SPINE: NOTHING TO THE REPORTED ROW. The command appends a
 * `content_reported` event naming the target; every read of the feed subtracts
 * the named ids. The message and the objection to it are both facts and both
 * survive — see `lib/infra/lost-mode.ts::notReportedClause`.
 *
 * NO `Idempotency-Key`, AND THAT IS THE STATE RULE AND NOT AN EXEMPTION FOR AN
 * APPEND. This file's header splits the commands by whether their writer is
 * idempotent on the STATE; `report_last_seen` needs a key because two sightings
 * minutes apart are two facts. Reporting the same item twice is not two facts,
 * so the writer probes for an existing report on the same target and appends
 * nothing — answering `changed: false`, exactly like `set_disclosure` set to the
 * value it already holds. The taxonomy is "idempotent on the state or not",
 * never "appends or not".
 *
 * A `scan` CANNOT BE REPORTED and the contract says so by construction: the
 * target must resolve, server-side, to a `note_added` of one of the two authored
 * kinds. A QR read has no author and no text — there is nothing to have written
 * wrongly.
 */
const reportContent = z.object({
  command: z.literal("report_content"),
  /**
   * The feed item's `id` — which is a `pet_events.id`, the same value
   * `LostFeedItemV1` carries. A client never constructs one; it echoes the id of
   * the row the person tapped.
   */
  targetEventId: z.uuid({ error: "REPORT_TARGET_REQUIRED" }),
  category: z.enum(CONTENT_REPORT_CATEGORIES, { error: "REPORT_CATEGORY_INVALID" }),
  /**
   * The reporter's own words, optional.
   *
   * 500 is the STORED limit — `content_reported`'s payload schema refuses more —
   * restated here so a person is told before they send rather than after. It is
   * the only field on this command where the two schemas could drift, so the
   * number appears twice with this sentence attached to both.
   */
  reason: z
    .string()
    .trim()
    .max(500, { error: "REPORT_REASON_TOO_LONG" })
    .nullish()
    .transform((v) => (v ? v : null)),
});

export const lostCommandInputSchema = z.discriminatedUnion("command", [
  markLost,
  reportLastSeen,
  markFound,
  setDisclosure,
  reactivateSearch,
  reportContent,
]);

export type LostCommandInput = z.infer<typeof lostCommandInputSchema>;
export type LostCommand = LostCommandInput["command"];

/**
 * The FIRST input code in a failed parse, for a client that wants to show one
 * message. Mirrors `firstRecordEventInputCode` — same shape, same reason.
 */
export function firstLostCommandInputCode(error: z.ZodError<unknown>): LostCommandInputCode | null {
  for (const issue of error.issues) {
    const code = issue.message;
    if ((LOST_COMMAND_INPUT_CODES as readonly string[]).includes(code)) {
      return code as LostCommandInputCode;
    }
  }
  for (const issue of error.issues) {
    if (issue.code === "invalid_union" || issue.path.length === 0 || issue.path[0] === "command") {
      return "COMMAND_REQUIRED";
    }
  }
  return null;
}

// The four adoption payloads: the catalogue, one ficha, the apply ack, and the
// applicant's own list.
//
// WHAT THIS SURFACE IS, AND WHY ITS PRIVACY RULES ARE NOT THE OTHERS'
// ---------------------------------------------------------------------------
// Every other read on `/api/v1` answers a question about the CALLER's own
// animal or the caller's own account. These three reads answer a question about
// SOMEBODY ELSE'S animal, published deliberately by an organization that wants
// it seen. That inverts the default: the fields below are not withheld unless
// there is a reason, they are included only because the web already publishes
// them at `/adoptar` to a visitor with no account at all.
//
// The list is therefore a MIRROR and not a design. Three consequences, each of
// which has already cost this repo something on the web side:
//
//   · NO INTERNAL IDENTIFIERS. `queryAdoptionListing` selects `pets.id` and
//     `organizations.id` because the SQL needs them; they do not go on the wire.
//     A public token is the name of a pet on every public surface, and a UUID on
//     a wire is a UUID in a log, a crash report and a screenshot.
//   · NO CANONICAL MICROCHIP. `hasMicrochip` is a BOOLEAN and the 15-digit code
//     never reaches this payload — PO-1 (2026-08-05) took the masked form off
//     the public ficha for exactly this reason, and an app payload is a cheaper
//     place to leak it than an HTML page.
//   · NO LIBRETA. The health rollup is three booleans. "El detalle clínico
//     completo se comparte al finalizar la adopción" is the web's own sentence
//     and it is a rule, not copy.
//
// THE LABELS ARE COMPUTED ON THE SERVER, WHICH IS NOT THE USUAL DIRECTION
// ---------------------------------------------------------------------------
// `facts`, `sexLabel`, `speciesLabel` and `sterilizedLabel` arrive as es-AR
// STRINGS rather than as enum values a client would label for itself. That is
// deliberate and it is a scar: `ageBucketLabel(bucket, sex)`, `energyLabel(level,
// sex)` and `sterilizedLabel(sex)` all AGREE WITH THE ANIMAL'S GENDER, and the
// public ficha shipped "Castrada" over a male dog until 2026-08 because one of
// the three call sites had a hardcoded string. A second implementation of that
// agreement, in another language runtime, is that bug waiting to be rewritten.
//
// The raw enum values are ALSO carried wherever a client has to branch (filter
// chips, iconography). Labels for display, values for logic — never a client
// deriving Spanish from a value.
//
// THE CURSOR IS OPAQUE AND IT IS THE WEB'S OWN
// ---------------------------------------------------------------------------
// `nextCursor` is the exact string `/adoptar?cursor=` already carries in a
// public URL (`buildSearchParams` in `lib/infra/adoption-listing.ts`). It is
// echoed back verbatim and a client must not parse it: keeping the two doors on
// one encoding is what stops a keyset change breaking one of them silently, and
// it discloses nothing the "Mostrar más" link does not already publish.

import type { PetSex } from "../input/intake.ts";

// ---------------------------------------------------------------------------
// The catalogue — `GET /api/v1/adoptions`
// ---------------------------------------------------------------------------

export const ADOPTION_CATALOGUE_PAYLOAD_VERSION = 1;

/**
 * SIXTY SECONDS, and the ceiling comes from the WEB's own cache policy rather
 * than from what feels comfortable. `/adoptar` is `force-dynamic` with
 * `Cache-Control: no-store` stamped in middleware, and its page comment says
 * why: "so an adopted/unpublished pet drops off the public listing promptly".
 *
 * A native client cannot be handed `no-store` — it holds the payload in a
 * screen either way — so the honest translation is a short explicit expiry. A
 * minute is long enough that scrolling back does not re-fetch and short enough
 * that a card for an animal adopted this morning does not survive a coffee.
 */
export const ADOPTION_CATALOGUE_STALE_AFTER_MS = 60_000;

/** How many cards one page carries. The web's `/adoptar` grid asks for the same 24. */
export const ADOPTION_CATALOGUE_PAGE_SIZE = 24;

/**
 * One card. Everything on it is already rendered by `AdoptionListingCard` to a
 * visitor with no account.
 */
export type AdoptionCatalogueItemV1 = {
  /** `DIM-XXXX-XXXX`. The pet's name on every public surface. */
  petToken: string;
  name: string;
  /** Raw, for iconography. `speciesLabel` is the es-AR string. */
  species: string;
  speciesLabel: string;
  breed: string | null;
  sex: PetSex;
  sexLabel: string;
  color: string | null;
  /** Public bucket URL, or `null` when the shelter has uploaded no photo. */
  photoUrl: string | null;
  locality: string | null;
  province: string | null;
  /**
   * The chip row, ALREADY IN es-AR and already agreeing with `sex` — age
   * bucket, size, energy, in the web's order. Empty when the shelter filled in
   * none of the three.
   */
  facts: string[];
  goodWithKids: boolean | null;
  goodWithDogs: boolean | null;
  goodWithCats: boolean | null;
  needsYard: boolean | null;
  /** Presence of an active `microchip_iso`, never the code. See the header. */
  hasMicrochip: boolean;
  isSterilized: boolean;
  /** "Castrada"/"Castrado" — agrees with `sex`, computed once on the server. */
  sterilizedLabel: string;
  /** Pesos. `null` when the shelter asks for no contribution. */
  feeArs: number | null;
  orgToken: string;
  orgName: string;
  /**
   * The animal lives with its current family and the org accompanies the
   * search (rehome sponsorship). Decided on the spine by `livesWithFamilyUnder`
   * — never re-derived from the custody row, which also describes a decomiso.
   */
  livesWithFamily: boolean;
};

export type AdoptionCatalogueV1 = {
  payloadVersion: typeof ADOPTION_CATALOGUE_PAYLOAD_VERSION;
  issuedAt: string;
  staleAfter: string;
  items: AdoptionCatalogueItemV1[];
  /** Feed back as `?cursor=` for the next page. `null` means this is the last. */
  nextCursor: string | null;
};

// ---------------------------------------------------------------------------
// One ficha — `GET /api/v1/adoptions/{petToken}`
// ---------------------------------------------------------------------------

export const ADOPTION_DETAIL_PAYLOAD_VERSION = 1;

/** The catalogue's reasoning, for the same reason. */
export const ADOPTION_DETAIL_STALE_AFTER_MS = 60_000;

/**
 * WHY THIS IS A UNION AND NOT A NULLABLE FICHA.
 *
 * The web ficha has FOUR outcomes and only one of them is a page: a listed pet
 * renders, a pet adopted in the last seven days renders "¡ya encontró su
 * hogar!", a pet the org paused renders "no disponible por ahora", and anything
 * else is a hard 404. Those three non-404 answers exist because somebody
 * followed a shared link — that is the whole case they were written for (spec
 * D7.2) — and a client that flattened them into "not found" would tell a person
 * holding a WhatsApp link that the animal never existed.
 *
 * So the state is on the wire, and a 404 stays a 404: token does not resolve, or
 * resolves to a pet that was never listable, or was ERASED (art. 16 — an erased
 * pet answers like a token that never existed, and this surface must not be the
 * fifth place that forgets).
 */
export type AdoptionDetailStateV1 = "listed" | "recently_adopted" | "paused";

export type AdoptionDetailHealthV1 = {
  /** Presence of a `vaccination_administered` event. NOT "is up to date". */
  hasVaccinations: boolean;
  isSterilized: boolean;
  sterilizedLabel: string;
  hasMicrochip: boolean;
};

export type AdoptionDetailOrgV1 = {
  orgToken: string;
  name: string;
  /**
   * Where to write about this animal. When the animal lives with its family
   * this is the PET's locality (what the catalogue filters on); otherwise the
   * ORG's. The web makes the same swap and for the same reason.
   */
  locality: string | null;
  province: string | null;
  /** ISO date the custody row opened. `null` if the row carries none. */
  custodySince: string | null;
  livesWithFamily: boolean;
};

/**
 * The full ficha. Mirrors `/adoptar/{petToken}` field for field.
 *
 * `permanentConditions` IS GATED THE WAY THE WEB GATES IT: the array is empty
 * unless `pets.disclose_conditions_publicly` is true. That column is the owner's
 * answer to "may strangers read this", and a payload that carried the codes and
 * left the gating to a client would have moved the decision to whoever writes
 * the next screen.
 */
export type AdoptionDetailListedV1 = {
  state: "listed";
  petToken: string;
  name: string;
  species: string;
  speciesLabel: string;
  breed: string | null;
  sex: PetSex;
  sexLabel: string;
  color: string | null;
  distinguishingFeatures: string | null;
  /** Primary photo first, then up to four pet-scoped extras. Deduplicated. */
  photoUrls: string[];
  locality: string | null;
  province: string | null;
  facts: string[];
  story: string | null;
  requirements: string | null;
  goodWithKids: boolean | null;
  goodWithDogs: boolean | null;
  goodWithCats: boolean | null;
  needsYard: boolean | null;
  feeArs: number | null;
  health: AdoptionDetailHealthV1;
  /** es-AR labels, already resolved. Empty unless the owner disclosed them. */
  permanentConditions: string[];
  /** The owner's own words about a condition, when they wrote any. */
  permanentConditionsOther: string | null;
  org: AdoptionDetailOrgV1;
  /**
   * Whether THIS caller may open the apply form — false when they already have
   * an unresolved application for this animal, or when their account type
   * cannot adopt.
   *
   * REPORTED BY THE SERVER RATHER THAN COMPUTED BY THE CLIENT, which is the
   * rule `pets/{token}/profile` set for its two capability booleans: a client
   * must never draw a control the write would refuse. `applyBlockedReason` says
   * which of the two it is so the screen can say something true.
   */
  canApply: boolean;
  applyBlockedReason: AdoptionApplyBlockedReasonV1 | null;
};

/**
 * Why the apply button is not there.
 *
 * `already_applied` — an unresolved application by this caller for this pet.
 * `institutional_account` — admin and sanitary-authority accounts cannot adopt;
 *   the web renders a whole page saying so rather than a 403.
 */
export type AdoptionApplyBlockedReasonV1 = "already_applied" | "institutional_account";

export type AdoptionDetailClosedV1 = {
  state: "recently_adopted" | "paused";
  petToken: string;
  name: string;
  /** Present for `paused` (the org that paused it); `null` for the other. */
  orgName: string | null;
};

export type AdoptionDetailV1 = {
  payloadVersion: typeof ADOPTION_DETAIL_PAYLOAD_VERSION;
  issuedAt: string;
  staleAfter: string;
  detail: AdoptionDetailListedV1 | AdoptionDetailClosedV1;
};

// ---------------------------------------------------------------------------
// The write ack — `POST /api/v1/adoptions/{petToken}`
// ---------------------------------------------------------------------------

/**
 * The bare write payload, per §2 (a write is not a snapshot, so no envelope).
 *
 * `applicationId` is the id of the `adoption_application_submitted` event, and
 * it is the SAME id `/mis-mascotas/postulaciones?nueva=` highlights on the web
 * and the same one `MyAdoptionApplicationV1.applicationId` carries. One id, so a
 * client can scroll straight to the row it just created.
 */
export type AdoptionApplicationSubmittedV1 = { applicationId: string };

// ---------------------------------------------------------------------------
// Mis postulaciones — `GET /api/v1/me/adoption-applications`
// ---------------------------------------------------------------------------

export const MY_ADOPTION_APPLICATIONS_PAYLOAD_VERSION = 1;

/**
 * SIXTY SECONDS. The list changes when a shelter decides something, which is a
 * human on the other side of a queue rather than a timer — but the ONE thing a
 * stale copy must not do is keep offering "Retirar" on an application the org
 * already resolved, so the window stays short.
 */
export const MY_ADOPTION_APPLICATIONS_STALE_AFTER_MS = 60_000;

/**
 * The seven states the web derives, unchanged and in its vocabulary.
 *
 * `auto_rejected` is NOT `rejected`: it means the animal went to somebody else,
 * and the web says "encontró hogar con otra postulación" rather than "no
 * avanzó". Collapsing the two would tell a person they were turned down when
 * they were not.
 */
export type MyAdoptionApplicationStatusV1 =
  | "pending"
  | "info_requested"
  | "approved"
  | "finalized_to_me"
  | "auto_rejected"
  | "rejected"
  | "withdrawn";

/**
 * One of the caller's own applications.
 *
 * D17, ENFORCED ON THE WIRE: there is no field here for how many other people
 * applied, who they are, or where this one sits in a queue. The web page states
 * the rule ("at no point do we expose how many other applications exist for the
 * same pet, who else applied, or any queue position") and a payload is the
 * easiest place to break it by accident.
 */
export type MyAdoptionApplicationV1 = {
  applicationId: string;
  petToken: string;
  petName: string;
  orgName: string;
  orgToken: string;
  submittedAt: string;
  status: MyAdoptionApplicationStatusV1;
  /** When the shelter last moved it. `null` while nothing has happened. */
  decisionAt: string | null;
  /**
   * The animal is still listable, so a link to its ficha resolves. The web
   * hides the link when this is false rather than offering a 404.
   */
  stillListed: boolean;
};

export type MyAdoptionApplicationsV1 = {
  payloadVersion: typeof MY_ADOPTION_APPLICATIONS_PAYLOAD_VERSION;
  issuedAt: string;
  staleAfter: string;
  applications: MyAdoptionApplicationV1[];
  /**
   * The server caps the read at 100 rows, like the web's own query. `true` says
   * the cap was reached, so a client can say "las 100 más recientes" instead of
   * implying the list is complete.
   */
  truncated: boolean;
};

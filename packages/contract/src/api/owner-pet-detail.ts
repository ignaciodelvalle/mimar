// The wire shape of `GET /api/v1/pets/{publicToken}` — the OWNER face of a pet.
//
// TYPES ONLY plus two frozen literals, like every other file in this entry
// point. There is no request body, so there is no sibling in
// `@dim/contract/input`.
//
// WHAT THIS IS NOT
// ---------------------------------------------------------------------------
// It is NOT the public credential, and the difference is the whole reason it
// exists. `/api/v1/pets/{token}/credential` is anonymous and renders IDENTICALLY
// for the owner and for a stranger who scanned the QR — that is its job. This
// endpoint is what the person RESPONSIBLE for the animal sees: the alert strip,
// the compliance stamp, the reminders that are coming due, the arrangements the
// owner made. A client shows both; neither replaces the other.
//
// WHO MAY READ IT — the same rule the web page enforces, no wider. See the
// route header for the resolved semantics; in short it is every current HOLDER
// (owner, co-owner, foster, caretaker) plus any active member of an
// organization that currently holds the pet. It is NOT titular-only: the
// titular-only surfaces are a strict subset and stay behind `viewer.isTitular`.
//
// NO INTERNAL IDs, for the reason `PetRegisteredV1` states: this is the payload
// a stolen access token buys and a device caches to disk. No `petId`, no case
// ids, no ownership row ids. `publicToken` is the pet's identity everywhere a
// client operates. The one identifier that DOES cross is `reminderId`, because
// a reminder is a thing the owner acts on ("posponer 7 días", "registrar") and
// an actionable row a client cannot name is a row it cannot offer.

import type { PetSex } from "../input/intake.ts";
import type { CredentialSection, PublicPetStatus } from "./public-credential.ts";

/**
 * Bumped when a field changes meaning or leaves. A client compares this against
 * the version it was built for BEFORE trusting any field, exactly as it does
 * for the credential — see `apps/mobile/src/api/client.ts`.
 */
export const OWNER_PET_DETAIL_PAYLOAD_VERSION = 1;

/**
 * How long a client may present a cached copy as current.
 *
 * Same five minutes as the credential and `me/pets`. The owner face moves
 * faster than a credential (a reminder falls due, a case opens) but not fast
 * enough that a client should refetch on every glance; what matters is that the
 * number is IMPORTED rather than hard-coded on the client side.
 */
export const OWNER_PET_DETAIL_STALE_AFTER_MS = 5 * 60_000;

/**
 * The viewer's relationship to this animal, as the reader resolved it.
 *
 * This is the SAME vocabulary `ownerships.role` uses, narrowed to what a holder
 * can be, plus `org_member` for the organization path (which has no ownership
 * row of its own — the organization holds the pet, the person is a member).
 */
export const OWNER_PET_DETAIL_VIEWER_ROLES = [
  "owner",
  "co_owner",
  "foster",
  "caretaker",
  "org_member",
] as const;
export type OwnerPetDetailViewerRole = (typeof OWNER_PET_DETAIL_VIEWER_ROLES)[number];

/**
 * Who is reading, and what that buys them.
 *
 * `isTitular` is the gate every titular-only affordance hangs off. It is TRUE
 * only for `role: "owner"` — a foster or a caretaker holds the animal but does
 * not get to see who else the owner trusts with it, and an org member never
 * does. Carried as its own boolean rather than left for the client to derive
 * from `role`, so a client cannot get the derivation subtly wrong.
 *
 * A CO-OWNER IS FALSE HERE, and that is narrower than the repo's own
 * titular-only gate, where `co_owner` passes as owner-equivalent. It matches the
 * web face, which resolves its titular affordances from `ownershipRole ===
 * "owner"` and nothing else, so this flag is parity rather than policy. Said out
 * loud because the sentence above reads as an exhaustive list of who is excluded
 * and is not one: widening it is a product decision about co-ownership, and it
 * belongs in the same change on both surfaces or in neither.
 */
export type OwnerPetDetailViewer = {
  role: OwnerPetDetailViewerRole;
  isTitular: boolean;
};

// ---------------------------------------------------------------------------
// Identity + status
// ---------------------------------------------------------------------------

/** A hero chip — the locality, and the microchip tag when provenance allows. */
export type OwnerPetTagV1 = {
  key: string;
  label: string;
};

export type OwnerPetIdentitySection = {
  name: string;
  species: string;
  sex: PetSex | null;
  breed: string | null;
  /**
   * The composed one-liner the hero prints under the name — breed, sex, age and
   * species joined with "·". Composed SERVER-SIDE because the age term is a
   * relative computation ("2 años") whose inputs (date of birth, date of death)
   * a client would otherwise have to re-derive, and two implementations of "how
   * old is this animal" is one more than this product can keep in agreement.
   */
  breedLine: string;
  photoUrl: string | null;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  tags: OwnerPetTagV1[];
};

/** The In-Memoriam skin's data. Present only for a deceased animal. */
export type OwnerPetMemorialV1 = {
  birthYear: number | null;
  deathYear: number | null;
};

/**
 * The situation pill — "what this animal is going through", a separate axis
 * from compliance. Null when the situation is the default (`al-dia`), which is
 * what tells a client to render no pill at all rather than a green one.
 */
export type OwnerPetSituationV1 = {
  key: string;
  tone: string;
  icon: string;
  /** es-AR, already agreed with the animal's sex. */
  label: string;
};

export type OwnerPetStatusSection = {
  petStatus: PublicPetStatus;
  /** The hero ring state, mapped from status + compliance by the one shared mapper. */
  ringStatus: string;
  situation: OwnerPetSituationV1 | null;
  memorial: OwnerPetMemorialV1 | null;
  pregnancyStatus: string | null;
};

// ---------------------------------------------------------------------------
// The alert strip
// ---------------------------------------------------------------------------

/**
 * The alert strip is an ORDERED list, and the order is the product decision —
 * lost, then rabies observation, then tránsito, then caretaker, then rehome,
 * then open cases, then pregnancy. Urgency-ranked, and ranked SERVER-SIDE so
 * every client agrees; a client that sorts this list itself has reimplemented a
 * decision it cannot see the reasons for.
 *
 * Each entry names an alert and its tone. The DATA each alert needs lives in
 * its own section (`banners`, `cases`, `pregnancy`) rather than being inlined
 * here, so a client can render the strip's shape before it has decided how much
 * of each banner to draw.
 */
export const OWNER_PET_ALERT_IDS = [
  "lost",
  "rabies",
  "transit",
  "caretaker",
  "rehome",
  "open-cases",
  "pregnancy",
] as const;
export type OwnerPetAlertId = (typeof OWNER_PET_ALERT_IDS)[number];

export type OwnerPetAlertTone = "urgent" | "warning" | "info";

export type OwnerPetAlertV1 = {
  id: OwnerPetAlertId;
  tone: OwnerPetAlertTone;
};

export type OwnerPetAlertsSection = {
  /** Already in reading order. Empty means no strip, not a missing strip. */
  items: OwnerPetAlertV1[];
};

// ---------------------------------------------------------------------------
// The compliance stamp
// ---------------------------------------------------------------------------

export type OwnerPetComplianceTone = "ok" | "due" | "over" | "reserved" | "neutral";

/**
 * One obligation card, flattened onto the wire.
 *
 * The projection's optional fields become explicit `| null` here. An absent key
 * and a null value are the same thing to a JSON reader that got the payload
 * over a network, and "the field was not serialized" is not a distinction a
 * client should have to reason about.
 */
export type OwnerPetObligationCardV1 = {
  key: string;
  /** es-AR obligation title. */
  label: string;
  /** es-AR short state label. */
  state: string;
  tone: OwnerPetComplianceTone;
  /** es-AR secondary line — date, provider, chip number. */
  detail: string | null;
  /** es-AR muted legal citation. */
  legalFootnote: string;
  /**
   * Whether `tone` reflects a REAL vigencia. False for a dose on record with no
   * next-due date: the asiento exists, the currency is unknowable, and the
   * project's own rule is that "no sabemos" is never stamped VIGENTE. Null when
   * the obligation has no currency dimension at all (microchip, PPP).
   */
  currencyKnown: boolean | null;
  /** The formatted date the current currency runs until, when one is on record. */
  currencyUntil: string | null;
  /**
   * True when the card reports a missing FACT rather than a deadline. Distinct
   * from `currencyKnown`: nothing is expiring, something is simply not known.
   */
  dataUnknown: boolean;
  /**
   * Set when the obligation is NOT mandatory in this jurisdiction. Cards
   * carrying it are EXCLUDED from the "N de M al día" count — M counts mandatory
   * obligations only.
   */
  requirementTier: "recommended" | "optional" | "not_regulated" | null;
};

export type OwnerPetComplianceSection = {
  /** Ordered worst-state first, exactly as the projection ranked them. */
  cards: OwnerPetObligationCardV1[];
  /** e.g. `{ total: 4, ok: 3, label: "3 de 4 al día" }`. */
  summary: { total: number; ok: number; label: string };
  worstTone: OwnerPetComplianceTone;
  /**
   * True when the most urgent card is a missing FACT, so the stamp must read
   * SIN DATO rather than borrow a temporal word like POR VENCER.
   */
  worstIsUnknown: boolean;
};

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

export type OwnerPetReminderV1 = {
  reminderId: string;
  /** es-AR. */
  title: string;
  dueAt: string;
  /** Negative when overdue. */
  daysUntilDue: number;
  variant: string;
  /** Whether this reminder can be closed by reporting the act it asks for. */
  isReportable: boolean;
};

export type OwnerPetRemindersSection = {
  items: OwnerPetReminderV1[];
  /** How many active reminders exist in total, including any not listed. */
  total: number;
  /** True when `items` is a prefix of `total`. See the list-honesty rule. */
  truncated: boolean;
};

// ---------------------------------------------------------------------------
// The banners
// ---------------------------------------------------------------------------

/**
 * The tránsito banner. Present when the viewer holds the animal under a transit
 * role (an org-linked `foster`, or a `shelter_custody` row — the vecino who
 * picked up a stray, which has no organization behind it).
 *
 * `canManageFosterActions` is FALSE for that vecino on purpose: "Convertir en mi
 * mascota" and "Buscar nuevo hogar" are org-mediated and would dead-end without
 * an organization link. The banner still shows; the actions do not.
 */
export type OwnerPetTransitBannerV1 = {
  canManageFosterActions: boolean;
};

/** The caretaker arrangement — the titular's cockpit. Titular-only. */
export type OwnerPetCaretakerBannerV1 = {
  state: "active" | "pending" | "recently_ended";
  /** es-AR display name of the caretaker, when one is named. */
  caretakerName: string | null;
  /**
   * Non-null ONLY when an arrangement is active AND the caretaker consented to
   * being a public contact at invitation accept. Null in every other case, which
   * is what hides the disclosure row entirely rather than showing an ungated
   * switch — a control that would be a lie about what it does.
   */
  publicContactName: string | null;
};

/** The rehome / sponsorship arrangement the titular made. Titular-only. */
export type OwnerPetRehomeBannerV1 = {
  kind: "pending" | "active";
  orgDisplayName: string | null;
};

export type OwnerPetBannersSection = {
  transit: OwnerPetTransitBannerV1 | null;
  caretaker: OwnerPetCaretakerBannerV1 | null;
  rehome: OwnerPetRehomeBannerV1 | null;
};

// ---------------------------------------------------------------------------
// Open cases
// ---------------------------------------------------------------------------

/**
 * The case kinds an owner-facing list may name.
 *
 * This is `CASE_KINDS` (src/modules/cases/domain/case-kinds.ts) MINUS the two
 * the owner-facing projection never returns, and the omission is the security
 * statement rather than an oversight:
 *   · `welfare_denuncia` — the owner is the SUBJECT of that investigation and
 *     must not learn it exists (`can_read_case` refuses it to the subject owner
 *     by name; `HIDDEN_FROM_SUBJECT_CASE_KINDS` is the same rule in TypeScript).
 *   · `lost_pet_episode` — not a privacy matter: lost has its own single
 *     rendering path on both surfaces, and listing it here would double-draw it.
 * Both exclusions already live in `GENERIC_CASE_LIST_EXCLUDED_KINDS`, which is
 * the predicate the reader applies; this union is that predicate's shape on the
 * wire, so a client cannot render a kind the server would never send.
 *
 * `other` is the fallback for a row whose `case_kind` is outside the union —
 * the column is unconstrained text and staging carries legacy strings. The web
 * prints the raw key in that case; a phone printing `rabies_observation` at a
 * person is worse than saying "Otro trámite", and leaking a raw internal string
 * is worse than both.
 */
export const OWNER_PET_CASE_KINDS = [
  "bite_incident",
  "adoption_listing",
  "adoption_application",
  "custody_dispute",
  "foster_placement",
  "custody_episode",
  "custody_transfer_handshake",
  "foster_proposal",
  "outbreak_investigation",
  "microchip_remediation",
  "rehome_request",
  "other",
] as const;
export type OwnerPetCaseKind = (typeof OWNER_PET_CASE_KINDS)[number];

/**
 * Only the two OPEN states, because only open cases are listed.
 *
 * `escalated` is not withheld: the web's own badge prints "Escalado" to the
 * same viewer this endpoint serves, so hiding it here would be the app knowing
 * less than the browser about the person's own animal, not a privacy gain.
 */
export const OWNER_PET_CASE_STATUSES = ["open", "escalated"] as const;
export type OwnerPetCaseStatus = (typeof OWNER_PET_CASE_STATUSES)[number];

/**
 * One open case, in the three fields the web's own badge prints.
 *
 * WHY `casePublicCode` AND NOT `publicCode`. Two identifiers travel in this
 * payload and both are "public codes": `publicToken` names the ANIMAL and
 * `casePublicCode` names an EXPEDIENTE (`CAS-XXXX-XXXX`). The qualified name is
 * what stops a client from pasting one where the other belongs, and it is the
 * name the rest of the codebase already uses for this exact string.
 *
 * NO CASE ID. The file header's rule holds here without an exception: a client
 * reaches a case by its public code, which is also what a person quotes on the
 * phone to a sanitary authority. The internal uuid buys a client nothing and is
 * the kind of thing a stolen access token should not carry away.
 */
export type OwnerPetCaseV1 = {
  /** `CAS-XXXX-XXXX` — the code the reporter quotes later. */
  casePublicCode: string;
  kind: OwnerPetCaseKind;
  status: OwnerPetCaseStatus;
};

/**
 * A count AND the open cases behind it.
 *
 * IT WAS A COUNT ALONE UNTIL 2026-09-10, and the docblock here said a list
 * would be "data this endpoint's own web twin does not show". That was wrong on
 * the facts: `components/PetOpenCasesSection.tsx` renders exactly
 * `publicCode + caseKind + status` per open case on the web pet page, behind
 * `requirePetAccess` — the SAME guard and the SAME viewer set as this endpoint.
 * The count-only shape is what made the mordedura case code unreachable on the
 * phone (`read:reportBiteAction.casePublicCode` in the owner-surface parity
 * fence): a person reports a bite, the web hands them a `CAS-` code on a
 * receipt, and the app had nowhere to read it back.
 *
 * IT IS A READ AND NOT A WRITE RESPONSE, deliberately. Putting the code on the
 * `POST …/events` answer would put it in the one place a person loses it: a
 * single HTTP response they see once and never again. `appendBite`'s header
 * states the same decision from the writer's side.
 *
 * `items` and `openCount` describe the same set — both are computed over the
 * one capped window — so `items.length === openCount` always holds and neither
 * is derivable from a different query than the other.
 */
export type OwnerPetCasesSection = {
  /** Cases in `open` or `escalated`, excluding kinds hidden from the subject. */
  openCount: number;
  /**
   * True when the underlying read hit its cap, so `openCount` is a floor rather
   * than a total. The page's query is capped at 50 most-recent cases.
   */
  truncated: boolean;
  /**
   * The open cases themselves, most recently opened first — the same set
   * `openCount` counts and the same order the web draws them in.
   */
  items: OwnerPetCaseV1[];
};

// ---------------------------------------------------------------------------
// Pregnancy
// ---------------------------------------------------------------------------

export type OwnerPetPregnancyV1 = {
  startedAt: string;
  weeksAtDiagnosis: number | null;
  expectedBirthAt: string;
  lastClinicalAt: string | null;
};

/** `data: null` means "not pregnant"; `status: "unavailable"` means "unknown". */
export type OwnerPetPregnancySection = OwnerPetPregnancyV1 | null;

// ---------------------------------------------------------------------------
// PPP registries — the choices behind "Atestación requerida"
// ---------------------------------------------------------------------------

/**
 * One registry the owner may name when attesting a potentially dangerous
 * breed. Mirrors `PppAttestationRegistry` in the business-rules domain: the
 * server resolves `ppp_attestation_required_registries` for the pet's OWN
 * jurisdiction, so an admin editing the rule changes what the owner sees —
 * the web page does the same resolve on every render.
 */
export type OwnerPetPppRegistryV1 = {
  id: string;
  label: string;
  required: boolean;
};

/**
 * `data: null` means "this animal is not under the PPP regime" — the same fact
 * `derivePpp` reads from `pets.potentially_dangerous_breed` — so a client can
 * gate the attestation door on this one field instead of pattern-matching a
 * compliance card's label. An array (possibly empty) means the regime applies
 * and these are the registries the jurisdiction names; an EMPTY array is a
 * jurisdiction with the regime but no registry loaded, which the form must
 * still accept.
 *
 * WHAT THE FORM DOES WITH AN EMPTY ARRAY IS NOT FREE TEXT, and this docblock
 * said it was until 2026-09-08. `buildRegistryOptions`
 * (DangerousBreedAttestationForm.tsx:45) falls back to the two national
 * registries and always appends "Otro registro"; the native form falls back to
 * `DANGEROUS_BREED_REGISTRIES`, which is that same set. A typed registry would
 * be refused by `validateAttestationRegistry` anyway — a field that accepts
 * what the server rejects is a trap, not a permission.
 */
export type OwnerPetPppRegistriesSection = OwnerPetPppRegistryV1[] | null;

// ---------------------------------------------------------------------------
// The post-adoption check-in
// ---------------------------------------------------------------------------

/**
 * Whether THIS viewer owes the refugio a post-adoption check-in right now.
 *
 * ITS OWN SECTION, for the reason `pppRegistries` is one: the fact is not in
 * the reminders section — that list is the VACCINE reminders, deliberately
 * (`fetchActiveRemindersForPet` filters on `reminder_type = 'vaccine'`) — and
 * it is a read of its own, resolved by the route with its own budget, so the
 * face still loads when this one lookup does not.
 *
 * `pending: true` means the pet's latest adoption names this viewer as the
 * adopter AND at least one `post_adoption_checkin` reminder is open for them —
 * the same two facts the web's check-in page gates on, and the same two the
 * writer refuses without. `false` is a FACT ("nothing to report right now");
 * `unavailable` is a different one ("could not find out"), and the app's
 * picker reads them differently: a closed window hides the row, an unknown one
 * offers it and lets the server's refusal say why.
 *
 * `false` on the org path, always: an organization is never the adopter.
 */
export type OwnerPetPostAdoptionCheckinSection = {
  pending: boolean;
};

// ---------------------------------------------------------------------------
// The carousel
// ---------------------------------------------------------------------------

/**
 * The owner's OTHER live pets, urgent-first — what the web profile swipes
 * between. Deceased animals are never in the swipe.
 *
 * Owner-path only: an organization member reading a pet it holds does not get a
 * carousel of that organization's animals, because the web does not give them
 * one either.
 */
export type OwnerPetCarouselItemV1 = {
  publicToken: string;
  name: string;
  photoUrl: string | null;
  status: PublicPetStatus;
};

export type OwnerPetCarouselSection = {
  items: OwnerPetCarouselItemV1[];
  /**
   * Every OTHER live pet the viewer holds, including any beyond the cap.
   *
   * "Other" is load-bearing in both fields and it is the server's job, not the
   * client's: the animal being read is excluded from `items` AND from this
   * count. A client that filtered `items` itself but compared against a total
   * that still counted the current pet printed "Mostrando 8 de 9" next to seven
   * rows — which is exactly what happened before this was stated here.
   */
  total: number;
  /**
   * True when `items` is a prefix of `total` — that is, `items.length < total`,
   * measured AFTER the current animal has been dropped from both.
   *
   * Not "did the underlying ranking hit its cap". Those two answers come apart
   * on the household where the cap is the reason the current animal is missing
   * from the page: nine live pets, eight returned, this one ranking ninth. The
   * ranking was capped; the list a client receives is nonetheless complete.
   */
  truncated: boolean;
};

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

/**
 * `GET /api/v1/pets/{publicToken}` — HTTP 200.
 *
 * Every section is wrapped in `CredentialSection`, the SAME wrapper the public
 * credential uses, and for the same reason: `unavailable` means the server could
 * not load it, not that it is empty. An empty reminders list is
 * `{status:"ok", data:{items:[], total:0, truncated:false}}` — a client renders
 * "sin recordatorios", which is a fact. `{status:"unavailable"}` renders "no
 * pudimos leer esto", which is a different fact. A nullable field could not tell
 * a client which sentence to print.
 *
 * The envelope fields (`payloadVersion`, `issuedAt`, `staleAfter`) are TOP
 * LEVEL, per the READ rules — a client must be able to check the version and
 * the freshness without descending into a section that may itself be
 * unavailable.
 */
export type OwnerPetDetailV1 = {
  payloadVersion: typeof OWNER_PET_DETAIL_PAYLOAD_VERSION;
  issuedAt: string;
  staleAfter: string;
  publicToken: string;
  viewer: OwnerPetDetailViewer;
  identity: CredentialSection<OwnerPetIdentitySection>;
  status: CredentialSection<OwnerPetStatusSection>;
  alerts: CredentialSection<OwnerPetAlertsSection>;
  compliance: CredentialSection<OwnerPetComplianceSection>;
  reminders: CredentialSection<OwnerPetRemindersSection>;
  banners: CredentialSection<OwnerPetBannersSection>;
  cases: CredentialSection<OwnerPetCasesSection>;
  pregnancy: CredentialSection<OwnerPetPregnancySection>;
  pppRegistries: CredentialSection<OwnerPetPppRegistriesSection>;
  postAdoptionCheckin: CredentialSection<OwnerPetPostAdoptionCheckinSection>;
  carousel: CredentialSection<OwnerPetCarouselSection>;
};

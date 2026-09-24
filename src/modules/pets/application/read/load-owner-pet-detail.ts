// The OWNER face of a pet, read once and shaped for anything that renders it.
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// `app/(app)/mis-mascotas/[publicToken]/page.tsx` grew to 1466 lines, and the
// widest read outside the dashboards lived INSIDE it: nine concurrent reads in
// one `Promise.all`, plus a five-query stage before it, plus an owner-only
// stage after it, plus the carousel — interleaved with the JSX that renders the
// result. That is fine for exactly one consumer and impossible for two. The
// native app needs the same face, and a second implementation of "what does the
// owner see" is how two clients start disagreeing about whether an animal is up
// to date.
//
// So the READ moves here and the page keeps the RENDER. The page still owns its
// sheets, its write affordances and its JSX; what it no longer owns is the
// question of what the owner face is made of.
//
// THE SHAPE OF WHAT COMES BACK
// ---------------------------------------------------------------------------
// Plain data. No Drizzle row types cross this boundary outward — every query
// below uses an explicit `.select({...})` projection, and the derived objects
// are built from named fields. `Date`s DO survive (this is a domain DTO, not the
// wire shape); `app/api/v1/pets/[publicToken]/payload.ts` is what turns them
// into ISO strings and drops what a client has no business holding.
//
// The `pet` row itself arrives as an INPUT, already resolved by
// `requirePetAccess`. That mirrors `get-libreta-face-data.ts`, which takes the
// same already-resolved access for the same reason: a second auth round-trip
// per face was a real measured cost, and re-authorizing data the caller already
// proved it may read buys nothing.
//
// INJECTED DEPS, defaulted inline — the `lookup-public-credential.ts` pattern.
// Production callers pass one argument and get the real wiring; tests pass a
// stub and never touch a database. The deps are the COLLABORATORS worth faking
// (the fan-out members), not every helper: a pure mapper does not become
// testable by being injectable, it becomes harder to read.
//
// PORTS ARE A SEPARATE ARGUMENT, AND THAT IS THE DEPENDENCY FENCE SPEAKING.
// Three of this face's inputs come from OTHER modules — caretaker state, rehome
// state, and the surveillance predicate that says whether a rabies observation
// is open. `pets` importing any of them is the one edge that inverts
// `check-dependency-direction` (custodia-temporal design H, which spells this
// out: the owner cockpit reads caretaker state through a PAGE-level import
// because `app/**` is outside the module graph, and routing it through a `pets`
// use-case is exactly what must not happen). The page had a comment saying
// "do not tidy it there" — extracting the read moved it there anyway, and the
// fence caught it.
//
// So they are PORTS: named, required, and supplied by the composition root at
// `app/_composition/owner-pet-detail-ports.ts`, which lives in `app/**` where
// those imports are legal. The reader names their SHAPES structurally
// (`CaretakerStateLike`, `RehomeStateLike`) and is generic over them, so the
// page still gets the real types back and nothing is cast away. The
// `caretakers` module already mirrors `pets` types locally for the same reason;
// this is that pattern pointed the other way.

import { isTransitRole } from "@/components/PetCard.helpers";
import {
  fetchActiveRemindersForPet,
  fetchPetEventsForProfileV2,
} from "@/lib/analytics/owner-dashboard";
import {
  complianceRuleParams,
  microchipObligationRuleInfo,
  obligationRuleInfo,
} from "@/lib/domain/business-rules-defaults";
import { computeMedicationsActive } from "@/lib/domain/libreta-health-status";
import type { CarouselPet } from "@/lib/domain/owner-carousel";
import { resolveBusinessRule } from "@/lib/infra/business-rules-resolver";
import { fetchActiveIdentifications } from "@/lib/infra/pet-identifiers";
import {
  type ComplianceState,
  deriveComplianceState,
  lnPetStatusFromCompliance,
  microchipHeroTag,
} from "@/lib/projections/pet-compliance";
import { PET_SITUATIONS, type PetSituation, derivePetSituation } from "@/lib/ui/pet-situation";
import {
  ageFromDateOfBirth,
  isoDateInAr,
  sexLabel,
  situationLabelForSex,
  speciesLabel,
} from "@/lib/utils/format";
import {
  type OwnerPetCarouselRead,
  type OwnerPetCasesRead,
  type OwnerPetLostRead,
  type OwnerPetServiceDogRead,
  type OwnerPetViewerContactsRead,
  readCarousel,
  readCases,
  readLostData,
  readPhoto,
  readReservedRabiesTurno,
  readServiceDog,
  readViewerContacts,
} from "./owner-pet-detail-queries";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** The `pets` row, as `requirePetAccess` already resolved it. */
export type OwnerPetRow = {
  id: string;
  publicToken: string;
  name: string;
  species: string;
  sex: string | null;
  breed: string | null;
  status: string;
  /** A `date` column: Postgres hands it back as a string, not a Date. */
  dateOfBirth: string | null;
  deceasedAt: Date | string | null;
  primaryPhotoId: string | null;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  pregnancyStatus: string | null;
  rabiesObservationStatus: string | null;
  potentiallyDangerousBreed: boolean | null;
  estimatedWeightKg: string | number | null;
  adoptionListedAt: Date | null;
  adoptionListingPausedAt: Date | null;
};

export type OwnerPetDetailInput = {
  user: { id: string };
  pet: OwnerPetRow;
  /** Which door the viewer came through, per `requirePetAccess`. */
  accessPath: "owner" | "org";
  /**
   * The viewer's ACTIVE ownership role on this pet, as the ACCESS GUARD ranked
   * it. `null` on the organization path, where there is no ownership row of the
   * caller's own.
   *
   * IT ARRIVES AS INPUT BECAUSE IT WAS ALREADY DECIDED, and re-deciding it was a
   * coin flip. `resolvePetHolderAccess` ranks its Path-1 rows explicitly
   * (`owner` < `co_owner` < `foster` < `caretaker`) precisely because a user can
   * hold two active rows on one animal — a titular designated caretaker of their
   * own co-owned pet is reachable. Both callers were discarding that ranked
   * answer and this reader re-queried the same table with `.limit(1)` and NO
   * `ORDER BY`, so the second lookup resolved by whatever order Postgres felt
   * like. That value gates `viewer.isTitular`, the caretaker and rehome reads,
   * and `canManageDisclosure`: an owner+caretaker would watch their own cockpit
   * appear and vanish between refreshes. Same bug class, same remedy, as the
   * ranking inside the guard itself — decide once, deterministically, and pass
   * the answer down.
   *
   * It also removes a round-trip from the hottest owner surface.
   */
  holderRole: string | null;
};

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type OwnerPetAlertId =
  | "lost"
  | "rabies"
  | "transit"
  | "caretaker"
  | "rehome"
  | "open-cases"
  | "pregnancy";

export type OwnerPetAlert = {
  id: OwnerPetAlertId;
  tone: "urgent" | "warning" | "info";
};

export type OwnerPetPregnancy = {
  startedAt: Date;
  weeksAtDiagnosis: number | null;
  expectedBirthAt: Date;
  lastClinicalAt: Date | null;
};

export type OwnerPetIdentity = {
  name: string;
  species: string;
  sex: string | null;
  breed: string | null;
  /** "Caniche · Hembra · 3 años · Perro" — composed once, here. */
  breedLine: string;
  photoUrl: string | null;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  tags: Array<{ key: string; label: string; variant?: "celeste" | "gray" }>;
};

export type OwnerPetMemorial = { birthYear: number | null; deathYear: number | null };

export type OwnerPetChromeSituation = {
  key: PetSituation["key"];
  tone: PetSituation["tone"];
  icon: string;
  label: string;
};

/**
 * Everything the owner face is made of.
 *
 * This is the domain shape. It is DELIBERATELY wider than the wire type: the
 * page needs `typedEvents` and `lostEpisode` to render components the API does
 * not serve, and duplicating those reads to keep this object narrow would defeat
 * the extraction. The wire projection takes the subset a client may hold.
 *
 * (The two structural mirrors below come first, because the type is generic
 * over them.)
 */

/**
 * The shape of `caretakers`' `CaretakerState`, named structurally.
 *
 * NOT an import: importing that module from here — even type-only — is the edge
 * that inverts the dependency fence, and the fence reads the source text, so
 * naming the path in prose trips it too. Only the fields this reader actually
 * touches are named; the other two are opaque because their PRESENCE is all this
 * needs to know. The generic parameter on `loadOwnerPetDetail` is what hands the
 * caller its real type back, so nothing is widened for the page.
 */
export type CaretakerStateLike = {
  active: { caretakerName: string; publicContactConsentAt: Date | null } | null;
  pending: unknown;
  recentlyEnded: unknown;
};

/**
 * The shape of `rehome`'s `RehomeState`. Structural for the same reason.
 *
 * `kind` NAMES ITS THREE STATES instead of being a bare `string`, and that is
 * the whole value of the mirror. With `string`, renaming `"none"` in the rehome
 * module compiled everywhere and the alert below started firing for every animal
 * with no arrangement at all — a banner is a CLAIM about an arrangement, and the
 * three sites that re-spell these literals (this reader's alert, the payload's
 * narrowing, the page's banner) had no way to disagree loudly. Now they do: the
 * mirror stops compiling the day the real union moves.
 */
export type RehomeStateLike = {
  kind: "none" | "pending" | "active";
  orgDisplayName?: string | null;
};

export type OwnerPetDetail<
  C extends CaretakerStateLike | null = CaretakerStateLike | null,
  R extends RehomeStateLike | null = RehomeStateLike | null,
> = {
  /** The viewer's ownership role, or null on the organization path. */
  ownershipRole: string | null;
  isTransit: boolean;
  isDeceased: boolean;
  identity: OwnerPetIdentity;
  memorial: OwnerPetMemorial | null;
  /** The hero ring state, from the one shared status mapper. */
  ringStatus: ReturnType<typeof lnPetStatusFromCompliance>;
  /** Non-default, non-deceased situation — the credential's skin. Else null. */
  situation: PetSituation | null;
  /** The masthead band's situation, which DOES tint for a deceased animal. */
  chromeSituation: OwnerPetChromeSituation | null;
  compliance: ComplianceState;
  /** Urgency-ordered. The order is the product decision; it is made here. */
  alerts: OwnerPetAlert[];
  reminders: Awaited<ReturnType<typeof fetchActiveRemindersForPet>>;
  pregnancy: OwnerPetPregnancy | null;
  cases: OwnerPetCasesRead;
  carousel: OwnerPetCarouselRead;
  caretakerState: C;
  /**
   * KEY 2 of the two-key public-contact model. Non-null ONLY when an
   * arrangement is active AND the caretaker consented at invitation accept.
   */
  caretakerConsentName: string | null;
  rehomeState: R;
  /** The org that opened an in-progress rabies observation, when it was an org. */
  observationOpenedByOrgName: string | null;
  // --- Wider than the wire, for the page's own render ---
  typedEvents: Awaited<ReturnType<typeof fetchPetEventsForProfileV2>>["typedEvents"];
  lost: OwnerPetLostRead;
  canonicalIds: Awaited<ReturnType<typeof fetchActiveIdentifications>>;
  viewerContacts: OwnerPetViewerContactsRead;
  /** First word of the titular's display name, for the disclosure copy. */
  ownerFirstName: string;
  serviceDog: OwnerPetServiceDogRead;
  pppBreedRule: Awaited<ReturnType<typeof resolveBusinessRule<"ppp_breed_list">>>;
};

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export type OwnerPetDetailDeps = {
  readPhoto: typeof readPhoto;
  readServiceDog: typeof readServiceDog;
  readCases: typeof readCases;
  readLostData: typeof readLostData;
  readReservedRabiesTurno: typeof readReservedRabiesTurno;
  readViewerContacts: typeof readViewerContacts;
  readCarousel: typeof readCarousel;
  resolveRule: typeof resolveBusinessRule;
  loadEvents: typeof fetchPetEventsForProfileV2;
  loadReminders: typeof fetchActiveRemindersForPet;
  loadIdentifications: typeof fetchActiveIdentifications;
  now: () => Date;
};

/**
 * The collaborators that live in OTHER modules.
 *
 * Required, never defaulted, and supplied from `app/**` — see the header. A
 * default here would mean an import here, which is the whole thing the fence
 * forbids.
 */
export type OwnerPetDetailPorts<
  C extends CaretakerStateLike | null,
  R extends RehomeStateLike | null,
> = {
  /** `caretakers`. Titular-only; the reader decides when to call it. */
  loadCaretakerState: (petId: string) => Promise<C>;
  /** `rehome`. Same gate, same reason. */
  loadRehomeState: (petId: string) => Promise<R>;
  /**
   * `surveillance`. Whether a rabies-observation status counts as OPEN — a
   * domain rule with two open states, which is why it is a predicate and not a
   * string compare at the call site.
   */
  isObservationOpen: (status: string | null) => boolean;
};

const PRODUCTION_DEPS: OwnerPetDetailDeps = {
  readPhoto,
  readServiceDog,
  readCases,
  readLostData,
  readReservedRabiesTurno,
  readViewerContacts,
  readCarousel,
  resolveRule: resolveBusinessRule,
  loadEvents: fetchPetEventsForProfileV2,
  loadReminders: fetchActiveRemindersForPet,
  loadIdentifications: fetchActiveIdentifications,
  now: () => new Date(),
};

// ---------------------------------------------------------------------------
// Pure derivations
// ---------------------------------------------------------------------------

/** Gestation length in weeks. Nine for every species this product carries. */
const PREGNANCY_DURATION_WEEKS_BY_SPECIES: Record<string, number> = { dog: 9, cat: 9, other: 9 };

type TypedEvent = { eventType: string; occurredAt: Date; payload: unknown };

/**
 * The pregnancy card's data, from the clinical spine.
 *
 * `clinical_info_logged` is in the profile whitelist, so the "started" event is
 * already in memory — the expected birth date is arithmetic over it, never a
 * stored column, because a stored one would drift the moment the diagnosis week
 * was corrected.
 */
export function derivePregnancyCard(
  pet: { pregnancyStatus: string | null; species: string },
  typedEvents: TypedEvent[],
): OwnerPetPregnancy | null {
  if (pet.pregnancyStatus !== "in_progress") return null;
  const startedEvent = typedEvents.find((e) => {
    if (e.eventType !== "clinical_info_logged") return false;
    const p = e.payload as { sub_kind?: string; pregnancy_phase?: string };
    return p.sub_kind === "pregnancy" && p.pregnancy_phase === "started";
  });
  if (!startedEvent) return null;
  const payload = startedEvent.payload as { weeks_at_diagnosis?: number | null };
  const speciesWeeks = PREGNANCY_DURATION_WEEKS_BY_SPECIES[pet.species] ?? 9;
  const remaining = Math.max(speciesWeeks - (payload.weeks_at_diagnosis ?? 0), 0);
  const expectedBirthAt = new Date(startedEvent.occurredAt.getTime() + remaining * 7 * 86400000);
  const lastClinical = typedEvents.find(
    (e) => e.eventType === "clinical_info_logged" && e.occurredAt > startedEvent.occurredAt,
  );
  return {
    startedAt: startedEvent.occurredAt,
    weeksAtDiagnosis: payload.weeks_at_diagnosis ?? null,
    expectedBirthAt,
    lastClinicalAt: lastClinical?.occurredAt ?? null,
  };
}

/**
 * The four jurisdiction rules the owner face reads, all keyed on the SAME
 * province/locality pair.
 *
 * A tuple, not an object, so it can splat straight into the fan-out below and
 * keep its positional types. Grouped mostly so the four identical
 * `{province, locality}` literals appear once: they resolve through the same
 * cascade tiers and drifting one of them apart from the others would be a very
 * quiet bug.
 */
function resolveJurisdictionRules(pet: OwnerPetRow, deps: OwnerPetDetailDeps) {
  const scope = {
    province: pet.jurisdictionProvince ?? null,
    locality: pet.jurisdictionLocality ?? null,
  };
  return [
    deps.resolveRule("ppp_breed_list", scope),
    deps.resolveRule("microchip_required", scope),
    deps.resolveRule("rabies_vaccination", scope),
    deps.resolveRule("sterilization", scope),
  ] as const;
}

/**
 * The hero's identity block — the composed subtitle and the chips.
 *
 * The "chip" tag is derived from the COMPLIANCE PROJECTION, never from mere
 * microchip presence. That is the same provenance gate the compliance card
 * uses, and it is the fix for a real regression: a self-reported chip once put
 * "Microchip verificado" in the hero over a card that correctly read "Declarada
 * · sin verificar". Two surfaces, one gate, no contradiction.
 */
export function deriveIdentity(
  pet: OwnerPetRow,
  photoUrl: string | null,
  compliance: ComplianceState,
): OwnerPetIdentity {
  const age = ageFromDateOfBirth(pet.dateOfBirth, pet.deceasedAt);
  const tags: OwnerPetIdentity["tags"] = [];
  const microchipTagLabel = microchipHeroTag(compliance);
  if (microchipTagLabel) tags.push({ key: "chip", label: microchipTagLabel });
  if (pet.jurisdictionLocality) {
    tags.push({ key: "loc", label: pet.jurisdictionLocality, variant: "gray" });
  }
  return {
    name: pet.name,
    species: pet.species,
    sex: pet.sex,
    breed: pet.breed,
    breedLine: [pet.breed, pet.sex ? sexLabel(pet.sex) : null, age, speciesLabel(pet.species)]
      .filter(Boolean)
      .join(" · "),
    photoUrl,
    jurisdictionProvince: pet.jurisdictionProvince,
    jurisdictionLocality: pet.jurisdictionLocality,
    tags,
  };
}

/**
 * The In-Memoriam skin's data. Its PRESENCE is the memorial-mode switch.
 *
 * THE TWO YEARS COME FROM DIFFERENT KINDS OF VALUE, and the page this was
 * extracted from treated them as one. It read
 * `new Date(value).getFullYear()` for both, which runs in the MACHINE's local
 * zone — an animal born 2020-01-01 had "2019" carved on its memorial ribbon for
 * every reader west of Greenwich, on the one screen where getting a life's dates
 * right is the entire point.
 *
 * The correct handling differs per column, which is why this is not one helper:
 *   · `dateOfBirth` is a DATE-ONLY column. It is a calendar date with no
 *     instant attached, so there is no zone to convert it to or from — the year
 *     is the year that is written in it. Round-tripping it through a `Date` is
 *     what introduced a midnight to be wrong about in the first place.
 *   · `deceasedAt` IS an instant, so it gets pinned to the Argentine calendar
 *     via `isoDateInAr` — the same #418 guard every formatter in
 *     lib/utils/format.ts applies.
 */
export function deriveMemorial(pet: OwnerPetRow, isDeceased: boolean): OwnerPetMemorial | null {
  if (!isDeceased) return null;
  const birthYear = pet.dateOfBirth ? Number(pet.dateOfBirth.slice(0, 4)) : null;
  let deathYear: number | null = null;
  if (pet.deceasedAt) {
    const died = pet.deceasedAt instanceof Date ? pet.deceasedAt : new Date(pet.deceasedAt);
    if (!Number.isNaN(died.getTime())) deathYear = Number(isoDateInAr(died).slice(0, 4));
  }
  return {
    birthYear: birthYear !== null && Number.isFinite(birthYear) ? birthYear : null,
    deathYear,
  };
}

/**
 * "What this animal is going through" — a separate axis from compliance.
 *
 * Returns BOTH forms, because they differ in exactly one documented place: a
 * deceased animal tints the masthead band (memorial sepia + "Fallecido/a") while
 * the face body gets `situation: null`, since the memorial skin owns the body and
 * the two skins must never stack there.
 */
export function deriveSituations(
  pet: OwnerPetRow,
  flags: {
    isDeceased: boolean;
    isTransit: boolean;
    inTreatment: boolean;
    underOfficialCustody: boolean;
  },
): { situation: PetSituation | null; chromeSituation: OwnerPetChromeSituation | null } {
  const petSituation = derivePetSituation({
    status: pet.status,
    rabiesObservationStatus: pet.rabiesObservationStatus,
    pregnancyStatus: pet.pregnancyStatus,
    inTransit: flags.isTransit,
    inTreatment: flags.inTreatment,
    inAdoption: Boolean(pet.adoptionListedAt) && !pet.adoptionListingPausedAt,
    underOfficialCustody: flags.underOfficialCustody,
  });
  const situation = !flags.isDeceased && !petSituation.isDefault ? petSituation : null;
  const chromeSource = flags.isDeceased ? PET_SITUATIONS.fallecida : situation;
  return {
    situation,
    chromeSituation: chromeSource
      ? {
          key: chromeSource.key,
          tone: chromeSource.tone,
          icon: chromeSource.icon,
          label: situationLabelForSex(chromeSource.label, pet.sex),
        }
      : null,
  };
}

/**
 * The alert strip, urgency-ordered: lost → rabies → tránsito → caretaker →
 * rehome → open cases → pregnancy.
 *
 * THE ORDER IS THE PRODUCT DECISION and it is made once, here, so every client
 * agrees. A lapsed caretaker arrangement with an animal possibly still away
 * outranks a case in the reading order; an active one is context the owner needs
 * before anything below it makes sense.
 *
 * Exported for its own test: an ordering that only one 1466-line page could
 * demonstrate is an ordering nobody can check.
 */
export function deriveOwnerPetAlerts(input: {
  petStatus: string;
  /**
   * Already decided by `surveillance`'s predicate, not re-derived here. The
   * rule has TWO open states and re-implementing it as a string compare is how
   * one of them quietly stops raising the banner.
   */
  observationOpen: boolean;
  rabiesObservationStatus: string | null;
  isTransit: boolean;
  caretakerState: CaretakerStateLike | null;
  rehomeState: RehomeStateLike | null;
  openCaseCount: number;
  pregnancy: OwnerPetPregnancy | null;
}): OwnerPetAlert[] {
  const alerts: OwnerPetAlert[] = [];
  if (input.petStatus === "lost") alerts.push({ id: "lost", tone: "urgent" });
  if (input.observationOpen) {
    // `window_expired_unclosed` is NOT urgent: nothing is known to be wrong with
    // the animal, what is pending is a professional signature.
    alerts.push({
      id: "rabies",
      tone: input.rabiesObservationStatus === "in_progress" ? "urgent" : "warning",
    });
  }
  if (input.isTransit) alerts.push({ id: "transit", tone: "warning" });
  if (
    input.caretakerState &&
    (input.caretakerState.active ||
      input.caretakerState.pending ||
      input.caretakerState.recentlyEnded)
  ) {
    alerts.push({
      id: "caretaker",
      tone: input.caretakerState.recentlyEnded ? "warning" : "info",
    });
  }
  if (input.rehomeState && input.rehomeState.kind !== "none") {
    alerts.push({ id: "rehome", tone: "info" });
  }
  if (input.openCaseCount > 0) alerts.push({ id: "open-cases", tone: "warning" });
  if (input.pregnancy) alerts.push({ id: "pregnancy", tone: "info" });
  return alerts;
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

/**
 * Load everything the owner face of `input.pet` is made of.
 *
 * THROWS nothing of its own. The caller owns the time budget: the page wraps
 * this in `loadWithTimeout` (which is what turns a slow read into the degraded
 * chrome rather than a hang) and the route wraps it in `withDbBudgetOrThrow`.
 * Putting the budget in here would mean two callers with different, invisible
 * deadlines.
 */
export async function loadOwnerPetDetail<
  C extends CaretakerStateLike | null,
  R extends RehomeStateLike | null,
>(
  input: OwnerPetDetailInput,
  ports: OwnerPetDetailPorts<C, R>,
  deps: OwnerPetDetailDeps = PRODUCTION_DEPS,
): Promise<OwnerPetDetail<C, R>> {
  const { pet, user, accessPath } = input;
  const isOwner = accessPath === "owner";
  const isDeceased = pet.status === "deceased";

  // The guard already ranked this. See `OwnerPetDetailInput.holderRole` for why
  // re-reading it here was a coin flip rather than a redundancy.
  const ownershipRole = isOwner ? input.holderRole : null;

  // --- Stage 1: independent reads that later stages branch on ---------------
  const [photo, serviceDog, casesRead] = await Promise.all([
    deps.readPhoto(pet.primaryPhotoId),
    deps.readServiceDog(pet.id),
    deps.readCases(pet.id),
  ]);

  // isTransit is true for an org-linked `foster` AND for a `shelter_custody`
  // row (the vecino who picked up a stray, no org involved). One source of
  // truth: isTransitRole.
  const isTransit = isOwner ? isTransitRole(ownershipRole ?? "") : false;
  const isTitular = ownershipRole === "owner";

  // --- Stage 2: the wide fan-out -------------------------------------------
  // Every member is independent. A deceased animal skips the arrangements: it
  // has no caretaker story left to tell.
  const [
    pppBreedRule,
    microchipRule,
    rabiesObligationRule,
    sterilizationObligationRule,
    events,
    lost,
    reminders,
    canonicalIds,
    reservedTurno,
    viewerContacts,
    caretakerState,
    rehomeState,
  ] = await Promise.all([
    ...resolveJurisdictionRules(pet, deps),
    deps.loadEvents(user.id, pet.id),
    deps.readLostData(pet.id, pet.status),
    isOwner ? deps.loadReminders(user.id, pet.id) : Promise.resolve([]),
    deps.loadIdentifications(pet.id),
    deps.readReservedRabiesTurno(pet.id),
    isOwner ? deps.readViewerContacts(user.id) : Promise.resolve(null),
    isTitular && !isDeceased
      ? ports.loadCaretakerState(pet.id)
      : Promise.resolve(null as unknown as C),
    isTitular && !isDeceased
      ? ports.loadRehomeState(pet.id)
      : Promise.resolve(null as unknown as R),
  ]);

  const typedEvents = events.typedEvents;

  // --- Stage 3: the carousel (owner path only) -----------------------------
  // Ranks over EVERY live ownership, not a page of them: a most-urgent pet
  // beyond the cap would otherwise be absent from the swipe.
  const carousel = isOwner
    ? await deps.readCarousel(user.id)
    : { items: [], total: 0, truncated: false };

  // --- Derivations ----------------------------------------------------------
  const now = deps.now();
  const rabiesReminderRow = reminders.find((r) => /antirr[aá]b|rabi/i.test(r.title));
  const compliance = deriveComplianceState({
    now,
    events: typedEvents,
    // Who is reading — the rabies dual block says "cargada por vos" only when
    // this reader actually wrote the dose.
    viewerUserId: user.id,
    rabiesReminder: rabiesReminderRow
      ? { variant: rabiesReminderRow.variant, dueAt: rabiesReminderRow.dueAt }
      : null,
    reservedRabiesTurno: reservedTurno,
    microchipCode: canonicalIds.microchip?.code ?? null,
    obligations: {
      rabies: obligationRuleInfo(rabiesObligationRule),
      sterilization: obligationRuleInfo(sterilizationObligationRule),
      microchip: microchipObligationRuleInfo(microchipRule),
    },
    // T1-G1: the payload half of the SAME resolved rules — booster cadence and
    // the age gates are computed with, not only displayed.
    ruleParams: complianceRuleParams(rabiesObligationRule, sterilizationObligationRule),
    dateOfBirth: pet.dateOfBirth ?? null,
    pppRule: {
      legalBasis: pppBreedRule.legalBasis ?? null,
      authority: pppBreedRule.authority ?? null,
      sourceUrl: pppBreedRule.sourceUrl ?? null,
    },
    pppApplies: Boolean(pet.potentiallyDangerousBreed),
    species: pet.species,
    breed: pet.breed,
    estimatedWeightKg: pet.estimatedWeightKg,
  });

  const identity = deriveIdentity(pet, photo.photoUrl, compliance);

  const ringStatus = lnPetStatusFromCompliance(
    { status: pet.status, pregnancyStatus: pet.pregnancyStatus ?? null },
    compliance,
  );

  const pregnancy = derivePregnancyCard(pet, typedEvents);

  const { situation, chromeSituation } = deriveSituations(pet, {
    isDeceased,
    isTransit,
    // An open medication course = en tratamiento, from the same projection the
    // Libreta health dashboard uses. Never auto-derived from open cases.
    inTreatment: computeMedicationsActive(typedEvents).length > 0,
    underOfficialCustody: casesRead.underOfficialCustody,
  });

  const caretakerConsentName =
    caretakerState?.active?.publicContactConsentAt != null
      ? caretakerState.active.caretakerName
      : null;

  const alerts = deriveOwnerPetAlerts({
    petStatus: pet.status,
    observationOpen: ports.isObservationOpen(pet.rabiesObservationStatus),
    rabiesObservationStatus: pet.rabiesObservationStatus,
    isTransit,
    caretakerState,
    rehomeState,
    openCaseCount: casesRead.openCount,
    pregnancy,
  });

  const ownerFirstName = viewerContacts?.displayName
    ? (viewerContacts.displayName.split(" ")[0] ?? viewerContacts.displayName)
    : "el dueño";

  return {
    ownershipRole,
    isTransit,
    isDeceased,
    identity,
    memorial: deriveMemorial(pet, isDeceased),
    ringStatus,
    situation,
    chromeSituation,
    compliance,
    alerts,
    reminders,
    pregnancy,
    cases: casesRead,
    carousel,
    caretakerState,
    caretakerConsentName,
    rehomeState,
    observationOpenedByOrgName: casesRead.observationOpenedByOrgName,
    typedEvents,
    lost,
    canonicalIds,
    viewerContacts,
    ownerFirstName,
    serviceDog,
    pppBreedRule,
  };
}

export type { CarouselPet, OwnerPetCarouselRead, OwnerPetCasesRead, OwnerPetLostRead };

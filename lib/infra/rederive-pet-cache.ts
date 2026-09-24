// Re-derivation harness for the `pets` dual-write cache.
//
// WHY THIS EXISTS (ARCH-I, P1):
// pet_events is the immutable spine; several `pets` columns are operational
// caches that writers DUAL-WRITE (insert the event AND update the column in the
// same tx). There is no projection/rebuild layer for most of these columns, so
// if a writer forgets the cache half — or a bug skews it — drift between the
// events and the cache is invisible forever. This module re-derives each
// derivable cache column from the authoritative source and reports drift.
//
// It is a PURE derivation library plus a thin DB-reading orchestrator:
//   - The per-column rules live in lib/projections/* (pure functions, unit-tested).
//   - rederivePetCache(petId, tx?) reads the event stream + the open custody
//     dispute, runs every projection, and returns a per-column comparison.
// The fitness test (__tests__/pet-cache-rederivation.test.ts) and the ops
// script (scripts/detect-pet-cache-drift.ts) BOTH consume this single library,
// so CI and production agree on what "drift" means.
//
// SOURCE OF TRUTH per column is documented inline. Most derive from pet_events;
// `inCustodyDispute` derives from the custody_disputes table (the authoritative
// source — a withdrawal flips the flag with no pet_event), so this is NOT a
// pure-event projection and is handled in the orchestrator.
//
// EXCLUDED COLUMNS (deliberately not checked — documented, not guessed):
//   - adoptionListedAt / adoptionListingPausedAt / adoptionStory /
//     adoptionRequirements / adoptionEnergyLevel / adoptionSizeEstimate /
//     adoptionAgeBucket / adoptionGoodWith{Kids,Dogs,Cats} / adoptionNeedsYard /
//     adoptionFeeArs → shelf-curated listing metadata; the writers emit NO event
//     (adoption-repository.ts setListingStatus / updateListingContent).
//   - potentiallyDangerousBreed → computed from breed/species via lib/breeds.ts
//     in lib/business-rules-reeval.ts, not from events.
//   - adoptionEligibilitySetByUserId → maps to event.recordedByUserId which can
//     be null for system/stub writes; adoptionEligibilitySetAt is the witness.
//   - UI-preference flags (emergencyInfoVisible, disclose*WhenLost,
//     tier2PublicEnabledUntil) → flipping them emits no event by design.
//   - PII/metadata (createdBy, updatedBy, purpose, deletedAt, retentionUntil,
//     createdAt, updatedAt).
//   - permanentConditions / permanentConditionsOther / discloseConditionsPublicly /
//     acquisitionMethod → dual-written in updatePetProfile (pets-repository.ts)
//     and at registration. These were in NEITHER list until 2026-08-12 — the same
//     silent gap jurisdiction had, found by the second audit pass.
//     CORRECTION (review 2026-08-22, H7): the justification that used to stand
//     here — "all of them are only ever UPDATED through pet_profile_updated's
//     generic `changes` diff" — WAS FALSE for the three condition columns. They
//     never entered that diff at all (pet-diff.ts omitted them), so an owner
//     edit that only touched a condition wrote the cache column with NO event,
//     and this exclusion meant nothing checked the gap either: the cache column
//     was the only record of a medical fact published on the credential. That
//     bug is fixed — pet-diff.ts now diffs all three, so the sentence is true
//     today, but it was written as a reason to skip the check, not as an
//     observation, and it authorised the wrong conclusion for six months.
//     They stay EXCLUDED for the remaining, narrower reason: a faithful
//     projection has to interpret the `changes` array field-by-field
//     (replayPetWeight already does exactly this for weight, so it is doable) —
//     one new projection per column.
//     REVISIT IF: any of them starts feeding a business rule or a dashboard.
//     discloseConditionsPublicly is the closest to that line already: it gates
//     what the public credential shows. At that point the work is writing the
//     projections, not extending this note.
//   - localityId → the denormalized FK twin of jurisdictionLocality.
//     THE JUSTIFICATION THAT USED TO STAND HERE WAS FALSE, and it is the same
//     failure mode as the H7 correction above: it was written as a REASON TO
//     SKIP THE CHECK rather than as an observation, and it would have authorised
//     the wrong conclusion the next time somebody read it. It said the id was
//     "a value that cannot drift independently of the name it is resolved from".
//     It can, and it does by design: the INDEC catalogue carries 68 (province,
//     locality) collisions — four "San Pedro"s in Santiago del Estero — so two
//     pets whose three text columns are byte-identical legitimately hold
//     DIFFERENT locality_ids, and which one is right is the row the person
//     tapped. The three text columns cannot fail on that difference; they are
//     equal.
//     Worse, until L2-3 the choice was recorded NOWHERE in the spine:
//     `pet_registered` carried province/locality names only and
//     `movement_recorded` carried to_province/to_locality only, so any
//     rederivation or backfill from the log had to resolve by NAME, land on the
//     alphabetically first department, and silently reattribute the animal — to
//     a different responding authority and a different PPP regime — with this
//     exclusion note guaranteeing nothing looked.
//     The spine now records it: `pet_registered.jurisdiction_locality_id` and
//     `movement_recorded.to_locality_id`, both written from the same variable
//     that sets the column. It stays EXCLUDED for a narrower and true reason:
//     every event written BEFORE that field existed lacks it, so a checker would
//     derive null for the entire historical corpus and report drift for every
//     pet that has one — noise that gets the whole check muted, which is the
//     failure this module exists to prevent.
//     REVISIT IF: the id is backfilled into historical payloads, or the check is
//     written to skip pets whose latest jurisdiction-bearing event predates the
//     field. At that point the work is extending replayPetJurisdiction (which
//     returns the three text values today) to carry the id through, not
//     extending this note.
//
// jurisdictionCountry / _Province / _Locality WERE in neither list until
// 2026-08-12 — they fell through the gap in silence, which is exactly the
// failure this module exists to prevent. They are checked now. The objection
// that stopped an earlier attempt ("a faithful checker needs the async,
// DB-backed normalizeLocationForWrite, which cannot live in a pure projection")
// dissolves once you notice inCustodyDispute already set the precedent: a
// column whose source is not a pure event replay is handled in the ORCHESTRATOR.
// replayPetJurisdiction stays pure and returns the raw payload values; this file
// canonicalizes them with the same normalizer the write path calls, so a move
// rewritten to catalog spelling on write is rewritten identically here and can
// never register as false drift.

import { and, asc, desc, eq, inArray } from "drizzle-orm";

import {
  custodyDisputes,
  db,
  disputeHoldsCustodyLock,
  petEvents,
  petIdentifications,
  pets,
} from "@/db";
import { normalizeLocationForWrite } from "@/lib/domain/location-normalize";
import { overlayAmendments } from "@/lib/infra/amendment";
import { normalizeMicrochipLocation } from "@/lib/infra/pet-identifier-mapping";
import { replayPetAdoptionEligibility } from "@/lib/projections/pet-adoption-eligibility";
import {
  type PetJurisdictionProjection,
  replayPetJurisdiction,
} from "@/lib/projections/pet-jurisdiction";
import { replayPetMicrochip } from "@/lib/projections/pet-microchip";
import { replayPetPregnancy } from "@/lib/projections/pet-pregnancy";
import { replayPetRabiesObservation } from "@/lib/projections/pet-rabies-observation";
import { replayPetStatus } from "@/lib/projections/pet-status";
import { replayPetTattoo } from "@/lib/projections/pet-tattoo";
import { replayPetWeight } from "@/lib/projections/pet-weight";

// db.transaction callback param — accepted so callers can re-derive inside a
// per-pet advisory-locked tx (same pattern as scripts/rebuild-projections.ts).
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// How a column's stored vs derived values are compared. Some columns are
// numeric (Postgres normalizes "8.5"→"8.50"), some are date-only (DATE columns
// round-trip as YYYY-MM-DD), some are timestamp instants, the rest are strict.
// "implantSite" is a special kind for microchipLocation: both stored (canonical
// implantation_site) and derived (event payload location_on_body) are normalized
// through chipImplantSiteFromLocation before comparison because the legacy free-
// text form value and canonical enum are aliases of each other.
// "observationStatus" is a special kind for rabiesObservationStatus: the daily
// sweep may refine a stored `in_progress` into `window_expired_unclosed` purely
// because the statutory window elapsed, and that transition writes NO event (see
// lib/projections/pet-rabies-observation.ts). The projection is deliberately
// clockless, so the stored value legitimately runs one step ahead of the derived
// one. Only THAT pair is forgiven; everything else is drift.
type CompareKind =
  | "strict"
  | "numeric"
  | "dateOnly"
  | "instant"
  | "boolean"
  | "implantSite"
  | "observationStatus";

export type ColumnReport = {
  stored: unknown;
  derived: unknown;
  matches: boolean;
};

export type RederivePetCacheReport = Record<string, ColumnReport>;

// Columns the harness checks, with their comparison strategy. The key is the
// camelCase Drizzle column name on the pets row.
//
// ARCH-Q: microchip and tattoo columns are no longer sourced from pets.* for
// the "stored" side. Instead the harness reads the canonical pet_identifications
// row and applies an inverse mapping so both sides speak the same field-name
// language as the projections (see rederivePetCache below). The CompareKind
// values here still govern how each column is compared.
const CHECKED_COLUMNS: Record<string, CompareKind> = {
  // status (events: death_recorded / status_changed)
  status: "strict",
  deceasedAt: "instant",
  // weight (events: weight_recorded)
  estimatedWeightKg: "numeric",
  // microchip (canonical pet_identifications, stored side re-mapped — ARCH-Q)
  microchipId: "strict",
  microchipCountryCode: "strict",
  microchipImplantedAt: "dateOnly",
  microchipImplantedBy: "strict",
  // implantSite: normalizes both sides through chipImplantSiteFromLocation
  // because canonical stores enum, projection outputs raw form value.
  microchipLocation: "implantSite",
  // tattoo (canonical pet_identifications, stored side re-mapped — ARCH-Q)
  tattooCode: "strict",
  tattooLocation: "strict",
  tattooDescription: "strict",
  tattooRecordedAt: "dateOnly",
  tattooRecordedBy: "strict",
  // pregnancy (events: clinical_info_logged sub_kind=pregnancy)
  pregnancyStatus: "strict",
  // rabies (events: rabies_observation_started / _ended, plus the clock-driven
  // window_expired_unclosed refinement the sweep writes with no event).
  rabiesObservationStatus: "observationStatus",
  // jurisdiction (events: pet_registered, movement_recorded sub_kind=jurisdiction_changed).
  // Derived raw by replayPetJurisdiction, then canonicalized in the orchestrator
  // through the same normalizeLocationForWrite the write path uses.
  jurisdictionCountry: "strict",
  jurisdictionProvince: "strict",
  jurisdictionLocality: "strict",
  // custody dispute (custody_disputes table — NOT events). In-dispute is a
  // TWO-state predicate (open OR escalated) — disputeHoldsCustodyLock().
  inCustodyDispute: "boolean",
  // adoption eligibility (events: adoption_eligibility_set, latest-wins)
  adoptionEligible: "boolean",
  adoptionIneligibleReason: "strict",
  adoptionIneligibleReasonNotes: "strict",
  adoptionIneligibleUntil: "instant",
  adoptionEligibilitySetAt: "instant",
};

export const CHECKED_COLUMN_NAMES = Object.keys(CHECKED_COLUMNS);

/**
 * Why a `pets` column is NOT re-derived here. Every class is a claim the header
 * above argues for; the class name is what a reviewer checks the claim against.
 */
export type ExcludedCacheColumnReason =
  /** The row IS the record: owner-entered profile facts, logged by pet_profile_updated's diff, never replayed. */
  | "profile_record"
  /** Shelf-curated adoption listing metadata; its writers emit no event. */
  | "listing_metadata"
  /** Computed from other columns by a rule (lib/breeds.ts), not from events. */
  | "rule_computed"
  /** A witness column whose source (event.recordedByUserId) is null for system writes. */
  | "witness"
  /** UI / disclosure preferences; flipping them emits no event by design. */
  | "ui_preference"
  /** Row metadata, lifecycle and PII bookkeeping. */
  | "row_metadata"
  /** A real cache with no projection yet — each entry has a REVISIT IF in the header. */
  | "projection_pending";

/**
 * Every `pets` column this harness deliberately does NOT re-derive (finding
 * A08-4). The header comment used to be the only list, and a comment cannot
 * fail: jurisdiction and the condition columns sat in NEITHER list for months.
 * `__tests__/pet-cache-column-coverage.test.ts` enumerates
 * `getTableColumns(pets)` and fails when a column is in neither
 * CHECKED_COLUMN_NAMES nor this map, so a new dual-written column has to be
 * placed on one side before it can merge.
 */
export const EXCLUDED_CACHE_COLUMNS: Readonly<Record<string, ExcludedCacheColumnReason>> = {
  id: "row_metadata",
  publicToken: "profile_record",
  species: "profile_record",
  breed: "profile_record",
  name: "profile_record",
  sex: "profile_record",
  dateOfBirth: "profile_record",
  birthDateIsEstimated: "profile_record",
  color: "profile_record",
  distinguishingFeatures: "profile_record",
  primaryPhotoId: "profile_record",
  favouriteFoods: "profile_record",
  knownAllergies: "profile_record",
  trainingLevel: "profile_record",
  insuranceCompany: "profile_record",
  insurancePolicyNumber: "profile_record",
  preferredVetName: "profile_record",
  preferredVetPhone: "profile_record",
  emergencyContactName: "profile_record",
  emergencyContactPhone: "profile_record",
  potentiallyDangerousBreed: "rule_computed",
  adoptionEligibilitySetByUserId: "witness",
  adoptionListedAt: "listing_metadata",
  adoptionListingPausedAt: "listing_metadata",
  adoptionStory: "listing_metadata",
  adoptionRequirements: "listing_metadata",
  adoptionEnergyLevel: "listing_metadata",
  adoptionSizeEstimate: "listing_metadata",
  adoptionAgeBucket: "listing_metadata",
  adoptionGoodWithKids: "listing_metadata",
  adoptionGoodWithDogs: "listing_metadata",
  adoptionGoodWithCats: "listing_metadata",
  adoptionNeedsYard: "listing_metadata",
  adoptionFeeArs: "listing_metadata",
  emergencyInfoVisible: "ui_preference",
  discloseFirstNameWhenLost: "ui_preference",
  disclosePhoneWhenLost: "ui_preference",
  discloseEmailWhenLost: "ui_preference",
  discloseLastLocationWhenLost: "ui_preference",
  allowFinderFormWhenLost: "ui_preference",
  discloseCaretakerContactWhenLost: "ui_preference",
  dismissedFirstSteps: "ui_preference",
  tier2PublicEnabledUntil: "ui_preference",
  tier2PublicPermanent: "ui_preference",
  seedTag: "row_metadata",
  createdBy: "row_metadata",
  updatedBy: "row_metadata",
  purpose: "row_metadata",
  deletedAt: "row_metadata",
  retentionUntil: "row_metadata",
  createdAt: "row_metadata",
  updatedAt: "row_metadata",
  permanentConditions: "projection_pending",
  permanentConditionsOther: "projection_pending",
  discloseConditionsPublicly: "projection_pending",
  acquisitionMethod: "projection_pending",
  localityId: "projection_pending",
};

/**
 * Memo for canonicalized jurisdiction pairs, keyed `province|locality`.
 *
 * NOT an optimisation for its own sake — without it this harness is unusable at
 * scale. normalizeLocationForWrite resolves the locality through
 * localityByName, which issues a DB query per call and caches nothing
 * (lib/infra/ar-localidades.ts). rederivePetCache runs PER PET: the fitness
 * sweep walks every DIM-* pet and scripts/detect-pet-cache-drift.ts walks the
 * whole table, so an uncached lookup adds one query per pet and, measured
 * 2026-08-12, was enough to kill vitest workers in the db project — a project
 * that had been clean twice before the jurisdiction column was added.
 *
 * The pairs repeat heavily (every pet in a locality shares one), so the memo
 * collapses thousands of queries into a handful. Reference data does not change
 * inside a process, which is what makes caching it safe here.
 */
const jurisdictionCanonicalMemo = new Map<string, PetJurisdictionProjection>();

/** Clears the canonicalization memo — for tests that mutate the locality catalog. */
export function resetJurisdictionCanonicalMemo(): void {
  jurisdictionCanonicalMemo.clear();
}

/**
 * Canonicalize a raw (event-payload) jurisdiction the way the write path does.
 *
 * Mirrors recordMovementWriter.canonicalizeMovement and refreshJurisdiction:
 * only AR destinations with BOTH province and locality present are resolved;
 * anything else is left as-is. `locality: "soft"` never throws.
 */
async function canonicalizeDerivedJurisdiction(
  raw: PetJurisdictionProjection,
): Promise<PetJurisdictionProjection> {
  if (raw.jurisdictionCountry !== "AR" || !raw.jurisdictionProvince || !raw.jurisdictionLocality) {
    return raw;
  }
  const memoKey = `${raw.jurisdictionProvince}|${raw.jurisdictionLocality}`;
  const memoized = jurisdictionCanonicalMemo.get(memoKey);
  if (memoized) return memoized;

  const normalized = await normalizeLocationForWrite(
    {
      province: raw.jurisdictionProvince,
      provinceCode: null,
      locality: raw.jurisdictionLocality,
      localityIndecId: null,
      lat: null,
      lng: null,
      address: null,
    },
    { locality: "soft" },
  );
  const result: PetJurisdictionProjection = {
    jurisdictionCountry: raw.jurisdictionCountry,
    jurisdictionProvince: normalized.province ?? raw.jurisdictionProvince,
    jurisdictionLocality: normalized.locality ?? raw.jurisdictionLocality,
  };
  jurisdictionCanonicalMemo.set(memoKey, result);
  return result;
}

/**
 * Re-derive every derivable cache column for one pet and compare against the
 * stored values. Returns a per-column report. Throws if the pet does not exist.
 *
 * Pass `executor` (a tx) to run inside a transaction — e.g. the drift script
 * takes a per-pet advisory lock so a concurrent writer cannot interleave a new
 * event between the read and the comparison.
 */
export async function rederivePetCache(
  petId: string,
  executor: Executor = db,
): Promise<RederivePetCacheReport> {
  const [pet] = await executor.select().from(pets).where(eq(pets.id, petId)).limit(1);
  if (!pet) {
    throw new Error(`rederivePetCache: pet ${petId} not found`);
  }

  // Fetch all three sources in parallel: events, canonical identifiers, and
  // the custody-dispute table.
  const [rawEvents, canonicalIds, openDisputeRows] = await Promise.all([
    executor
      .select({
        id: petEvents.id,
        eventType: petEvents.eventType,
        occurredAt: petEvents.occurredAt,
        recordedAt: petEvents.recordedAt,
        payload: petEvents.payload,
      })
      .from(petEvents)
      .where(eq(petEvents.petId, petId))
      .orderBy(asc(petEvents.occurredAt), asc(petEvents.recordedAt), asc(petEvents.id)),
    // ARCH-Q: canonical identifier rows replace pets.* as the stored source
    // for microchip and tattoo columns.
    executor
      .select({
        kind: petIdentifications.kind,
        code: petIdentifications.code,
        isoCountryCode: petIdentifications.isoCountryCode,
        recordedAt: petIdentifications.recordedAt,
        recordedByLabel: petIdentifications.recordedByLabel,
        implantationSite: petIdentifications.implantationSite,
        tattooLocation: petIdentifications.tattooLocation,
        tattooDescription: petIdentifications.tattooDescription,
      })
      .from(petIdentifications)
      .where(
        and(
          eq(petIdentifications.petId, petId),
          eq(petIdentifications.status, "active"),
          inArray(petIdentifications.kind, ["microchip_iso", "tattoo"]),
        ),
      )
      // Mismo motivo que en fetchActiveIdentifications: sin orden, `stored`
      // sería no-determinístico si alguna vez hay dos filas activas, y el
      // detector compararía un valor que cambia entre corridas contra una
      // proyección que es latest-wins. Un detector de deriva no puede tener
      // entrada inestable.
      .orderBy(desc(petIdentifications.recordedAt), desc(petIdentifications.createdAt)),
    executor
      .select({ id: custodyDisputes.id })
      .from(custodyDisputes)
      .where(and(eq(custodyDisputes.petId, petId), disputeHoldsCustodyLock()))
      .limit(1),
  ]);

  // AMENDMENT OVERLAY — APPLIED ONCE, AT THE SOURCE (review 2026-08-22, M1).
  //
  // Corrections are new events (Invariant 2), and every product read boundary
  // projects them through overlayAmendments. This harness replayed the RAW
  // stream, so a corrected weight/pregnancy/jurisdiction read as PERMANENT
  // drift: the amendment refresher writes the amended value into the cache
  // inside the amendment's own transaction, and the detector then re-derived
  // the pre-correction one and called the difference a bug. Worse, the repair
  // path the runbook points at (`pnpm rebuild:projections --apply`) wrote the
  // stale number back — silently reverting a correction, with no audit row and
  // no new event.
  //
  // Overlaying HERE rather than in each replay function means the eight
  // projections below inherit it without knowing amendments exist, and there is
  // exactly one place where the semantics can drift from the SQL twin
  // (lib/infra/amendment-sql.ts). overlayAmendments also upcasts each payload,
  // which is the same treatment every other read boundary gives the spine.
  //
  // `event_amended` rows stay in the stream untouched: they were always there
  // (the query is unfiltered) and no projection reads them.
  const events = overlayAmendments(rawEvents);

  // Build canonical stored values for chip/tattoo in the same field shape as
  // the projections so the comparison is apples-to-apples.
  const chipRow = canonicalIds.find((r) => r.kind === "microchip_iso");
  const tattooRow = canonicalIds.find((r) => r.kind === "tattoo");

  // Sentinel labels written by migration backfills (0056, 0082) carry
  // provenance metadata that was not present in the original event payload.
  // When the canonical row's recordedByLabel is a backfill sentinel, the
  // corresponding event-projection field derives as null (no implanted_by in
  // the event). Similarly, recordedAt may be set to created_at/current_date
  // by the backfill when microchip_implanted_at was null and implant_date_known
  // was not true in the event. Treat both as null here so the harness compares
  // "no real value" vs "no real value" rather than flagging expected gaps.
  const BACKFILL_LABELS = new Set([
    "legacy_backfill_0056",
    "legacy_backfill_0082",
    "legacy_backfill_0083",
  ]);

  const chipRecordedByLabel = chipRow?.recordedByLabel ?? null;
  const chipIsBackfill = chipRecordedByLabel !== null && BACKFILL_LABELS.has(chipRecordedByLabel);

  const tattooRecordedByLabel = tattooRow?.recordedByLabel ?? null;
  const tattooIsBackfill =
    tattooRecordedByLabel !== null && BACKFILL_LABELS.has(tattooRecordedByLabel);

  // For backfill-labeled rows, microchipImplantedAt and microchipImplantedBy (and
  // their tattoo counterparts) were set from legacy column data that may not match
  // the event projection:
  //
  //   - microchipImplantedAt: backfill used COALESCE(implanted_at, created_at::date,
  //     current_date), so pets without a real implanted_at date got today's date.
  //     The projection returns null when implant_date_known=false (correct). Use the
  //     derived value as stored so backfill-approximation dates don't falsely fail.
  //   - microchipImplantedBy: backfill set recordedByLabel='legacy_backfill_0082'
  //     (sentinel provenance, not a real person). Projection returns null. Treat as
  //     null to match.
  //
  // For real (non-backfill) writes both sides come from the same event data and
  // WILL match if the writers are correct — those mismatches remain detectable.
  //
  // Sentinel logic is intentionally scoped to just these two fields per kind;
  // microchipId, microchipCountryCode, and microchipLocation are reliable even for
  // backfill rows (they are always set from real chip data, not approximated).
  const CHIP_IMPLANT_DATE_STORED = chipIsBackfill ? undefined : (chipRow?.recordedAt ?? null);
  const CHIP_IMPLANTED_BY_STORED = chipIsBackfill ? null : chipRecordedByLabel;
  const TATTOO_RECORDED_AT_STORED = tattooIsBackfill ? undefined : (tattooRow?.recordedAt ?? null);
  const TATTOO_RECORDED_BY_STORED = tattooIsBackfill ? null : tattooRecordedByLabel;
  // undefined means "use the derived value as stored" (skip comparison by matching).
  // This sentinel is resolved per-column in the report loop below.

  const canonicalStored: Record<string, unknown> = {
    // Microchip — map canonical fields to pets.* column names.
    microchipId: chipRow?.code ?? null,
    microchipCountryCode: chipRow?.isoCountryCode ?? null,
    microchipImplantedAt: CHIP_IMPLANT_DATE_STORED,
    microchipImplantedBy: CHIP_IMPLANTED_BY_STORED,
    // implantationSite stores the canonical enum; comparison uses "implantSite"
    // kind which normalizes both sides through chipImplantSiteFromLocation.
    microchipLocation: chipRow?.implantationSite ?? null,
    // Tattoo — map canonical fields to pets.* column names.
    tattooCode: tattooRow?.code ?? null,
    tattooLocation: tattooRow?.tattooLocation ?? null,
    tattooDescription: tattooRow?.tattooDescription ?? null,
    tattooRecordedAt: TATTOO_RECORDED_AT_STORED,
    tattooRecordedBy: TATTOO_RECORDED_BY_STORED,
  };

  // Jurisdiction — derived from events, then canonicalized through the SAME
  // normalizer the write path uses (recordMovementWriter.canonicalizeMovement /
  // refreshJurisdiction both call normalizeLocationForWrite with
  // `{ locality: "soft" }`). Running the identical function on both sides is
  // what makes this comparison honest: a move whose locality was rewritten to
  // catalog spelling on write is rewritten the same way here, so it can never
  // register as drift. "soft" never throws — an off-catalog pair falls through
  // unchanged, exactly as on the write path.
  //
  // COMPARABLE ONLY WHEN THE SPINE ACTUALLY ASSERTS A PROVINCE.
  //
  // Two distinct "nothing to compare" cases, both skipped by falling back to the
  // stored values (the same "skip by matching" idiom the backfill sentinels
  // above use):
  //   · replayPetJurisdiction returns null — no jurisdiction-bearing event at
  //     all (pets inserted directly, legacy rows).
  //   · it returns a province of null — the event exists but says nothing about
  //     jurisdiction. Production always writes it (pets-repository.ts:230), so
  //     this is the seed population, which emits pet_registered without those
  //     fields while setting the column directly.
  //
  // Skipping loses nothing real: when the spine asserts nothing AND the column
  // is also null the two match anyway, so the only cases suppressed are ones
  // where the spine is silent. Scoring those as drift would put every seeded pet
  // in the report and get the whole check muted — which is how a fence dies.
  const rawJurisdiction = replayPetJurisdiction(events);
  const jurisdictionComparable = rawJurisdiction?.jurisdictionProvince != null;
  const derivedJurisdiction = jurisdictionComparable
    ? await canonicalizeDerivedJurisdiction(rawJurisdiction as PetJurisdictionProjection)
    : {
        jurisdictionCountry: (pet as Record<string, unknown>).jurisdictionCountry as string | null,
        jurisdictionProvince: (pet as Record<string, unknown>).jurisdictionProvince as
          | string
          | null,
        jurisdictionLocality: (pet as Record<string, unknown>).jurisdictionLocality as
          | string
          | null,
      };

  const derived = {
    ...replayPetStatus(events),
    ...replayPetWeight(events),
    ...replayPetMicrochip(events),
    ...replayPetTattoo(events),
    ...replayPetPregnancy(events),
    ...replayPetRabiesObservation(events),
    ...replayPetAdoptionEligibility(events),
    ...derivedJurisdiction,
    inCustodyDispute: openDisputeRows.length > 0,
  } as Record<string, unknown>;

  const petRow = pet as Record<string, unknown>;
  const report: RederivePetCacheReport = {};

  // Identifier columns use canonical stored values (from canonicalStored above).
  // ARCH-S: the 10 legacy chip/tattoo columns have been dropped from pets (migration 0084).
  // All other columns still read from the pets row.
  const CANONICAL_COLUMNS = new Set([
    "microchipId",
    "microchipCountryCode",
    "microchipImplantedAt",
    "microchipImplantedBy",
    "microchipLocation",
    "tattooCode",
    "tattooLocation",
    "tattooDescription",
    "tattooRecordedAt",
    "tattooRecordedBy",
  ]);

  for (const [column, kind] of Object.entries(CHECKED_COLUMNS)) {
    let stored = CANONICAL_COLUMNS.has(column) ? canonicalStored[column] : petRow[column];
    const derivedValue = derived[column];
    // undefined in canonicalStored means "backfill approximation — treat as
    // derived so this column always matches and doesn't produce false positives".
    if (stored === undefined) stored = derivedValue;
    report[column] = {
      stored,
      derived: derivedValue,
      matches: valuesMatch(stored, derivedValue, kind),
    };
  }
  return report;
}

/** Returns the subset of a report whose columns drifted. */
export function driftedColumns(report: RederivePetCacheReport): RederivePetCacheReport {
  const out: RederivePetCacheReport = {};
  for (const [column, r] of Object.entries(report)) {
    if (!r.matches) out[column] = r;
  }
  return out;
}

export function hasDrift(report: RederivePetCacheReport): boolean {
  return Object.values(report).some((r) => !r.matches);
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

function valuesMatch(stored: unknown, derived: unknown, kind: CompareKind): boolean {
  switch (kind) {
    case "numeric":
      return sameNumeric(stored, derived);
    case "dateOnly":
      return sameDateOnly(stored, derived);
    case "instant":
      return sameInstant(stored, derived);
    case "boolean":
      return normalizeBool(stored) === normalizeBool(derived);
    case "implantSite":
      // Both sides may be in different alias forms (e.g. "interscapular_left"
      // from event payload vs "interescapular" from canonical enum). Normalize
      // both through chipImplantSiteFromLocation before comparing.
      return sameImplantSite(stored, derived);
    case "observationStatus":
      return sameObservationStatus(stored, derived);
    default:
      return normalizeStrict(stored) === normalizeStrict(derived);
  }
}

/**
 * Equal, OR the one asymmetry the sweep is allowed to introduce: stored
 * `window_expired_unclosed` against derived `in_progress`.
 *
 * The reverse is NOT accepted. A stored `in_progress` against a derived
 * `window_expired_unclosed` cannot happen (the projection never produces that
 * value), and a stored `window_expired_unclosed` against a derived `completed_*`
 * WOULD be real drift — a professional close whose cache half was lost.
 */
export function sameObservationStatus(stored: unknown, derived: unknown): boolean {
  if (normalizeStrict(stored) === normalizeStrict(derived)) return true;
  return stored === "window_expired_unclosed" && derived === "in_progress";
}

function normalizeStrict(v: unknown): unknown {
  // Treat undefined as null so a missing column reads as null, not a mismatch.
  return v === undefined ? null : v;
}

function normalizeBool(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "t") return true;
  if (v === "false" || v === "f") return false;
  return null;
}

function sameNumeric(a: unknown, b: unknown): boolean {
  const na = toNumberOrNull(a);
  const nb = toNumberOrNull(b);
  if (na === null && nb === null) return true;
  if (na === null || nb === null) return false;
  return na === nb;
}

function toNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function sameDateOnly(a: unknown, b: unknown): boolean {
  const da = toDateOnly(a);
  const db_ = toDateOnly(b);
  return da === db_;
}

function toDateOnly(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string") {
    // Already a YYYY-MM-DD (DATE column) — take the date portion verbatim.
    const m = v.match(/^\d{4}-\d{2}-\d{2}/);
    if (m) return m[0];
  }
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function sameImplantSite(a: unknown, b: unknown): boolean {
  const na =
    a === null || a === undefined || a === ""
      ? null
      : normalizeMicrochipLocation(typeof a === "string" ? a : String(a));
  const nb =
    b === null || b === undefined || b === ""
      ? null
      : normalizeMicrochipLocation(typeof b === "string" ? b : String(b));
  return na === nb;
}

function sameInstant(a: unknown, b: unknown): boolean {
  const ta = toInstant(a);
  const tb = toInstant(b);
  if (ta === null && tb === null) return true;
  if (ta === null || tb === null) return false;
  return ta === tb;
}

function toInstant(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

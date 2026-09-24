// Use-case: recordJurisdictionMove — MUDANZA, the owner-facing half of
// `movement_recorded`.
//
// WHAT THIS IS AND WHAT IT IS NOT
// ---------------------------------------------------------------------------
// `recordMovementWriter` (beside this file) is the WRITER: one transaction,
// event first, then the `pets.jurisdiction*` denormalization, and it takes all
// three `sub_kind`s. What it does NOT do is decide whether the destination is a
// real place, and that decision is the whole of the owner-facing act — the
// writer's own header calls its internal canonicalization "soft" and says the
// strict, user-facing rejection belongs to the edge.
//
// So this is the edge, extracted, and the extraction has a name in this repo:
// `eraseSubjectDataFor` / `exportSubjectDataFor` were carved out of two server
// actions so the cookie door and the bearer door would run the same ordered
// steps instead of resembling each other. This is the same carve, one domain
// over.
//
// IT IS NOT YET SHARED, AND THAT IS DECLARED RATHER THAN DISCOVERED.
// `recordMoveAction` (src/modules/pets/actions.ts) still carries its own copy of
// these steps. Migrating it is a browser-facing edit to a `"use server"` entry
// point with its own e2e gate — the identical arrangement `list-appointments-
// for-user.ts` and `bookSlotAction` record for the identical reason — so one
// rule has two copies today, and this header is the citation. The copies are
// thin on purpose: BOTH call `normalizeLocationForWrite(…, { locality: "strict" })`
// and BOTH call `recordMovementWriter`, so what is duplicated is which arguments
// to pass, not the rule itself.
//
// THREE PLACES WHERE THIS DOOR IS DELIBERATELY DIFFERENT FROM THE WEB'S
// ---------------------------------------------------------------------------
//   1. THE NO-OP IS COMPUTED, NOT PATTERN-MATCHED. `recordMoveAction` reads the
//      writer's failure as `result.error.includes("no-op") || .includes("differ")`
//      — a match on the text of a Zod message, which changes when somebody
//      rewords a `superRefine`. The rule itself is three equality comparisons
//      (`movementJurisdictionChanged`'s refinement: country, province and
//      locality must not ALL match), so this file makes them, against the
//      CANONICALIZED destination, before the writer is called. Same rule, no
//      prose in the path.
//   2. THE FAILURE ARM IS TYPED. `MoveFailureCode` is the shape
//      `ClaimFailureCode` and `AmendEventFailureCode` already are: a caller maps
//      a code to a status instead of matching es-AR sentences, and a new refusal
//      arm cannot land without deciding which code it is. `error` travels beside
//      it for the web's benefit if it ever migrates.
//   3. NO GUARD LIVES HERE. The caller resolves the holder and decides — this
//      function takes an already-authorized pet and the authorship to sign with.
//      That is deliberate and it is the boundary `/CLAUDE.md` draws: the security
//      boundary stays at the door (`requireTitularAccess` on the cookie side,
//      `resolvePetHolderAccess` + `isTitularHolder` on the bearer side), never in
//      a use-case a second caller could reach with a different one.
//
// WHY THE COUNTRY IS HARDCODED "AR". `recordMoveAction` hardcodes it too, and it
// is not laziness: `jurisdiction_changed` is a change of which ARGENTINE
// authority answers for the animal. Leaving the country is `transport_recorded`
// / `cvi_issued` — the `/viaje` screen — which is a different sub_kind with a
// different form and a corridor registry behind it.

import type { Pet } from "@/db";
import {
  JurisdictionValidationError,
  normalizeLocationForWrite,
} from "@/lib/domain/location-normalize";
import type { PetEventAuthorship } from "@/lib/infra/pet-access";

import { recordMovementWriter } from "./record-movement";

/**
 * Why a move was refused.
 *
 * THREE AND NOT FOUR: there is no "forbidden" member, because authorization is
 * not this function's job and a code for it would invite a caller to let the
 * use-case decide. The door answers 403 before it gets here.
 */
export type MoveFailureCode =
  /** The (province, locality) pair is not in the INDEC catalog. */
  | "destination_invalid"
  /** The destination is where the animal already lives — not an event. */
  | "same_locality"
  /** The writer refused for any other reason. */
  | "write_failed";

export type RecordJurisdictionMoveResult =
  | {
      ok: true;
      eventId: string;
      /** The destination AS STORED — canonical, not as posted. */
      province: string;
      locality: string;
    }
  | { ok: false; code: MoveFailureCode; error: string };

export type RecordJurisdictionMoveInput = {
  /**
   * The animal, ALREADY RESOLVED AND ALREADY AUTHORIZED by the caller.
   *
   * The four jurisdiction fields are read to build the `from_*` half of the
   * payload and to decide the no-op; they are the row the access guard already
   * fetched, so this function opens no second read of `pets`.
   *
   * `localityId` is the fifth, and it is here because the other four cannot
   * decide the no-op on their own: two localities of one province can share a
   * name, so comparing text alone refuses the correcting move (L2-5).
   */
  pet: Pick<
    Pet,
    | "id"
    | "publicToken"
    | "jurisdictionCountry"
    | "jurisdictionProvince"
    | "jurisdictionLocality"
    | "localityId"
  >;
  recordedByUserId: string;
  eventAuthorship: PetEventAuthorship;
  /**
   * Where the animal now lives.
   *
   * `localityIndecId` is optional and, when present, DECIDES which catalogue row
   * this is (A2-alta-asentar-03).
   *
   * WHAT IT ACTUALLY FIXES, stated correctly after L2-5 found the first version
   * of this note describing something that cannot happen. Resolving by name
   * CANNOT cross a province: `resolveCanonicalJurisdiction` resolves the
   * province first and `localityByName` is province-scoped, so no lookup ever
   * confused San Pedro, Buenos Aires with San Pedro, Santiago del Estero. The
   * real defect is one province in: `localityByName` settles a homonym with
   * `.orderBy(departmentName).limit(1)`, and the INDEC catalogue carries 68
   * (province, name) collisions — four "San Pedro"s in Santiago del Estero
   * alone. A person shown two rows with different departments who taps the
   * second one had their animal filed under the first, which decides the
   * responding authority, the applicable PPP regime and where the animal counts
   * epidemiologically. The id is the only thing that tells those rows apart.
   */
  destination: { provinceCode: string; localityName: string; localityIndecId?: string | null };
  reason: string | null;
  /** Injectable clock — the effective date and `occurredAt` both derive from it. */
  now?: Date;
};

/** The one country this act may target. See the header. */
const MOVE_COUNTRY = "AR";

export async function recordJurisdictionMove(
  input: RecordJurisdictionMoveInput,
): Promise<RecordJurisdictionMoveResult> {
  const now = input.now ?? new Date();

  // STRICT, and the mode is the whole point. `soft` — what the writer runs
  // internally — lets an off-catalog pair through unchanged so an atomic write
  // is never broken by a canonicalization surprise. At the edge that would mean
  // storing a spelling the catalog does not know into the columns every
  // `resolveBusinessRule` call site reads, so the edge refuses instead.
  let province: string | null;
  let locality: string | null;
  // The catalogue ROW, not just its two names. Carried to the writer so the
  // homonym the INDEC id just decided is the one `pets.locality_id` ends up
  // holding — see RecordMovementParams.resolvedLocalityId (L2-2).
  let localityId: string | null;
  try {
    const normalized = await normalizeLocationForWrite(
      {
        province: input.destination.provinceCode,
        provinceCode: input.destination.provinceCode,
        locality: input.destination.localityName,
        localityIndecId: input.destination.localityIndecId ?? null,
        lat: null,
        lng: null,
        address: null,
      },
      { locality: "strict" },
    );
    province = normalized.province;
    locality = normalized.locality;
    localityId = normalized.localityId;
  } catch (err) {
    if (err instanceof JurisdictionValidationError) {
      return { ok: false, code: "destination_invalid", error: err.message };
    }
    throw err;
  }

  // A PAIR THE NORMALIZER RESOLVED TO NOTHING IS ALSO INVALID, and this branch
  // is not defensive padding. `normalizeLocationForWrite`'s strict path only
  // calls the catalog when BOTH halves survive `canonicalProvinceNameForStorage`
  // — an unresolvable province returns null and the strict branch is skipped
  // entirely, handing back an uncanonicalized pair with no error. That
  // fall-through is exactly the state this door must not write.
  if (!province || !locality) {
    return {
      ok: false,
      code: "destination_invalid",
      error: "No pudimos resolver esa provincia y localidad en el catálogo.",
    };
  }

  // THE NO-OP, computed rather than read off a message. These comparisons ARE
  // `movementJurisdictionChanged`'s `superRefine` — if they all hold, the schema
  // would reject the payload and the writer would hand back a sentence this door
  // would have to grep. Doing it here also means a no-op costs no transaction at
  // all.
  //
  // THE NAMES ARE NOT THE PLACE (L2-5). Comparing only country, province and
  // locality TEXT refuses the one move that most needs to be recordable: an
  // animal filed against the wrong San Pedro being corrected to the right one,
  // where both rows carry the same province and the same name. When both sides
  // name a catalogue row and the rows differ, this is a real move whatever the
  // text says. When either id is missing — a legacy pet whose `locality_id` was
  // never resolved — the text comparison is all there is and it still decides.
  const fromCountry = input.pet.jurisdictionCountry ?? MOVE_COUNTRY;
  const sameCatalogueRow =
    input.pet.localityId != null && localityId != null ? input.pet.localityId === localityId : true;
  if (
    fromCountry === MOVE_COUNTRY &&
    input.pet.jurisdictionProvince === province &&
    input.pet.jurisdictionLocality === locality &&
    sameCatalogueRow
  ) {
    return {
      ok: false,
      code: "same_locality",
      error: "El destino es igual a la localidad actual.",
    };
  }

  const result = await recordMovementWriter({
    pet: { id: input.pet.id, publicToken: input.pet.publicToken },
    recordedByUserId: input.recordedByUserId,
    eventAuthorship: input.eventAuthorship,
    occurredAt: now,
    movement: {
      sub_kind: "jurisdiction_changed",
      from_country: fromCountry,
      from_province: input.pet.jurisdictionProvince,
      from_locality: input.pet.jurisdictionLocality,
      // The row the animal is leaving, so a later reader can tell this move
      // from a no-op without re-resolving two identical names (L2-3).
      from_locality_id: input.pet.localityId,
      to_country: MOVE_COUNTRY,
      to_province: province,
      to_locality: locality,
      // The web's own value: a move recorded today takes effect today. The
      // payload keeps the field separate from `occurred_at` because the schema
      // allows them to differ; no owner-facing surface offers a back-date.
      effective_date: now.toISOString().slice(0, 10),
      reason: input.reason,
    },
    notes: null,
    now,
    resolvedLocalityId: localityId,
  });

  if (!result.ok) {
    return { ok: false, code: "write_failed", error: result.error };
  }

  return { ok: true, eventId: result.eventId, province, locality };
}

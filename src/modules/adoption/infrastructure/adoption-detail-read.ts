// One adoption ficha, for the bearer door — the four answers `/adoptar/{token}`
// gives, decided by the same predicates.
//
// WHY THIS EXISTS INSTEAD OF THE PAGE CALLING IT TOO
// ---------------------------------------------------------------------------
// It would be better if `app/(public)/adoptar/[petToken]/page.tsx` read through
// here, the way `postulaciones` now reads through `my-applications-read.ts`.
// That page is 1,000 lines of markup with its query braided into the render,
// its own throttle, its own JSON-LD and its own metadata read; carving it out is
// a real change to a live public surface and it is NOT this lane's subject.
//
// What is shared instead is the part that can drift into a DISAGREEMENT rather
// than a duplication:
//
//   · `isListable` — the domain predicate both surfaces already call.
//   · `AdoptionRepository.findPetForPublicDetail` — the pet-first/custody-second
//     split, with the stale-custodian tiebreak, in one place.
//   · `livesWithFamilyUnder` — design R5's one predicate.
//   · `buildAdoptionDetailListed` — every field that leaves the server.
//
// The four listability guards are therefore spelled ONCE (in `isListable`) and
// the pause branch's one difference from them is written out below rather than
// re-derived. What is still duplicated is the SEVEN-DAY window and the shape of
// the pause branch; both are named constants here so a diff shows them.

import { and, eq, isNull } from "drizzle-orm";

import { attachments, db, petEvents } from "@/db";
import { hasActiveMicrochip } from "@/lib/infra/pet-identifiers";
import { petPhotoUrl } from "@/lib/infra/storage";

import type {
  AdoptionDetailOrgInput,
  AdoptionDetailPetInput,
} from "../application/adoption-payloads";
import { isListable, livesWithFamilyUnder } from "../domain/listing-rules";
import { AdoptionRepository } from "./adoption-repository";
import { findOpenSponsorship } from "./rehome-sponsorship-writer";

/** D7.2's window: a share link followed within a week gets a sentence, not a 404. */
export const RECENTLY_ADOPTED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The ficha's gallery cap — primary plus up to eight pet-scoped extras. */
const GALLERY_LIMIT = 8;

/**
 * What the reader found. `state: "gone"` is the 404 — a token that does not
 * resolve, an erased pet, or a pet that was never listable and has no soft
 * answer to give.
 */
export type AdoptionDetailReadResult =
  | { state: "gone" }
  | { state: "recently_adopted"; petToken: string; name: string }
  | { state: "paused"; petToken: string; name: string; orgName: string }
  | {
      state: "listed";
      petToken: string;
      /**
       * Everything `buildAdoptionDetailListed` needs, already resolved.
       *
       * TYPE-ONLY IMPORT ACROSS THE LAYER, deliberately: the shape belongs to
       * the payload builder (it is the list of fields that may leave the
       * server), and duplicating it here is how the two lists drift. Types
       * erase, so there is no runtime edge from infrastructure to application.
       */
      pet: AdoptionDetailPetInput;
      org: AdoptionDetailOrgInput;
      photoUrls: string[];
      health: { hasVaccinations: boolean; isSterilized: boolean; hasMicrochip: boolean };
      livesWithFamily: boolean;
      custodySince: Date | null;
      /** The pet's row id, for the caller's duplicate-application check. */
      petId: string;
    };

/** Presence of one event type on a pet. A boolean, never a count and never a row. */
async function hasEvent(petId: string, eventType: string): Promise<boolean> {
  const [row] = await db
    .select({ id: petEvents.id })
    .from(petEvents)
    .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, eventType)))
    .limit(1);
  return Boolean(row);
}

export async function readAdoptionDetail(
  petPublicToken: string,
  now: Date = new Date(),
): Promise<AdoptionDetailReadResult> {
  const found = await AdoptionRepository.findPetForPublicDetail(petPublicToken);
  if (!found) return { state: "gone" };
  const { pet, org, custodyStartedAt } = found;

  const listable =
    org !== null &&
    isListable(
      {
        adoptionListedAt: pet.adoptionListedAt,
        adoptionListingPausedAt: pet.adoptionListingPausedAt,
        status: pet.status,
        adoptionEligible: pet.adoptionEligible,
        inCustodyDispute: pet.inCustodyDispute,
        rabiesObservationStatus: pet.rabiesObservationStatus,
      },
      { verified: org.verified, orgType: org.orgType },
    );

  if (!listable) {
    // D7.2 — a recent finalization wins over the paused view, and both win over
    // a 404. Order copied from the page, where it is argued.
    const finalizedAt = await AdoptionRepository.findLatestAdoptionFinalizedAt(pet.id);
    if (finalizedAt && now.getTime() - finalizedAt.getTime() < RECENTLY_ADOPTED_WINDOW_MS) {
      return { state: "recently_adopted", petToken: pet.publicToken, name: pet.name };
    }

    // THE PAUSE BRANCH IS `isListable` WITH EXACTLY ONE GUARD INVERTED, and
    // spelling it this way rather than as a second nine-clause boolean is the
    // point: a pet whose listing the org paused is listable in every respect
    // except that it is paused. Custody disputes and rabies observations must
    // keep answering 404 — a paused screen naming the shelter would tell a
    // stranger which animal is in a dispute.
    const pausedOnly =
      org !== null &&
      pet.adoptionListingPausedAt !== null &&
      isListable(
        {
          adoptionListedAt: pet.adoptionListedAt,
          adoptionListingPausedAt: null,
          status: pet.status,
          adoptionEligible: pet.adoptionEligible,
          inCustodyDispute: pet.inCustodyDispute,
          rabiesObservationStatus: pet.rabiesObservationStatus,
        },
        { verified: org.verified, orgType: org.orgType },
      );
    if (pausedOnly && org !== null) {
      return {
        state: "paused",
        petToken: pet.publicToken,
        name: pet.name,
        orgName: org.displayName,
      };
    }
    return { state: "gone" };
  }
  if (org === null) return { state: "gone" };

  const openSponsorship = await findOpenSponsorship(pet.id, db);
  const livesWithFamily = livesWithFamilyUnder(openSponsorship, org.id);

  const extras = await db
    .select({ id: attachments.id, storagePath: attachments.storagePath })
    .from(attachments)
    .where(and(eq(attachments.petId, pet.id), isNull(attachments.eventId)))
    .limit(GALLERY_LIMIT);
  const [primaryRow] = pet.primaryPhotoId
    ? await db
        .select({ storagePath: attachments.storagePath })
        .from(attachments)
        .where(eq(attachments.id, pet.primaryPhotoId))
        .limit(1)
    : [];
  const photoUrls = [
    petPhotoUrl(primaryRow?.storagePath),
    ...extras.map((a) => petPhotoUrl(a.storagePath)),
  ]
    .filter((u): u is string => u !== null)
    .filter((u, i, arr) => arr.indexOf(u) === i);

  // BOOLEANS, AND THE MICROCHIP ONE THROUGH `hasActiveMicrochip`. PO-1: the full
  // code no longer even reaches server memory on this surface, so no future
  // render can leak it by accident.
  const health = {
    hasVaccinations: await hasEvent(pet.id, "vaccination_administered"),
    isSterilized: await hasEvent(pet.id, "sterilization_performed"),
    hasMicrochip: await hasActiveMicrochip(pet.id),
  };

  return {
    state: "listed",
    petToken: pet.publicToken,
    petId: pet.id,
    pet: {
      publicToken: pet.publicToken,
      name: pet.name,
      species: pet.species,
      breed: pet.breed,
      sex: pet.sex,
      color: pet.color,
      distinguishingFeatures: pet.distinguishingFeatures,
      jurisdictionLocality: pet.jurisdictionLocality,
      jurisdictionProvince: pet.jurisdictionProvince,
      adoptionAgeBucket: pet.adoptionAgeBucket,
      adoptionSizeEstimate: pet.adoptionSizeEstimate,
      adoptionEnergyLevel: pet.adoptionEnergyLevel,
      adoptionStory: pet.adoptionStory,
      adoptionRequirements: pet.adoptionRequirements,
      adoptionGoodWithKids: pet.adoptionGoodWithKids,
      adoptionGoodWithDogs: pet.adoptionGoodWithDogs,
      adoptionGoodWithCats: pet.adoptionGoodWithCats,
      adoptionNeedsYard: pet.adoptionNeedsYard,
      adoptionFeeArs: pet.adoptionFeeArs,
      discloseConditionsPublicly: pet.discloseConditionsPublicly,
      permanentConditions: pet.permanentConditions,
      permanentConditionsOther: pet.permanentConditionsOther,
    },
    org: {
      publicToken: org.publicToken,
      displayName: org.displayName,
      jurisdictionLocality: org.jurisdictionLocality,
      jurisdictionProvince: org.jurisdictionProvince,
    },
    photoUrls,
    health,
    livesWithFamily,
    custodySince: custodyStartedAt,
  };
}

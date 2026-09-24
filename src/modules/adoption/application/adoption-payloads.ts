// DB rows → the wire shapes in `@dim/contract/api`'s `adoption.ts`.
//
// PURE, AND THAT IS THE POINT RATHER THAN AN ACCIDENT
// ---------------------------------------------------------------------------
// Nothing here touches the database. Every function takes a row already read by
// the same query the WEB uses and returns the payload the phone gets, so the
// privacy rules of this surface — which fields leave the server at all — are
// decided in one file that a unit test can drive over every branch.
//
// The rules, and what each of them costs if it is quietly dropped:
//
//   · NO INTERNAL IDENTIFIERS. `AdoptionListingItem` carries `petId` and
//     `orgId` because the SQL needs them (the sponsorship read is keyed on
//     `petId`). They are not copied out. A spread — `{ ...item, photoUrl }` —
//     would put two UUIDs on the wire and read as a tidier version of the code
//     below, which is why every field is written out by hand.
//   · THE MICROCHIP IS A BOOLEAN AND ONLY A BOOLEAN. The canonical 15-digit
//     code is never selected by the queries feeding this file (PO-1,
//     2026-08-05: the public ficha used to render a masked form of it and was
//     the only one of sixteen canonical-identifier read sites not gated by
//     role). There is no field here it could be assigned to.
//   · `permanentConditions` IS GATED ON `discloseConditionsPublicly`. That
//     column is the owner's answer to "may strangers read this". Passing the
//     codes through and letting a client decide would move the decision to
//     whoever writes the next screen.
//
// THE LABELS ARE RESOLVED HERE, ONCE
// ---------------------------------------------------------------------------
// `ageBucketLabel`, `energyLabel` and `sterilizedLabel` all agree with the
// animal's SEX, and the public ficha shipped "Castrada" over a male dog because
// one call site hardcoded the feminine. These functions are the web's own; the
// phone gets their output rather than their inputs, so there is no second
// implementation of the agreement to get wrong. See `@dim/contract/api`'s
// `adoption.ts` header.

import type {
  AdoptionCatalogueItemV1,
  AdoptionDetailClosedV1,
  AdoptionDetailListedV1,
  AdoptionDetailOrgV1,
  MyAdoptionApplicationV1,
} from "@dim/contract/api";
import type { PetSex } from "@dim/contract/api";

import type { AdoptionListingItem } from "@/lib/infra/adoption-listing";
import { ageBucketLabel, energyLabel, sizeLabel } from "@/lib/infra/adoption-listing";
import { petPhotoUrl } from "@/lib/infra/storage";
import {
  isPermanentCondition,
  permanentConditionLabel,
} from "@/lib/reference/permanent-conditions";
import { sexLabel, speciesLabel, sterilizedLabel } from "@/lib/utils/format";

import type { MyApplicationRow } from "../infrastructure/my-applications-read";

/**
 * The chip row: age bucket, size, energy — in the ficha's order, skipping what
 * the shelter left blank.
 *
 * ONE FUNCTION FOR BOTH SURFACES. The card and the ficha built the same three
 * chips from the same three columns in two places; a phone reading a list and
 * then a detail must not see the animal described differently by one word.
 */
export function adoptionFacts(pet: {
  adoptionAgeBucket: AdoptionListingItem["adoptionAgeBucket"];
  adoptionSizeEstimate: AdoptionListingItem["adoptionSizeEstimate"];
  adoptionEnergyLevel: AdoptionListingItem["adoptionEnergyLevel"];
  sex: string;
}): string[] {
  const facts: string[] = [];
  if (pet.adoptionAgeBucket) facts.push(ageBucketLabel(pet.adoptionAgeBucket, pet.sex));
  if (pet.adoptionSizeEstimate) facts.push(sizeLabel(pet.adoptionSizeEstimate));
  if (pet.adoptionEnergyLevel) facts.push(energyLabel(pet.adoptionEnergyLevel, pet.sex));
  return facts;
}

/**
 * `${listedAt}|${petId}` — the EXACT string the web's "Mostrar más" link
 * already carries in a public URL (`buildSearchParams`).
 *
 * IT CONTAINS THE PET'S ROW ID, and that is a deliberate re-use rather than an
 * oversight of the no-UUIDs rule above. The rule is about what a payload
 * DESCRIBES; this is an opaque continuation token whose encoding the web
 * already publishes, and inventing a second one would mean two keyset
 * implementations over the same index — the failure the rule is really about.
 * The contract says a client must not parse it.
 */
export function encodeAdoptionCursor(
  cursor: { listedAt: string; id: string } | null,
): string | null {
  return cursor === null ? null : `${cursor.listedAt}|${cursor.id}`;
}

/** The inverse, tolerant of anything a client echoes back that is not one. */
export function decodeAdoptionCursor(raw: string | null): { listedAt: string; id: string } | null {
  if (!raw) return null;
  const [listedAt, id] = raw.split("|");
  return listedAt && id ? { listedAt, id } : null;
}

/** One catalogue card. Every field written out — see the header on spreads. */
export function buildAdoptionCatalogueItem(item: AdoptionListingItem): AdoptionCatalogueItemV1 {
  return {
    petToken: item.petPublicToken,
    name: item.name,
    species: item.species,
    speciesLabel: speciesLabel(item.species),
    breed: item.breed,
    sex: item.sex as PetSex,
    sexLabel: sexLabel(item.sex),
    color: item.color,
    photoUrl: petPhotoUrl(item.primaryPhotoStoragePath),
    locality: item.jurisdictionLocality,
    province: item.jurisdictionProvince,
    facts: adoptionFacts(item),
    goodWithKids: item.adoptionGoodWithKids,
    goodWithDogs: item.adoptionGoodWithDogs,
    goodWithCats: item.adoptionGoodWithCats,
    needsYard: item.adoptionNeedsYard,
    hasMicrochip: item.hasMicrochip,
    isSterilized: item.isSterilized,
    sterilizedLabel: sterilizedLabel(item.sex),
    feeArs: item.adoptionFeeArs,
    orgToken: item.orgPublicToken,
    orgName: item.orgDisplayName,
    livesWithFamily: item.livesWithFamily,
  };
}

/** What the ficha needs about a pet, independent of how it was read. */
export type AdoptionDetailPetInput = {
  publicToken: string;
  name: string;
  species: string;
  breed: string | null;
  sex: string;
  color: string | null;
  distinguishingFeatures: string | null;
  jurisdictionLocality: string | null;
  jurisdictionProvince: string | null;
  adoptionAgeBucket: AdoptionListingItem["adoptionAgeBucket"];
  adoptionSizeEstimate: AdoptionListingItem["adoptionSizeEstimate"];
  adoptionEnergyLevel: AdoptionListingItem["adoptionEnergyLevel"];
  adoptionStory: string | null;
  adoptionRequirements: string | null;
  adoptionGoodWithKids: boolean | null;
  adoptionGoodWithDogs: boolean | null;
  adoptionGoodWithCats: boolean | null;
  adoptionNeedsYard: boolean | null;
  adoptionFeeArs: number | null;
  discloseConditionsPublicly: boolean;
  permanentConditions: string[];
  permanentConditionsOther: string | null;
};

export type AdoptionDetailOrgInput = {
  publicToken: string;
  displayName: string;
  jurisdictionLocality: string | null;
  jurisdictionProvince: string | null;
};

export function buildAdoptionDetailListed(input: {
  pet: AdoptionDetailPetInput;
  org: AdoptionDetailOrgInput;
  /** Primary first, then the pet-scoped extras, already resolved to URLs. */
  photoUrls: string[];
  health: { hasVaccinations: boolean; isSterilized: boolean; hasMicrochip: boolean };
  livesWithFamily: boolean;
  custodySince: Date | null;
  canApply: boolean;
  applyBlockedReason: AdoptionDetailListedV1["applyBlockedReason"];
}): AdoptionDetailListedV1 {
  const { pet, org } = input;

  // THE LOCALITY SWAP, WHICH IS THE WEB'S AND NOT A SIMPLIFICATION. A rehome
  // sponsorship gives the org the custody row while the animal stays with its
  // family, so the org's own address would answer "where is this animal" with a
  // place it has never been. The ficha shows the PET's locality in that case —
  // which is also what the catalogue filters on, so the two agree.
  const orgSection: AdoptionDetailOrgV1 = {
    orgToken: org.publicToken,
    name: org.displayName,
    locality: input.livesWithFamily ? pet.jurisdictionLocality : org.jurisdictionLocality,
    province: input.livesWithFamily ? pet.jurisdictionProvince : org.jurisdictionProvince,
    custodySince: input.custodySince ? input.custodySince.toISOString() : null,
    livesWithFamily: input.livesWithFamily,
  };

  // GATED, NOT FILTERED-ON-THE-CLIENT. See the header.
  const conditions = pet.discloseConditionsPublicly
    ? pet.permanentConditions.filter(isPermanentCondition).map(permanentConditionLabel)
    : [];

  return {
    state: "listed",
    petToken: pet.publicToken,
    name: pet.name,
    species: pet.species,
    speciesLabel: speciesLabel(pet.species),
    breed: pet.breed,
    sex: pet.sex as PetSex,
    sexLabel: sexLabel(pet.sex),
    color: pet.color,
    distinguishingFeatures: pet.distinguishingFeatures,
    photoUrls: input.photoUrls,
    locality: pet.jurisdictionLocality,
    province: pet.jurisdictionProvince,
    facts: adoptionFacts(pet),
    story: pet.adoptionStory,
    requirements: pet.adoptionRequirements,
    goodWithKids: pet.adoptionGoodWithKids,
    goodWithDogs: pet.adoptionGoodWithDogs,
    goodWithCats: pet.adoptionGoodWithCats,
    needsYard: pet.adoptionNeedsYard,
    feeArs: pet.adoptionFeeArs,
    health: {
      hasVaccinations: input.health.hasVaccinations,
      isSterilized: input.health.isSterilized,
      sterilizedLabel: sterilizedLabel(pet.sex),
      hasMicrochip: input.health.hasMicrochip,
    },
    permanentConditions: conditions,
    // The owner's free text only travels with the codes it explains, and only
    // when they named "otra" — the same pair of conditions the ficha renders it
    // under. Sending it while the codes are withheld would disclose the fact
    // through its own footnote.
    permanentConditionsOther:
      pet.discloseConditionsPublicly && pet.permanentConditions.includes("otra")
        ? pet.permanentConditionsOther
        : null,
    org: orgSection,
    canApply: input.canApply,
    applyBlockedReason: input.applyBlockedReason,
  };
}

/**
 * The two soft answers: adopted in the last seven days, or paused by the org.
 *
 * THEY CARRY A NAME AND NOTHING ELSE. Somebody arriving here followed a shared
 * link to an animal that is no longer available; the story, the photos and the
 * shelter's locality are not part of that answer, and a payload that carried
 * them "so the screen looks nicer" would keep publishing a listing the org took
 * down.
 */
export function buildAdoptionDetailClosed(input: {
  state: AdoptionDetailClosedV1["state"];
  petToken: string;
  name: string;
  orgName: string | null;
}): AdoptionDetailClosedV1 {
  return {
    state: input.state,
    petToken: input.petToken,
    name: input.name,
    orgName: input.state === "paused" ? input.orgName : null,
  };
}

/** One of the caller's own applications. D17 is enforced by what is absent. */
export function buildMyAdoptionApplication(row: MyApplicationRow): MyAdoptionApplicationV1 {
  return {
    applicationId: row.applicationId,
    petToken: row.petPublicToken,
    petName: row.petName,
    orgName: row.orgDisplayName,
    orgToken: row.orgPublicToken,
    submittedAt: row.submittedAt.toISOString(),
    status: row.status,
    decisionAt: row.decisionAt ? row.decisionAt.toISOString() : null,
    stillListed: row.stillListed,
  };
}

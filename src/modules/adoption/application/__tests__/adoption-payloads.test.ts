// What leaves the server on the adoption surface, asserted field by field.
//
// THE DEFECT THIS EXISTS FOR
// ---------------------------------------------------------------------------
// `/adoptar` is the one public surface this product has that describes an
// ANIMAL SOMEBODY ELSE HOLDS, and its history is a list of things that reached
// an anonymous reader by being in a row somebody spread onto a payload:
//
//   · the canonical microchip, masked, on the ficha — the only one of sixteen
//     canonical-identifier read sites not gated by role (PO-1, 2026-08-05);
//   · a stale custodian, because a `.limit(1)` over two ownership rows picked
//     the ended one (found live, 2026-08-18);
//   · "Castrada" over a male dog, because a label that agrees with sex was
//     hardcoded at one of three call sites.
//
// A native payload is a cheaper place to make all three mistakes than an HTML
// page, because nothing renders it where a person would notice. So the builders
// are PURE and this file drives them over every branch: the assertions below are
// about what is ABSENT as much as about what is present, and an absence is only
// testable if the shape is built by hand rather than spread.

import { describe, expect, it } from "vitest";

import type { AdoptionListingItem } from "@/lib/infra/adoption-listing";

import {
  adoptionFacts,
  buildAdoptionCatalogueItem,
  buildAdoptionDetailClosed,
  buildAdoptionDetailListed,
  buildMyAdoptionApplication,
  decodeAdoptionCursor,
  encodeAdoptionCursor,
} from "../adoption-payloads";
import type { AdoptionDetailOrgInput, AdoptionDetailPetInput } from "../adoption-payloads";

const PET_ROW_ID = "8f1d4f4e-0000-4000-8000-000000000001";
const ORG_ROW_ID = "8f1d4f4e-0000-4000-8000-000000000002";
const PHOTO_ROW_ID = "8f1d4f4e-0000-4000-8000-000000000003";

function listingItem(over: Partial<AdoptionListingItem> = {}): AdoptionListingItem {
  return {
    petId: PET_ROW_ID,
    petPublicToken: "DIM-ABCD-2345",
    name: "Lola",
    species: "dog",
    breed: "Mestiza",
    sex: "female",
    color: "Negra",
    primaryPhotoId: PHOTO_ROW_ID,
    primaryPhotoStoragePath: "pets/lola.jpg",
    jurisdictionProvince: "Río Negro",
    jurisdictionLocality: "San Carlos de Bariloche",
    hasMicrochip: true,
    adoptionListedAt: new Date("2026-08-01T12:00:00.000Z"),
    adoptionStory: "La encontramos en la ruta.",
    adoptionRequirements: "Patio cercado.",
    adoptionEnergyLevel: "high",
    adoptionSizeEstimate: "medium",
    adoptionAgeBucket: "adult",
    adoptionGoodWithKids: true,
    adoptionGoodWithDogs: null,
    adoptionGoodWithCats: false,
    adoptionNeedsYard: true,
    adoptionFeeArs: 15_000,
    orgId: ORG_ROW_ID,
    orgPublicToken: "ORG-1234",
    orgDisplayName: "Refugio Patitas",
    orgAvatarUrl: null,
    isSterilized: true,
    livesWithFamily: false,
    ...over,
  };
}

function detailPet(over: Partial<AdoptionDetailPetInput> = {}): AdoptionDetailPetInput {
  return {
    publicToken: "DIM-ABCD-2345",
    name: "Lola",
    species: "dog",
    breed: "Mestiza",
    sex: "female",
    color: "Negra",
    distinguishingFeatures: "Mancha blanca en el pecho.",
    jurisdictionLocality: "San Carlos de Bariloche",
    jurisdictionProvince: "Río Negro",
    adoptionAgeBucket: "adult",
    adoptionSizeEstimate: "medium",
    adoptionEnergyLevel: "high",
    adoptionStory: "La encontramos en la ruta.",
    adoptionRequirements: "Patio cercado.",
    adoptionGoodWithKids: true,
    adoptionGoodWithDogs: null,
    adoptionGoodWithCats: false,
    adoptionNeedsYard: true,
    adoptionFeeArs: 15_000,
    discloseConditionsPublicly: false,
    permanentConditions: [],
    permanentConditionsOther: null,
    ...over,
  };
}

const detailOrg: AdoptionDetailOrgInput = {
  publicToken: "ORG-1234",
  displayName: "Refugio Patitas",
  jurisdictionLocality: "Dina Huapi",
  jurisdictionProvince: "Río Negro",
};

function buildDetail(
  over: {
    pet?: Partial<AdoptionDetailPetInput>;
    livesWithFamily?: boolean;
    canApply?: boolean;
    applyBlockedReason?: "already_applied" | "institutional_account" | null;
  } = {},
) {
  return buildAdoptionDetailListed({
    pet: detailPet(over.pet),
    org: detailOrg,
    photoUrls: ["https://example.test/lola.jpg"],
    health: { hasVaccinations: true, isSterilized: true, hasMicrochip: true },
    livesWithFamily: over.livesWithFamily ?? false,
    custodySince: new Date("2026-07-07T00:00:00.000Z"),
    canApply: over.canApply ?? true,
    applyBlockedReason: over.applyBlockedReason ?? null,
  });
}

/** Every string that appears anywhere in a payload, however deeply nested. */
function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap(stringsIn);
  }
  return [];
}

describe("the catalogue card", () => {
  it("carries no internal row identifier anywhere in the payload", () => {
    // THE RULE THE SPREAD WOULD BREAK. `AdoptionListingItem` holds `petId`,
    // `orgId` and `primaryPhotoId` because the SQL needs them; `{ ...item }`
    // would have put all three on the wire and read like tidier code.
    const strings = stringsIn(buildAdoptionCatalogueItem(listingItem()));
    for (const uuid of [PET_ROW_ID, ORG_ROW_ID, PHOTO_ROW_ID]) {
      expect(strings, `${uuid} reached the wire`).not.toContain(uuid);
    }
    // Not a UUID-shaped value of ANY kind — a future column named differently
    // must fail here too rather than only the three above.
    const uuidish = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(strings.filter((s) => uuidish.test(s))).toEqual([]);
  });

  it("names the pet by its public token and the org by its own", () => {
    const card = buildAdoptionCatalogueItem(listingItem());
    expect(card.petToken).toBe("DIM-ABCD-2345");
    expect(card.orgToken).toBe("ORG-1234");
  });

  it("says THAT the animal is chipped and never which chip", () => {
    const card = buildAdoptionCatalogueItem(listingItem());
    expect(card.hasMicrochip).toBe(true);
    // There is no field for the code, and this asserts the shape rather than a
    // value: a `microchip` key appearing here at all is the regression.
    expect(Object.keys(card)).not.toContain("microchip");
    expect(Object.keys(card)).not.toContain("microchipNumber");
  });

  it("agrees with the animal's sex in the sterilization label", () => {
    // THE 2026-08 SCAR. A hardcoded feminine shipped over a male dog on the
    // public ficha; the label travels resolved so a client cannot repeat it.
    expect(buildAdoptionCatalogueItem(listingItem({ sex: "female" })).sterilizedLabel).toBe(
      "Castrada",
    );
    expect(buildAdoptionCatalogueItem(listingItem({ sex: "male" })).sterilizedLabel).toBe(
      "Castrado",
    );
  });

  it("keeps a `null` convivencia answer null rather than folding it to false", () => {
    // "No sabemos" and "no" are different facts and the ficha draws them
    // differently — a chip that is absent versus a chip that says no.
    const card = buildAdoptionCatalogueItem(listingItem());
    expect(card.goodWithDogs).toBeNull();
    expect(card.goodWithCats).toBe(false);
  });

  it("hands back no photo URL when the shelter uploaded none", () => {
    const card = buildAdoptionCatalogueItem(listingItem({ primaryPhotoStoragePath: null }));
    expect(card.photoUrl).toBeNull();
  });
});

describe("the chip row", () => {
  it("skips what the shelter left blank instead of rendering a gap", () => {
    expect(
      adoptionFacts({
        adoptionAgeBucket: null,
        adoptionSizeEstimate: "small",
        adoptionEnergyLevel: null,
        sex: "female",
      }),
    ).toEqual(["Chico"]);
  });

  it("is the same three chips in the same order for the card and the ficha", () => {
    // ONE FUNCTION, so a phone reading a list and then a detail cannot see the
    // animal described differently by one word.
    const card = buildAdoptionCatalogueItem(listingItem());
    expect(buildDetail().facts).toEqual(card.facts);
    expect(card.facts.length).toBe(3);
  });
});

describe("the ficha's permanent conditions", () => {
  it("withholds them entirely when the owner did not disclose them", () => {
    const detail = buildDetail({
      pet: {
        discloseConditionsPublicly: false,
        permanentConditions: ["ciego", "otra"],
        permanentConditionsOther: "Tiene tres patas.",
      },
    });
    expect(detail.permanentConditions).toEqual([]);
    expect(detail.permanentConditionsOther).toBeNull();
  });

  it("discloses the labels, not the codes, when the owner did", () => {
    const detail = buildDetail({
      pet: {
        discloseConditionsPublicly: true,
        permanentConditions: ["ciego"],
        permanentConditionsOther: null,
      },
    });
    expect(detail.permanentConditions).not.toContain("ciego");
    expect(detail.permanentConditions.length).toBe(1);
  });

  it("never sends the free text without the codes it explains", () => {
    // THE FOOTNOTE LEAK. `permanentConditionsOther` is the owner's own sentence
    // about a condition; carrying it while the codes are withheld would
    // disclose the fact through its explanation.
    const withheld = buildDetail({
      pet: {
        discloseConditionsPublicly: false,
        permanentConditions: ["otra"],
        permanentConditionsOther: "Tiene tres patas.",
      },
    });
    expect(withheld.permanentConditionsOther).toBeNull();

    const disclosed = buildDetail({
      pet: {
        discloseConditionsPublicly: true,
        permanentConditions: ["otra"],
        permanentConditionsOther: "Tiene tres patas.",
      },
    });
    expect(disclosed.permanentConditionsOther).toBe("Tiene tres patas.");
  });

  it("drops the free text when the owner disclosed conditions but none is `otra`", () => {
    const detail = buildDetail({
      pet: {
        discloseConditionsPublicly: true,
        permanentConditions: ["ciego"],
        permanentConditionsOther: "Un texto viejo que nadie borró.",
      },
    });
    expect(detail.permanentConditionsOther).toBeNull();
  });
});

describe("the ficha's organization card", () => {
  it("gives the ORG's locality for an animal a shelter holds", () => {
    const detail = buildDetail({ livesWithFamily: false });
    expect(detail.org.locality).toBe("Dina Huapi");
    expect(detail.org.livesWithFamily).toBe(false);
  });

  it("gives the PET's locality when the animal lives with its family", () => {
    // REQ-12. A rehome sponsorship gives the org the custody row while the
    // animal stays home, so the org's own address would answer "where is this
    // animal" with a place it has never been — and the catalogue filters on the
    // pet's locality, so the two would also disagree.
    const detail = buildDetail({ livesWithFamily: true });
    expect(detail.org.locality).toBe("San Carlos de Bariloche");
    expect(detail.org.province).toBe("Río Negro");
  });
});

describe("the two soft answers", () => {
  it("says who paused a listing and nothing else about the animal", () => {
    const closed = buildAdoptionDetailClosed({
      state: "paused",
      petToken: "DIM-ABCD-2345",
      name: "Lola",
      orgName: "Refugio Patitas",
    });
    expect(closed).toEqual({
      state: "paused",
      petToken: "DIM-ABCD-2345",
      name: "Lola",
      orgName: "Refugio Patitas",
    });
  });

  it("does not name an organization on a pet that already found a home", () => {
    // The web's `RecentlyAdopted` says only the pet's name. A shelter's name on
    // a finalized adoption invites a message the shelter cannot act on.
    const closed = buildAdoptionDetailClosed({
      state: "recently_adopted",
      petToken: "DIM-ABCD-2345",
      name: "Lola",
      orgName: "Refugio Patitas",
    });
    expect(closed.orgName).toBeNull();
  });
});

describe("mis postulaciones", () => {
  const row = {
    applicationId: "ev-1",
    petPublicToken: "DIM-ABCD-2345",
    petName: "Lola",
    petCurrentStatus: "active",
    orgDisplayName: "Refugio Patitas",
    orgPublicToken: "ORG-1234",
    submittedAt: new Date("2026-08-02T10:00:00.000Z"),
    status: "pending" as const,
    decisionAt: null,
    stillListed: true,
  };

  it("carries nothing about anybody else's application (D17)", () => {
    // The rule is enforced by ABSENCE, so the assertion is over the key set:
    // a `queuePosition` or `applicantCount` added upstream would appear here.
    expect(Object.keys(buildMyAdoptionApplication(row)).sort()).toEqual([
      "applicationId",
      "decisionAt",
      "orgName",
      "orgToken",
      "petName",
      "petToken",
      "status",
      "stillListed",
      "submittedAt",
    ]);
  });

  it("keeps `auto_rejected` distinct from `rejected`", () => {
    // Collapsing the two would tell somebody they were turned down when the
    // animal simply went to another applicant.
    expect(buildMyAdoptionApplication({ ...row, status: "auto_rejected" }).status).toBe(
      "auto_rejected",
    );
    expect(buildMyAdoptionApplication({ ...row, status: "rejected" }).status).toBe("rejected");
  });

  it("sends dates as ISO strings and a missing decision as null", () => {
    const built = buildMyAdoptionApplication(row);
    expect(built.submittedAt).toBe("2026-08-02T10:00:00.000Z");
    expect(built.decisionAt).toBeNull();
  });
});

describe("the catalogue cursor", () => {
  it("round-trips the web's own encoding", () => {
    const cursor = { listedAt: "2026-08-01T12:00:00.000Z", id: PET_ROW_ID };
    const encoded = encodeAdoptionCursor(cursor);
    expect(encoded).toBe(`2026-08-01T12:00:00.000Z|${PET_ROW_ID}`);
    expect(decodeAdoptionCursor(encoded)).toEqual(cursor);
  });

  it("treats anything else a client echoes back as no cursor", () => {
    // A malformed cursor must restart the list, never 400: the alternative is a
    // client one release behind being unable to open the catalogue at all.
    expect(decodeAdoptionCursor(null)).toBeNull();
    expect(decodeAdoptionCursor("")).toBeNull();
    expect(decodeAdoptionCursor("solo-una-parte")).toBeNull();
    expect(decodeAdoptionCursor("|")).toBeNull();
  });
});

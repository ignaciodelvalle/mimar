// `buildOwnerPetDetailV1` — the owner face's wire projection.
//
// WHAT THIS FILE EXISTS FOR
// ---------------------------------------------------------------------------
// The carousel section is documented, in the contract, as "the owner's OTHER
// live pets" — and it was shipping the pet being read. The web does not notice,
// because the same list is its swipe SWITCHER and needs the current animal in
// it. A client does: the native face filtered `items` for rendering and then
// branched and counted on the unfiltered array, so a one-pet owner got a "Tus
// otras mascotas" card containing nothing at all, and a nine-pet owner read
// "Mostrando 8 de 9" above seven rows.
//
// Both halves are pinned here, and the second is the one a reviewer should look
// at hardest: excluding the animal from `items` while leaving it inside `total`
// swaps one wrong number for another.
//
// The THIRD half — found by review after the first two shipped — is the flag
// beside them. `truncated` was borrowed from the reader, which answers "did the
// ranking hit its cap"; this section answers "is this list a prefix of its
// total", and the self-subtraction is exactly what makes those two questions
// different. They disagree on one household: nine live pets, a cap of eight,
// and the animal being read ranking ninth.
//
// The `OwnerPetDetail` fixture names exactly the fields this projection reads
// and is cast at the boundary. That is honest for a PURE projection — the
// domain read has its own 22 tests over injected deps
// (`load-owner-pet-detail.test.ts`) — and it would not be honest for anything
// that branched on a field the fixture omits.

import { describe, expect, it } from "vitest";

import { buildOwnerPetDetailV1 } from "@/app/api/v1/pets/[publicToken]/payload";
import type { OwnerPetDetail } from "@/src/modules/pets/application/read/load-owner-pet-detail";
import type {
  CredentialSection,
  OwnerPetPostAdoptionCheckinSection,
  OwnerPetPppRegistriesSection,
} from "@dim/contract/api";

const NOW = new Date("2026-08-25T12:00:00Z");
const SELF = "DIM-PAMP-0001";

function carouselItem(token: string) {
  return { token, name: `pet-${token}`, photoUrl: null, status: "active" };
}

function detailStub(
  carousel: {
    items: Array<{ token: string; name: string; photoUrl: string | null; status: string }>;
    total: number;
    truncated: boolean;
  },
  openCases: Array<{ publicCode: string; caseKind: string; status: string }> = [],
): OwnerPetDetail {
  return {
    ownershipRole: "owner",
    isTransit: false,
    isDeceased: false,
    identity: {
      name: "Pampa",
      species: "dog",
      sex: "female",
      breed: null,
      breedLine: "Perra",
      photoUrl: null,
      jurisdictionProvince: null,
      jurisdictionLocality: null,
      tags: [],
    },
    memorial: null,
    ringStatus: "al-dia",
    situation: null,
    chromeSituation: null,
    compliance: { cards: [], summary: "", worstTone: "ok", worstIsUnknown: false },
    alerts: [],
    reminders: [],
    pregnancy: null,
    cases: { openCount: openCases.length, openCases, truncated: false },
    carousel,
    caretakerState: null,
    caretakerConsentName: null,
    rehomeState: null,
    observationOpenedByOrgName: null,
  } as unknown as OwnerPetDetail;
}

function build(input: {
  petStatus?: string;
  accessPath?: "owner" | "org";
  carousel: Parameters<typeof detailStub>[0];
  /** The sections the ROUTE resolves; this file's subject is the carousel. */
  pppRegistries?: CredentialSection<OwnerPetPppRegistriesSection>;
  postAdoptionCheckin?: CredentialSection<OwnerPetPostAdoptionCheckinSection>;
  openCases?: Array<{ publicCode: string; caseKind: string; status: string }>;
}) {
  return buildOwnerPetDetailV1({
    publicToken: SELF,
    petStatus: input.petStatus ?? "active",
    pregnancyStatus: null,
    accessPath: input.accessPath ?? "owner",
    detail: detailStub(input.carousel, input.openCases),
    pppRegistries: input.pppRegistries ?? { status: "ok", data: null },
    postAdoptionCheckin: input.postAdoptionCheckin ?? { status: "ok", data: { pending: false } },
    now: NOW,
  });
}

// ---------------------------------------------------------------------------
// The cases section
// ---------------------------------------------------------------------------

const NO_CAROUSEL = { items: [], total: 0, truncated: false };

describe("buildOwnerPetDetailV1 — the open cases carry their CODES", () => {
  it("hands back the CAS- code, the kind and the status of every open case", () => {
    // The reason this section stopped being a bare count: a person who reports
    // a mordedura has to quote `CAS-XXXX-XXXX` afterwards, and before this the
    // app could say "1 tramite abierto" without saying which one.
    const payload = build({
      carousel: NO_CAROUSEL,
      openCases: [
        { publicCode: "CAS-1111-2222", caseKind: "bite_incident", status: "open" },
        { publicCode: "CAS-3333-4444", caseKind: "custody_dispute", status: "escalated" },
      ],
    });
    const section = payload.cases;
    if (section.status !== "ok") throw new Error("cases section must be ok");
    expect(section.data.items).toEqual([
      { casePublicCode: "CAS-1111-2222", kind: "bite_incident", status: "open" },
      { casePublicCode: "CAS-3333-4444", kind: "custody_dispute", status: "escalated" },
    ]);
    // The list and the count describe the same set; they come from one window.
    expect(section.data.openCount).toBe(2);
  });

  it("clamps a kind outside the contract's vocabulary to `other`", () => {
    // `cases.case_kind` is TEXT with no enum behind it and staging carries
    // `rabies_observation` rows that no code path can close. The row still
    // belongs to this owner, so it is reported — under a word a client has.
    const payload = build({
      carousel: NO_CAROUSEL,
      openCases: [{ publicCode: "CAS-9999-0000", caseKind: "rabies_observation", status: "open" }],
    });
    const section = payload.cases;
    if (section.status !== "ok") throw new Error("cases section must be ok");
    expect(section.data.items).toEqual([
      { casePublicCode: "CAS-9999-0000", kind: "other", status: "open" },
    ]);
  });
});

describe("buildOwnerPetDetailV1 — the carousel is the owner's OTHER pets", () => {
  it("drops the animal being read from the list", () => {
    const payload = build({
      carousel: {
        items: [carouselItem(SELF), carouselItem("DIM-FIRU-0002")],
        total: 2,
        truncated: false,
      },
    });
    const section = payload.carousel;
    if (section.status !== "ok") throw new Error("carousel section must be ok");
    expect(section.data.items.map((p) => p.publicToken)).toEqual(["DIM-FIRU-0002"]);
  });

  it("drops it from the COUNT too, so the truncation note cannot lie", () => {
    // Nine live pets, eight returned by the cap, one of the eight is this
    // animal. Seven render; the honest sentence is "mostrando 7 de 8", NOT
    // "7 de 9" (self still counted) and not "8 de 9" (the old bug's numbers).
    const tokens = ["DIM-A", "DIM-B", "DIM-C", "DIM-D", "DIM-E", "DIM-F", "DIM-G"];
    const payload = build({
      carousel: {
        items: [carouselItem(SELF), ...tokens.map(carouselItem)],
        total: 9,
        truncated: true,
      },
    });
    const section = payload.carousel;
    if (section.status !== "ok") throw new Error("carousel section must be ok");
    expect(section.data.items).toHaveLength(7);
    expect(section.data.total).toBe(8);
  });

  it("subtracts even when the cap pushed this animal out of the returned items", () => {
    // THE CASE A `items.includes(self)` TEST WOULD GET WRONG. The ranking caps
    // at 8 over EVERY live pet, so an animal that ranks ninth is absent from
    // `items` and still counted in `total`. Deriving the subtraction from the
    // returned page would leave the total one too high on exactly the
    // households big enough to notice.
    const payload = build({
      carousel: { items: [carouselItem("DIM-A")], total: 9, truncated: true },
    });
    const section = payload.carousel;
    if (section.status !== "ok") throw new Error("carousel section must be ok");
    expect(section.data.total).toBe(8);
  });

  it("calls a COMPLETE list complete, even when the ranking behind it was capped", () => {
    // THE HOUSEHOLD WHERE THE READER'S FLAG AND THIS SECTION'S DISAGREE. Nine
    // live pets, the ranking caps at eight and says truncated, and the animal
    // being read ranks NINTH — so the page it returned is all eight others.
    // After the subtraction the total is eight and the list holds eight: there
    // is nothing beyond it, and a borrowed `true` would have a client print
    // "mostrando 8 de 8" beside a note that more exist.
    const tokens = ["DIM-A", "DIM-B", "DIM-C", "DIM-D", "DIM-E", "DIM-F", "DIM-G", "DIM-H"];
    const payload = build({
      carousel: { items: tokens.map(carouselItem), total: 9, truncated: true },
    });
    const section = payload.carousel;
    if (section.status !== "ok") throw new Error("carousel section must be ok");
    expect(section.data.items).toHaveLength(8);
    expect(section.data.total).toBe(8);
    expect(section.data.truncated).toBe(false);
  });

  it("still reports truncation when the list really is a prefix", () => {
    // The same nine-pet household with the current animal INSIDE the capped
    // page: seven others render against a total of eight, and the note is true.
    const tokens = ["DIM-A", "DIM-B", "DIM-C", "DIM-D", "DIM-E", "DIM-F", "DIM-G"];
    const payload = build({
      carousel: {
        items: [carouselItem(SELF), ...tokens.map(carouselItem)],
        total: 9,
        truncated: true,
      },
    });
    const section = payload.carousel;
    if (section.status !== "ok") throw new Error("carousel section must be ok");
    expect(section.data.truncated).toBe(true);
  });

  it("does NOT subtract for a deceased animal, which was never in the count", () => {
    // `fetchLivePetsForCarouselRanking` excludes `status = 'deceased'`, so a
    // deceased pet's own libreta must not report one fewer sibling than the
    // owner has.
    const payload = build({
      petStatus: "deceased",
      carousel: { items: [carouselItem("DIM-A")], total: 1, truncated: false },
    });
    const section = payload.carousel;
    if (section.status !== "ok") throw new Error("carousel section must be ok");
    expect(section.data.total).toBe(1);
  });

  it("does NOT subtract on the ORG path, which gets no carousel at all", () => {
    const payload = build({
      accessPath: "org",
      carousel: { items: [], total: 0, truncated: false },
    });
    const section = payload.carousel;
    if (section.status !== "ok") throw new Error("carousel section must be ok");
    expect(section.data.total).toBe(0);
  });
});

describe("buildOwnerPetDetailV1 — the sections the route resolves cross untouched", () => {
  it("passes the check-in section through as the route resolved it, unavailable included", () => {
    // The builder is a pure mapping over `detail`; this section is a READ of
    // the route's own, with its own budget. A builder that re-derived it — or
    // flattened `unavailable` into `pending: false` — would hide the one row
    // the adopter came for behind a network blip.
    const carousel = { items: [], total: 0, truncated: false };
    const pending = build({
      carousel,
      postAdoptionCheckin: { status: "ok", data: { pending: true } },
    });
    expect(pending.postAdoptionCheckin).toEqual({ status: "ok", data: { pending: true } });

    const degraded = build({ carousel, postAdoptionCheckin: { status: "unavailable" } });
    expect(degraded.postAdoptionCheckin).toEqual({ status: "unavailable" });
  });
});

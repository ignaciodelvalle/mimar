// The four answers `/adoptar/{token}` gives, and the one that is a privacy rule.
//
// ===========================================================================
// WHAT WAS UNFENCED
// ===========================================================================
// `readAdoptionDetail` had no test of any kind. The branch that needed one most
// is the PAUSE branch, whose docblock states a privacy rule in so many words:
//
//   "Custody disputes and rabies observations must keep answering 404 — a paused
//    screen naming the shelter would tell a stranger which animal is in a
//    dispute."
//
// That is the whole point of re-running `isListable` with exactly ONE guard
// inverted instead of writing a second boolean. Invert a second guard by
// accident and the screen still renders, still says something reasonable, and
// now answers "which animal is your organisation fighting over" to anybody
// holding a token — a question no unauthenticated surface in this product is
// allowed to answer.
//
// The reviewer at the integration gate mutated this branch and the suite stayed
// green, so the first hand-off's claim that the ficha's privacy was pinned was
// not true. It is now.
//
// Every test names the mutation that reddens it. All eight were applied.

import { beforeEach, describe, expect, it, vi } from "vitest";

const repo = vi.hoisted(() => ({
  found: null as unknown,
  finalizedAt: null as Date | null,
}));

vi.mock("../adoption-repository", () => ({
  AdoptionRepository: {
    findPetForPublicDetail: async () => repo.found,
    findLatestAdoptionFinalizedAt: async () => repo.finalizedAt,
  },
}));

vi.mock("../rehome-sponsorship-writer", () => ({
  findOpenSponsorship: async () => null,
}));

vi.mock("@/lib/infra/pet-identifiers", () => ({
  hasActiveMicrochip: async () => false,
}));

vi.mock("@/lib/infra/storage", () => ({
  petPhotoUrl: (path: string | null | undefined) => (path ? `https://cdn/${path}` : null),
}));

// A drizzle SELECT chain that answers nothing. This module's remaining direct
// queries are the two `hasEvent` presence checks and the gallery read; none of
// them is what this file is about, and all three terminate on `.limit()`.
const chain = vi.hoisted(() => {
  // `any` is deliberate — a builder stub is untyped by nature — and it needs no
  // `biome-ignore`: `noExplicitAny` is already "off" for this glob in
  // `biome.json`, so the suppression this line used to carry suppressed nothing.
  const self: any = {};
  self.select = () => self;
  self.from = () => self;
  self.where = () => self;
  self.limit = async () => [];
  return self;
});

vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  return { ...actual, db: chain };
});

import { RECENTLY_ADOPTED_WINDOW_MS, readAdoptionDetail } from "../adoption-detail-read";

const NOW = new Date("2026-08-30T12:00:00.000Z");
const TOKEN = "DIM-PAMP-0001";

/** A pet that passes every listability guard. */
function pet(over: Record<string, unknown> = {}) {
  return {
    id: "pet-1",
    publicToken: TOKEN,
    name: "Pampa",
    species: "dog",
    breed: "mestizo",
    sex: "female",
    color: "negro",
    distinguishingFeatures: null,
    jurisdictionLocality: "San Carlos de Bariloche",
    jurisdictionProvince: "Río Negro",
    adoptionListedAt: new Date("2026-08-01T00:00:00.000Z"),
    adoptionListingPausedAt: null,
    status: "active",
    adoptionEligible: true,
    inCustodyDispute: false,
    rabiesObservationStatus: null,
    adoptionAgeBucket: "adult",
    adoptionSizeEstimate: "medium",
    adoptionEnergyLevel: "calm",
    adoptionStory: null,
    adoptionRequirements: null,
    adoptionGoodWithKids: null,
    adoptionGoodWithDogs: null,
    adoptionGoodWithCats: null,
    adoptionNeedsYard: null,
    adoptionFeeArs: null,
    primaryPhotoId: null,
    discloseConditionsPublicly: false,
    permanentConditions: [],
    permanentConditionsOther: null,
    ...over,
  };
}

/** A verified shelter, which is what makes a pet listable at all. */
function org(over: Record<string, unknown> = {}) {
  return {
    id: "org-1",
    publicToken: "ORG-1",
    displayName: "Refugio Ñireco",
    verified: true,
    orgType: "shelter",
    jurisdictionLocality: "Dina Huapi",
    jurisdictionProvince: "Río Negro",
    ...over,
  };
}

function read(petOver: Record<string, unknown> = {}, orgRow: unknown = org(), now: Date = NOW) {
  repo.found = { pet: pet(petOver), org: orgRow, custodyStartedAt: null };
  return readAdoptionDetail(TOKEN, now);
}

beforeEach(() => {
  repo.found = null;
  repo.finalizedAt = null;
});

describe("the pause branch is a PRIVACY rule, not a rendering convenience", () => {
  it("answers `gone` for an animal in a custody dispute, never `paused`", () => {
    // THE LEAK THIS BRANCH EXISTS TO PREVENT. `paused` names the shelter; a
    // stranger holding a token would learn which animal that organisation is
    // fighting over, from a surface that asks for no credential at all.
    //
    // MUTATION APPLIED: pass `inCustodyDispute: false` into the `pausedOnly`
    // re-check instead of `pet.inCustodyDispute`. The screen renders, the copy
    // is reasonable, and the leak is complete. Red.
    return expect(
      read({ inCustodyDispute: true, adoptionListingPausedAt: new Date() }),
    ).resolves.toEqual({ state: "gone" });
  });

  it("answers `gone` for an animal under rabies observation, never `paused`", () => {
    // The other half of the same sentence in the docblock. An animal under
    // observation after a bite is a health-and-legal fact about a specific
    // household, and `paused` would attach it to a named shelter.
    //
    // MUTATION APPLIED: pass `rabiesObservationStatus: null` into the
    // `pausedOnly` re-check. Red.
    return expect(
      read({ rabiesObservationStatus: "in_progress", adoptionListingPausedAt: new Date() }),
    ).resolves.toEqual({ state: "gone" });
  });

  it("answers `gone` for an animal that was NEVER listed, even with a pause stamp", () => {
    // MUTATION APPLIED: drop `pet.adoptionListedAt` from the `pausedOnly`
    // re-check — the soft answer would then name a shelter for an animal that
    // was never published at all, which is a disclosure with no act behind it.
    return expect(
      read({ adoptionListedAt: null, adoptionListingPausedAt: new Date() }),
    ).resolves.toEqual({ state: "gone" });
  });

  it("answers `gone` when the pet has no live shelter custody at all", () => {
    // MUTATION APPLIED: delete `if (org === null) return { state: "gone" };`.
    // TypeScript catches the listed branch, so the mutation actually applied was
    // dropping `org !== null` from `pausedOnly` — a pet with no custodian gets a
    // paused screen naming an organisation that does not exist. Red.
    return expect(read({ adoptionListingPausedAt: new Date() }, null)).resolves.toEqual({
      state: "gone",
    });
  });

  it("DOES answer `paused`, with the org name, when the pause is the only thing wrong", () => {
    // THE NON-VACUITY TEST, and it is the one that makes the four above mean
    // something: a branch that answered `gone` unconditionally would satisfy all
    // of them.
    //
    // MUTATION APPLIED: `return { state: "gone" }` in place of the paused
    // return. Red here alone.
    return expect(read({ adoptionListingPausedAt: new Date() })).resolves.toEqual({
      state: "paused",
      petToken: TOKEN,
      name: "Pampa",
      orgName: "Refugio Ñireco",
    });
  });
});

describe("D7.2 — a stale share link gets a sentence, not a 404", () => {
  it("prefers `recently_adopted` over `paused` inside the window", () => {
    // ORDER MATTERS AND IS COPIED FROM THE WEB. An animal adopted yesterday
    // whose listing was also paused is not "paused" — the person following the
    // link wants to know it found a home.
    //
    // MUTATION APPLIED: move the finalization check BELOW the pause branch. Red.
    repo.finalizedAt = new Date(NOW.getTime() - 60_000);
    return expect(read({ adoptionListingPausedAt: new Date() })).resolves.toEqual({
      state: "recently_adopted",
      petToken: TOKEN,
      name: "Pampa",
    });
  });

  it("falls back to `gone` once the window has passed", () => {
    // The animal here is unlistable for a reason the pause branch does not
    // cover (the org marked it ineligible), so the only thing that could keep
    // it answering is the D7.2 window — and it has expired.
    //
    // MUTATION APPLIED: `>` for `<` on the window comparison — every adoption
    // ever would answer `recently_adopted` forever, and nothing else in the repo
    // would notice. Red.
    repo.finalizedAt = new Date(NOW.getTime() - RECENTLY_ADOPTED_WINDOW_MS - 1);
    return expect(read({ adoptionEligible: false })).resolves.toEqual({ state: "gone" });
  });

  it("still answers `recently_adopted` for that same animal INSIDE the window", () => {
    // NON-VACUITY for the test above: an animal that answered `gone` for a
    // reason unrelated to the clock would satisfy it with the comparison deleted
    // entirely.
    repo.finalizedAt = new Date(NOW.getTime() - RECENTLY_ADOPTED_WINDOW_MS + 60_000);
    return expect(read({ adoptionEligible: false })).resolves.toEqual({
      state: "recently_adopted",
      petToken: TOKEN,
      name: "Pampa",
    });
  });
});

describe("the listed answer", () => {
  it("carries the disclosure flag and the conditions through UNCHANGED", () => {
    // THIS READER DOES NOT GATE, AND THAT IS DELIBERATE: the gate lives in
    // `buildAdoptionDetailListed`, which both surfaces call. What this pins is
    // that the reader hands the builder the REAL flag — a reader that passed
    // `true` unconditionally would defeat the gate from behind, and every test
    // in `adoption-payloads.test.ts` would stay green because it calls the
    // builder directly.
    //
    // MUTATION APPLIED: `discloseConditionsPublicly: true` as a literal. Red.
    return expect(
      read({ discloseConditionsPublicly: false, permanentConditions: ["ciego"] }).then((r) =>
        r.state === "listed" ? r.pet.discloseConditionsPublicly : "not listed",
      ),
    ).resolves.toBe(false);
  });
});

// The citizen-facing adoption reads, fenced on the SQL they actually build.
//
// ===========================================================================
// THE CLAIM THIS FILE REPLACES
// ===========================================================================
// WU-U's first hand-off said the public soft-delete surface was "closed on the
// way in, WITH A TEST". The second half was false: a reviewer mutated
// `findPetForPublicDetail`'s `unerasedPetByToken(petPublicToken)` down to a bare
// `eq(pets.publicToken, …)` and the whole suite stayed green. What existed was
// `__tests__/public-soft-delete-resolution.test.ts`, a source-text sweep that
// counts `pets` reads against `deleted_at` guards across `app/` — a real
// instrument for finding files nobody remembered, and one that never looks at
// `src/modules/adoption/infrastructure/` at all.
//
// So the surface was closed and unfenced, which is the state that decays: the
// next edit to that method meets no resistance. This file is the fence, and it
// is anchored where the board says to anchor it — in the COMPILED predicate, not
// in the source text. `toContain("isNull(pets.deletedAt)")` passes for
// `or(isNull(pets.deletedAt), sql`true`)`; an equality on
// `PgDialect().sqlToQuery()` output does not.
//
// WHAT IS AT STAKE, precisely: `/adoptar/{token}` is a PUBLIC ficha. A pet whose
// titular exercised art. 16 (Ley 25.326) keeps its row — the spine is
// append-only — and carries `deleted_at`. Without the guard the animal's name,
// photos, breed and shelter keep answering a QR anybody can scan.
//
// Every test names the mutation that reddens it. All nine were applied.

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Everything the stubbed drizzle chain recorded, one entry per query. */
type RecordedQuery = {
  joins: unknown[];
  where: unknown;
  orderBy: unknown[];
};

const control = vi.hoisted(() => ({
  queries: [] as RecordedQuery[],
  /** Rows each successive terminal `.limit()` resolves with. */
  results: [] as unknown[][],
}));

// A drizzle SELECT chain that RECORDS what it was handed.
//
// `.limit()` is the terminal call in every query in the module under test, so it
// is the one that resolves; the rest hand the chain back. The recorded `where`
// is the point of the whole stub — a stub that dropped it would make every
// assertion in this file an assertion that the predicate does not matter, which
// is exactly the defect the turnos post-mortem on the board describes.
const chain = vi.hoisted(() => {
  // `any` is deliberate — a builder stub is untyped by nature — and it needs no
  // `biome-ignore`: `noExplicitAny` is already "off" for this glob in
  // `biome.json`, so the suppression this line used to carry suppressed nothing
  // and biome reported it as `suppressions/unused`.
  const self: any = {};
  let current: RecordedQuery | null = null;
  const start = () => {
    current = { joins: [], where: null, orderBy: [] };
    control.queries.push(current);
    return self;
  };
  self.select = () => start();
  self.from = () => self;
  self.innerJoin = (_table: unknown, on: unknown) => {
    current?.joins.push(on);
    return self;
  };
  self.where = (predicate: unknown) => {
    if (current) current.where = predicate;
    return self;
  };
  self.orderBy = (...args: unknown[]) => {
    current?.orderBy.push(...args);
    return self;
  };
  self.limit = async () => control.results[control.queries.length - 1] ?? [];
  return self;
});

// A PARTIAL mock: only `db` is replaced, so every table object stays real. A
// hand-written `@/db` would report a missing export as a BROKEN FILE, the one
// red `/CLAUDE.md` says may never be committed.
vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  return { ...actual, db: chain };
});

import { AdoptionPublicReads } from "../adoption-public-reads";
import { AdoptionRepository } from "../adoption-repository";

const TOKEN = "DIM-PAMP-0001";
const dialect = new PgDialect();
const compile = (fragment: unknown) => dialect.sqlToQuery(fragment as SQL);

beforeEach(() => {
  control.queries.length = 0;
  control.results.length = 0;
});

describe("findPetForPublicDetail — the pet lookup", () => {
  it("resolves the token through the art. 16 predicate and NOTHING weaker", async () => {
    // MUTATIONS APPLIED, all three red here:
    //   · `eq(pets.publicToken, petPublicToken)` in place of
    //     `unerasedPetByToken(petPublicToken)` — the exact mutation a reviewer
    //     applied against the previous hand-off, which nothing caught.
    //   · `or(unerasedPetByToken(petPublicToken), sql`true`)` — keeps the call,
    //     keeps every substring a source sweep looks for, resolves every token.
    //   · `isNotNull(pets.deletedAt)` — inverted, so ONLY erased pets resolve.
    control.results = [[{ id: "pet-1" }], []];
    await AdoptionRepository.findPetForPublicDetail(TOKEN);
    const { sql: text, params } = compile(control.queries[0]?.where);
    expect(text).toBe('("pets"."public_token" = $1 and "pets"."deleted_at" is null)');
    expect(params).toEqual([TOKEN]);
  });

  it("answers null for an erased pet WITHOUT asking a second question", async () => {
    // THE SHORT-CIRCUIT IS PART OF THE GUARD, not an optimisation. A token that
    // resolves to nothing must cost exactly one query and answer exactly like a
    // token that never existed — a second lookup keyed on a pet id the caller
    // never learned would be a timing difference between "erased" and "never
    // registered", which is the distinction art. 16 exists to erase.
    //
    // MUTATION APPLIED: replace `if (!petRow) return null;` with
    // `if (!petRow) { /* fall through */ }` and guard the return instead. Red:
    // two queries run.
    control.results = [[], []];
    const found = await AdoptionRepository.findPetForPublicDetail(TOKEN);
    expect(found).toBeNull();
    expect(control.queries).toHaveLength(1);
  });
});

describe("findPetForPublicDetail — the custody lookup", () => {
  it("asks only for an OPEN shelter custody of this pet", async () => {
    // MUTATIONS APPLIED, both red:
    //   · drop `isNull(ownerships.endedAt)` — the ficha would credit a shelter
    //     that handed the animal on, which is the 2026-08-18 field bug this
    //     method's docblock is a scar from.
    //   · `eq(ownerships.role, "owner")` — a citizen owner's row would be read
    //     as a shelter's, and the LEFT JOIN to `organizations` would drop it
    //     silently, so the ficha would lose its org with no error anywhere.
    control.results = [[{ id: "pet-1" }], []];
    await AdoptionRepository.findPetForPublicDetail(TOKEN);
    const { sql: text, params } = compile(control.queries[1]?.where);
    expect(text).toBe(
      '("ownerships"."pet_id" = $1 and "ownerships"."role" = $2 and "ownerships"."ended_at" is null)',
    );
    expect(params).toEqual(["pet-1", "shelter_custody"]);
  });

  it("breaks a tie by the MOST RECENT custody, never arbitrarily", async () => {
    // NOT DECORATION. Before this ORDER BY existed the public page picked an
    // arbitrary ownership row for a pet transferred between orgs and, in the
    // wild, picked the ORIGINAL shelter's ENDED row — the ficha credited a
    // refuge that no longer answered for the animal (9-role external run,
    // 2026-08-18).
    //
    // MUTATION APPLIED: `asc(ownerships.startedAt)`. Red — and the difference
    // between the two is invisible to any test that only checks the row count.
    control.results = [[{ id: "pet-1" }], []];
    await AdoptionRepository.findPetForPublicDetail(TOKEN);
    expect(compile(control.queries[1]?.orderBy[0]).sql).toBe('"ownerships"."started_at" desc');
  });
});

describe("findPetForApplication — the submit-flow lookup", () => {
  it("carries the art. 16 guard too, and requires a LIVE shelter custody", async () => {
    // A DIFFERENT DOOR WITH THE SAME GUARD, and it needs its own line because
    // its shape differs: this one INNER JOINs the custody (you cannot apply to
    // an animal no shelter holds) while the ficha above resolves it separately.
    // A guard proven on one is not proven on the other.
    //
    // MUTATIONS APPLIED, both red:
    //   · `eq(pets.publicToken, petPublicToken)` in place of the guarded
    //     predicate — an erased animal would accept applications.
    //   · drop `isNull(ownerships.endedAt)`.
    control.results = [[]];
    await AdoptionRepository.findPetForApplication(TOKEN);
    const { sql: text, params } = compile(control.queries[0]?.where);
    expect(text).toBe(
      '(("pets"."public_token" = $1 and "pets"."deleted_at" is null) and ' +
        '"ownerships"."role" = $2 and "ownerships"."ended_at" is null)',
    );
    expect(params).toEqual([TOKEN, "shelter_custody"]);
  });
});

describe("the split that put these reads in their own module", () => {
  it("exposes the SAME functions through AdoptionRepository, not copies of them", () => {
    // THE SHADOWING GUARD. `AdoptionRepository` spreads `AdoptionPublicReads`
    // first and then declares thirty more keys; a later key with one of these
    // names would silently WIN, and every assertion above would keep passing
    // against a module nothing calls any more.
    //
    // MUTATION APPLIED: re-declare `findPetForPublicDetail` at the bottom of
    // `adoption-repository.ts` returning null. Red here; green in every other
    // test in this file, because they all reach the object through the spread.
    for (const name of Object.keys(AdoptionPublicReads)) {
      expect(
        (AdoptionRepository as unknown as Record<string, unknown>)[name],
        `${name} is not the one from adoption-public-reads.ts — something below the spread shadows it`,
      ).toBe((AdoptionPublicReads as unknown as Record<string, unknown>)[name]);
    }
  });

  it("moved five methods and no more, so the boundary is a decision and not a drift", () => {
    // NON-VACUITY: an empty `AdoptionPublicReads` would satisfy the loop above
    // at zero iterations, which reads exactly like a clean run.
    expect(Object.keys(AdoptionPublicReads).sort()).toEqual([
      "findApplicantProfile",
      "findExistingApplication",
      "findLatestAdoptionFinalizedAt",
      "findPetForApplication",
      "findPetForPublicDetail",
    ]);
  });
});

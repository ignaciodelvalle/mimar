// `resolveReturnTargetOrg` — WHICH organisation a return is addressed to.
//
// WHY THIS FILE ANCHORS ON COMPILED SQL AND NOT ON ROWS
// ---------------------------------------------------------------------------
// The subject here is a PREDICATE and an ORDERING, and both are invisible to a
// stub that answers with rows. `__tests__/api-v1-rate-limit-families.test.ts`'s
// sibling lesson, recorded in `dim-interno:docs/agents/open-work.md`, is the reason: a
// drizzle stub whose `.where()` discards its argument "does not merely fail to
// test it: it makes every assertion in the file assert that the argument does
// not matter", and a reviewer mutated an authorization `WHERE` into a tautology
// with 21/21 still green.
//
// So the fragments this function hands drizzle are CAPTURED and compiled with
// `PgDialect().sqlToQuery()`, and the SQL text is asserted EXACTLY — never with
// `toContain`, which passes for `or(<predicate>, sql\`true\`)`.
//
// WHAT THE ORDERING IS, and why it is the whole reason this file exists:
// `orderBy(desc(ownerships.startedAt))` on the open `shelter_custody` lookup.
// Both inline copies this function replaced had `.limit(1)` and no ordering —
// the 2026-08-18 scar `adoption-public-reads.ts` carries a paragraph about,
// where "the public detail credited a refuge that no longer answered for the
// animal". A test that only checks WHICH ROW COMES BACK cannot see it, because
// a stub returns whatever it was handed in whatever order.

import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const PET_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "99999999-9999-4999-8999-999999999999";
const ORG_ID = "33333333-3333-4333-8333-333333333333";

type Query = { where: unknown; orderBy: unknown[] };

const control = vi.hoisted(() => ({
  /** Rows each successive `.select()` chain resolves to, in order. */
  results: [] as unknown[][],
  /** Every query the function built, with the fragments it handed drizzle. */
  queries: [] as Array<{ where: unknown; orderBy: unknown[] }>,
}));

/**
 * A drizzle stub that RECORDS its arguments instead of discarding them.
 *
 * The `.where()` and `.orderBy()` fragments are kept so the assertions below can
 * compile them. That is the whole difference from the stub the turnos rejection
 * was written about.
 */
function makeDb() {
  const chain = () => {
    const q: Query = { where: undefined, orderBy: [] };
    const self: Record<string, unknown> = {};
    self.from = () => self;
    self.innerJoin = () => self;
    self.where = (w: unknown) => {
      q.where = w;
      return self;
    };
    self.orderBy = (...o: unknown[]) => {
      q.orderBy = o;
      return self;
    };
    self.limit = async () => {
      control.queries.push(q);
      return control.results.shift() ?? [];
    };
    return self;
  };
  return { select: () => chain() } as never;
}

vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  return { ...actual, db: makeDb() };
});

import { resolveReturnTargetOrg } from "@/src/modules/return-to-owner/application/resolve-return-target-org";

const dialect = new PgDialect();
function compile(fragment: unknown) {
  return dialect.sqlToQuery(fragment as never);
}

function run(over: Partial<Parameters<typeof resolveReturnTargetOrg>[0]> = {}) {
  return resolveReturnTargetOrg({
    petId: PET_ID,
    userId: USER_ID,
    callerRole: "foster",
    exec: makeDb(),
    ...over,
  });
}

beforeEach(() => {
  control.results = [];
  control.queries = [];
});

describe("resolveReturnTargetOrg — the custody lookup is DETERMINISTIC", () => {
  it("orders the open shelter_custody rows most-recent-first", async () => {
    // THE 2026-08-18 SCAR. Before the `ORDER BY` existed, a pet transferred
    // between organisations resolved to an ARBITRARY custody row, and in the
    // wild that was the ORIGINAL shelter's — so the animal's own record named a
    // refuge that no longer answered for it. Two open rows should not exist; if
    // the invariant breaks, the MOST RECENT wins, consistently.
    //
    // MUTATION APPLIED: `asc(ownerships.startedAt)`. Red.
    // MUTATION APPLIED: delete the `.orderBy(...)` entirely. Red — and this is
    // the one that matters, because it is the state both inline copies were in.
    // Neither mutation is visible to any assertion about which row comes back:
    // a stub hands over whatever it was given.
    control.results = [
      [{ ownerOrganizationId: ORG_ID }],
      [{ displayName: "Refugio Sur", publicToken: "ORG-1" }],
    ];
    await run();
    const custodyQuery = control.queries[0];
    expect(custodyQuery.orderBy).toHaveLength(1);
    expect(compile(custodyQuery.orderBy[0]).sql).toBe('"ownerships"."started_at" desc');
  });

  it("filters the custody row to this pet, the shelter_custody role, and OPEN", async () => {
    // COMPILED AND ASSERTED BY EQUALITY, never `toContain`. The three terms are
    // one predicate and a tautology added beside any of them keeps the substring
    // while stopping the filter — the exact hole the adoption lane's
    // `or(unerasedPetByToken(t), sql\`true\`)` mutation demonstrated.
    //
    // MUTATION APPLIED: drop `isNull(ownerships.endedAt)`. Red — and an ENDED
    // custody row would then be a valid destination, which is the scar's own
    // failure ("picked the ORIGINAL shelter's ENDED row").
    control.results = [
      [{ ownerOrganizationId: ORG_ID }],
      [{ displayName: "Refugio Sur", publicToken: "ORG-1" }],
    ];
    await run();
    const compiled = compile(control.queries[0].where);
    expect(compiled.sql).toBe(
      '("ownerships"."pet_id" = $1 and "ownerships"."role" = $2 and "ownerships"."ended_at" is null)',
    );
    expect(compiled.params).toEqual([PET_ID, "shelter_custody"]);
  });

  it("answers no_source_org when nothing holds an open custody", async () => {
    control.results = [[]];
    expect(await run()).toEqual({ ok: false, code: "no_source_org" });
  });
});

describe("resolveReturnTargetOrg — the OWNER path reads the adoption first", () => {
  it("takes the placing shelter off the latest adoption_finalized", async () => {
    control.results = [
      [{ payload: { adopter_user_id: USER_ID, previous_owner_organization_id: ORG_ID } }],
      [{ displayName: "Refugio Sur", publicToken: "ORG-1" }],
    ];
    const result = await run({ callerRole: "owner" });
    expect(result).toEqual({
      ok: true,
      target: { orgId: ORG_ID, displayName: "Refugio Sur", publicToken: "ORG-1" },
    });
    // The adoption lookup orders by `occurred_at desc` — LATEST adoption, not
    // the first. An animal can be adopted, returned and adopted again.
    // MUTATION APPLIED: `asc(petEvents.occurredAt)`. Red.
    expect(compile(control.queries[0].orderBy[0]).sql).toBe('"pet_events"."occurred_at" desc');
  });

  it("REFUSES outright when the adoption names somebody else, with no fallback", async () => {
    // THE HARD REFUSAL, and the "no fallback" half is the load-bearing one:
    // somebody who is not the registered adopter must not be able to hand the
    // animal back to the shelter that placed it with a different person, even if
    // an open custody row would otherwise name one.
    //
    // MUTATION APPLIED: fall through to the custody fallback instead of
    // returning. Red — the assertion below sees a second query run.
    control.results = [
      [{ payload: { adopter_user_id: OTHER_USER, previous_owner_organization_id: ORG_ID } }],
    ];
    expect(await run({ callerRole: "owner" })).toEqual({ ok: false, code: "not_the_adopter" });
    expect(control.queries).toHaveLength(1);
  });

  it("falls back to the open custody when there is NO adoption on record", async () => {
    // The WRITER's rule, not the web page's. That page renders the form only
    // when an adoption event names the caller, so the browser hides a control
    // its own writer would accept; a read that modelled the page would tell a
    // phone it cannot do something the server would allow.
    // MUTATION APPLIED: `if (!toOrgId && callerRole === "foster")` on the
    // fallback. Red.
    control.results = [
      [],
      [{ ownerOrganizationId: ORG_ID }],
      [{ displayName: "Refugio Sur", publicToken: null }],
    ];
    const result = await run({ callerRole: "owner" });
    expect(result).toMatchObject({ ok: true, target: { orgId: ORG_ID } });
  });

  it("never reads an adoption for a FOSTER", async () => {
    // A foster's destination is the shelter whose animal they are fostering, and
    // an adoption on the same animal names a different relationship entirely.
    // MUTATION APPLIED: drop the `callerRole === "owner"` guard around the
    // adoption block. Red — the first query becomes the adoption lookup.
    control.results = [
      [{ ownerOrganizationId: ORG_ID }],
      [{ displayName: "Refugio Sur", publicToken: null }],
    ];
    await run({ callerRole: "foster" });
    expect(compile(control.queries[0].where).sql).toContain('"ownerships"');
    expect(control.queries).toHaveLength(2);
  });

  it("hands back a NULL display name for a dangling organisation id", async () => {
    // `previous_owner_organization_id` lives in an event payload and carries no
    // foreign key, so the id can outlive the row. `null` rather than a
    // placeholder: the writer folds it to "el refugio" for a notification body
    // and a screen has to say something else, and deciding that here would put
    // copy in a rule.
    control.results = [[{ ownerOrganizationId: ORG_ID }], []];
    expect(await run()).toEqual({
      ok: true,
      target: { orgId: ORG_ID, displayName: null, publicToken: null },
    });
  });
});

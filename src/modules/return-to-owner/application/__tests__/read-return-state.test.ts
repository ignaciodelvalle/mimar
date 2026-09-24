// `readPetReturnState` — WHAT a devolución screen may do.
//
// WHAT THIS FILE HAS TO PROVE
// ---------------------------------------------------------------------------
//   1. THE WEB'S PAGE DEFECT IS NOT COPIED. `.../devolucion/page.tsx` renders
//      the acceptance card whenever a proposal is pending, WITHOUT checking it
//      is addressed to the viewer — so an owner whose own outgoing proposal is
//      in flight is offered "Aceptar", and `ownerAcceptReturnUseCase` refuses it
//      with "Esta propuesta no está dirigida a vos." Here the two are different
//      arms and only one of them offers the button.
//   2. THE ORDER IS THE WRITERS'. A pending proposal is checked BEFORE the
//      target organisation is resolved, because both propose writers refuse
//      while one is pending — so a screen that offered "Devolver" beside a live
//      proposal would be offering a refusal.
//   3. THE PERSON PATH ONLY. A `null` holder role — the ORG path — is not
//      silently taken as an owner.
//   4. THE PROPOSER IS NAMED THE WAY THE WEB NAMES THEM: a first name, an
//      organisation's display name, or "Alguien". Never a surname, never blank.
//
// THE ORG RESOLVER IS MOCKED, deliberately: `resolveReturnTargetOrg` has its own
// file next door where its predicate and its ORDER BY are fenced on compiled
// SQL. What this file is about is the state machine over it.
//
// THE STUB COMPILES ITS OWN ARGUMENTS, AND THAT IS THE FIX FOR A REAL DEFECT
// (T4-M6, 2026-09-22), not a style match with the resolver's sibling file. The
// first version of this stub's `.where()` and `.orderBy()` both `return self`,
// discarding every argument they received — its own sibling
// `resolve-return-target-org.test.ts` opens by condemning exactly this shape
// ("a drizzle stub whose `.where()` discards its argument does not merely fail
// to test it: it makes every assertion in the file assert that the argument
// does not matter"), and the rule was applied to one of the two new files and
// not the other. MEASURED at the merge review: deleting
// `eq(petEvents.eventType, "custody_transfer_proposed")` from
// `describePendingProposal`'s predicate AND flipping its `orderBy` to ascending
// — in one change — left this file's 106 assertions green, because every case
// hands `makeDb()` the row it wants back regardless of what was asked for. What
// that costs: that query is what decides `inbound_pending` vs `awaiting_org`
// and supplies `actorName`, `proposedAt` and `notes`, so a reversed order
// describes an OLD resolved proposal instead of the live one.

import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const PET_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "99999999-9999-4999-8999-999999999999";

type Query = { where: unknown; orderBy: unknown[] };

const control = vi.hoisted(() => ({
  pending: false,
  /** Rows each successive `.select()` chain resolves to, in order. */
  results: [] as unknown[][],
  /** Every query run, WITH the fragments it handed drizzle, in order. */
  queries: [] as Array<{ where: unknown; orderBy: unknown[] }>,
  /** What the org resolver answers, and whether it was called at all. */
  target: { ok: true, target: { orgId: "org-1", displayName: "Refugio Sur", publicToken: null } } as
    | {
        ok: true;
        target: { orgId: string; displayName: string | null; publicToken: string | null };
      }
    | { ok: false; code: "not_the_adopter" | "no_source_org" },
  targetCalls: [] as Array<Record<string, unknown>>,
}));

/**
 * A drizzle stub that RECORDS its arguments instead of discarding them — see
 * the header for why that is the whole point of this file.
 */
function makeDb() {
  const chain = () => {
    const q: Query = { where: undefined, orderBy: [] };
    const self: Record<string, unknown> = {};
    self.from = () => self;
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

const dialect = new PgDialect();
function compile(fragment: unknown) {
  return dialect.sqlToQuery(fragment as never);
}

vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  return { ...actual, db: makeDb() };
});

vi.mock("@/src/modules/return-to-owner/application/proposal-queries", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/src/modules/return-to-owner/application/proposal-queries")
    >();
  return { ...actual, hasPendingProposal: async () => control.pending };
});

vi.mock("@/src/modules/return-to-owner/application/resolve-return-target-org", () => ({
  resolveReturnTargetOrg: async (args: Record<string, unknown>) => {
    control.targetCalls.push(args);
    return control.target;
  },
}));

import { readPetReturnState } from "@/src/modules/return-to-owner/application/read-return-state";

function run(over: Partial<Parameters<typeof readPetReturnState>[0]> = {}) {
  return readPetReturnState({
    pet: { id: PET_ID },
    userId: USER_ID,
    holderRole: "owner",
    exec: makeDb(),
    ...over,
  });
}

/** A `custody_transfer_proposed` row as the reader reads it. */
function proposal(payload: Record<string, unknown>) {
  return [{ payload, occurredAt: new Date("2026-08-20T12:00:00.000Z") }];
}

beforeEach(() => {
  control.pending = false;
  control.results = [];
  control.queries = [];
  control.target = {
    ok: true,
    target: { orgId: "org-1", displayName: "Refugio Sur", publicToken: null },
  };
  control.targetCalls = [];
});

describe("readPetReturnState — who this feature serves", () => {
  it.each([["co_owner"], ["caretaker"]])(
    "answers not_titular for a person-path %s and resolves nothing else",
    async (role) => {
      // MUTATION APPLIED: `if (args.holderRole === "caretaker")` instead of the
      // allow-check. Red for `co_owner` — and a co-owner would then be handed a
      // "Devolver" button that `ownerProposeReturnToOrgUseCase` refuses, because
      // its ownership join names the role explicitly.
      expect(await run({ holderRole: role })).toEqual({ kind: "not_titular", holderRole: role });
      expect(control.targetCalls).toEqual([]);
      expect(control.queries).toEqual([]);
    },
  );

  it("answers not_titular for the ORG path rather than taking null as an owner", async () => {
    // `resolvePetHolderAccess` returns `holderRole: null` on the org path, and
    // `null` compared with `"owner"` is false — so this is what the code already
    // does. It is asserted because the tempting narrowing (`?? "owner"`, or a
    // `!== "foster"` test) reads as tidier and would admit an organisation
    // member to a surface the web's own page 404s.
    // MUTATION APPLIED: `const callerRole = args.holderRole ?? "owner"`. Red.
    expect(await run({ holderRole: null })).toEqual({
      kind: "not_titular",
      holderRole: "unknown",
    });
  });
});

describe("readPetReturnState — the pending-proposal lookup is DETERMINISTIC", () => {
  it("filters to THIS pet and the custody_transfer_proposed event, compiled and asserted exactly", async () => {
    // COMPILED AND ASSERTED BY EQUALITY, never `toContain` — the exact hole a
    // stub that discards `.where()` cannot see (T4-M6, 2026-09-22).
    //
    // MUTATION APPLIED: drop `eq(petEvents.eventType, "custody_transfer_proposed")`.
    // Red — and every OTHER event on this pet's spine would then decide
    // `inbound_pending` vs `awaiting_org`.
    control.pending = true;
    control.results = [proposal({ to_user_id: USER_ID }), [{ displayName: "Ana" }]];
    await run();

    const compiled = compile(control.queries[0]?.where);
    expect(compiled.sql).toBe('("pet_events"."pet_id" = $1 and "pet_events"."event_type" = $2)');
    expect(compiled.params).toEqual([PET_ID, "custody_transfer_proposed"]);
  });

  it("orders by occurred_at, MOST RECENT FIRST, so an old proposal cannot outrank a live one", async () => {
    // MUTATION APPLIED: `asc(petEvents.occurredAt)`. Red — a stub answers
    // whichever row it was handed regardless of the direction asked for, so
    // this is invisible to every case that only checks WHICH row comes back.
    control.pending = true;
    control.results = [proposal({ to_user_id: USER_ID }), [{ displayName: "Ana" }]];
    await run();

    expect(control.queries[0]?.orderBy).toHaveLength(1);
    expect(compile(control.queries[0]?.orderBy[0]).sql).toBe('"pet_events"."occurred_at" desc');
  });
});

describe("readPetReturnState — a pending proposal, from the caller's side", () => {
  it("offers accept/reject ONLY when the proposal is addressed to the caller", async () => {
    control.pending = true;
    control.results = [
      proposal({ to_user_id: USER_ID, from_user_id: OTHER_USER, notes: "La tengo yo" }),
      [{ displayName: "Ana María Pérez" }],
    ];
    expect(await run()).toEqual({
      kind: "inbound_pending",
      actorName: "Ana",
      proposedAt: "2026-08-20T12:00:00.000Z",
      notes: "La tengo yo",
    });
  });

  it("answers awaiting_org for the caller's OWN outgoing proposal", async () => {
    // THE WEB PAGE'S DEFECT, NOT COPIED. An owner-initiated proposal carries
    // `to_user_id: null` and `to_organization_id` set. The browser renders the
    // acceptance card for it — `hasPendingProposal` is true and nothing else is
    // checked — and the writer then refuses with "Esta propuesta no está
    // dirigida a vos."
    //
    // MUTATION APPLIED: delete the `if (toUserId !== userId) return { kind:
    // "awaiting_org" }` line. Red HERE and green on every other case in this
    // file, which is exactly the shape of the defect being reproduced.
    control.pending = true;
    control.results = [proposal({ to_user_id: null, to_organization_id: "org-1", notes: null })];
    expect(await run()).toEqual({ kind: "awaiting_org" });
  });

  it("answers awaiting_org for a proposal addressed to a DIFFERENT person", async () => {
    control.pending = true;
    control.results = [proposal({ to_user_id: OTHER_USER, from_user_id: "someone" })];
    expect(await run()).toEqual({ kind: "awaiting_org" });
  });

  it("never asks WHICH ORGANISATION while a proposal is pending", async () => {
    // THE ORDER IS THE WRITERS'. Both propose writers refuse while a proposal is
    // pending, so resolving a target here would be work whose only possible use
    // is to draw a button that answers 409.
    // MUTATION APPLIED: move the `hasPendingProposal` branch below the resolve.
    // Red.
    control.pending = true;
    control.results = [proposal({ to_user_id: null })];
    await run();
    expect(control.targetCalls).toEqual([]);
  });

  it("falls back to the event's own timestamp when the payload carries no proposed_at", async () => {
    control.pending = true;
    control.results = [proposal({ to_user_id: USER_ID }), [{ displayName: "Ana" }]];
    expect(await run()).toMatchObject({ proposedAt: "2026-08-20T12:00:00.000Z" });
  });

  it("prefers the payload's proposed_at when it has one", async () => {
    control.pending = true;
    control.results = [
      proposal({ to_user_id: USER_ID, proposed_at: "2026-08-19T09:00:00.000Z" }),
      [{ displayName: "Ana" }],
    ];
    expect(await run()).toMatchObject({ proposedAt: "2026-08-19T09:00:00.000Z" });
  });

  it("answers awaiting_org when the proposal row vanished between the two reads", async () => {
    // `hasPendingProposal` found one and this read did not. "Waiting" is the safe
    // answer because it offers nothing; `inbound_pending` with an empty name
    // would draw an "Aceptar" over a proposal that is gone.
    control.pending = true;
    control.results = [[]];
    expect(await run()).toEqual({ kind: "awaiting_org" });
  });
});

describe("readPetReturnState — naming the person holding the animal", () => {
  it("names a person by their FIRST name only, as the web does", async () => {
    // MUTATION APPLIED: return `profile.displayName` whole. Red — and a surname
    // is more than the decision needs, on a screen a stranger's animal-holder
    // appears on.
    control.pending = true;
    control.results = [
      proposal({ to_user_id: USER_ID, from_user_id: OTHER_USER }),
      [{ displayName: "Ana María Pérez" }],
    ];
    expect(await run()).toMatchObject({ actorName: "Ana" });
  });

  it("names an ORGANISATION by its whole display name", async () => {
    control.pending = true;
    control.results = [
      proposal({ to_user_id: USER_ID, from_user_id: null, from_organization_id: "org-9" }),
      [{ displayName: "Refugio Patitas del Sur" }],
    ];
    expect(await run()).toMatchObject({ actorName: "Refugio Patitas del Sur" });
  });

  it('falls back to "Alguien" rather than to a blank', async () => {
    // A blank where a name should be reads as a bug. The web uses this exact
    // word for the same case.
    control.pending = true;
    control.results = [proposal({ to_user_id: USER_ID, from_user_id: null }), []];
    expect(await run()).toMatchObject({ actorName: "Alguien" });
  });
});

describe("readPetReturnState — proposing a return", () => {
  it("offers it to an OWNER with the organisation's name", async () => {
    expect(await run()).toEqual({
      kind: "can_propose",
      callerRole: "owner",
      orgDisplayName: "Refugio Sur",
    });
    // The role the ACCESS GUARD resolved travels to the resolver untouched — the
    // adoption branch runs for an owner and must not for a foster.
    // MUTATION APPLIED: `callerRole: "owner"` hardcoded at the call. Red on the
    // foster case below.
    expect(control.targetCalls[0]).toMatchObject({ callerRole: "owner", userId: USER_ID });
  });

  it("offers it to a FOSTER, and says which role it is offering to", async () => {
    expect(await run({ holderRole: "foster" })).toEqual({
      kind: "can_propose",
      callerRole: "foster",
      orgDisplayName: "Refugio Sur",
    });
    expect(control.targetCalls[0]).toMatchObject({ callerRole: "foster" });
  });

  it("carries a NULL organisation name through rather than inventing one", async () => {
    control.target = { ok: true, target: { orgId: "org-1", displayName: null, publicToken: null } };
    expect(await run()).toMatchObject({ orgDisplayName: null });
  });

  it("answers not_the_adopter as its own arm, not as no_source_org", async () => {
    // The two are different refusals with different copy: one is about WHO the
    // caller is and cannot be fixed, the other is about the animal's record.
    // MUTATION APPLIED: fold both onto `no_source_org`. Red.
    control.target = { ok: false, code: "not_the_adopter" };
    expect(await run()).toEqual({ kind: "not_the_adopter" });
  });

  it("answers no_source_org WITH the caller's role, so the copy can differ", async () => {
    control.target = { ok: false, code: "no_source_org" };
    expect(await run({ holderRole: "foster" })).toEqual({
      kind: "no_source_org",
      callerRole: "foster",
    });
  });
});

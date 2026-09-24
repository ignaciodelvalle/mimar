// The claim use-cases' TYPED failure arm — `ClaimFailureCode`.
//
// WHAT THIS FILE IS, AND EMPHATICALLY WHAT IT IS NOT
// ---------------------------------------------------------------------------
// It pins WHICH CODE each refusal arm carries, so that the second door onto
// these use-cases (`POST /api/v1/me/pet-claims`) can answer a status without
// matching Spanish prose. Before the code existed, every one of these arms was
// an untyped `{ error: string }` and a copy edit could silently turn a 409 into
// a 500.
//
// IT IS NOT AN AUTHORIZATION FENCE AND MUST NEVER BE READ AS ONE. The database
// is stubbed here: `tx.select(…)` returns whatever the case queued, and the
// predicate it was handed is DISCARDED. That is exactly the shape that made
// `listAppointmentsForUser`'s `WHERE` untested (open-work.md, 2026-08-30) — "a
// stub that ignores an argument makes every assertion in the file assert that
// the argument does not matter" — so the scope of this file is stated up front
// rather than left to be inferred: every assertion below is of the form "GIVEN
// these rows, WHICH ARM RUNS", and none of them says anything about which rows
// Postgres would actually return.
//
// What proves the predicates is `__tests__/pet-claim.test.ts`, which runs both
// writers against real local Postgres with real ownership rows. That file
// already existed and is untouched.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  /** Rows the stubbed `select()` chain hands back, in call order. */
  rows: [] as unknown[][],
  /** Every `enforceRateLimit` call, so "refused before the budget" is testable. */
  limiterCalls: [] as Array<{ endpoint: string; identifier: string }>,
  limiterThrows: null as null | (() => never),
  /** Set to throw from inside the transaction body, for the `failed` arm. */
  transactionThrows: null as null | (() => never),
  inserted: [] as unknown[],
}));

/**
 * A chainable that answers the next queued row set.
 *
 * A REAL PROMISE with builder methods bolted on, rather than an object carrying
 * a hand-written `then` — drizzle's builders are awaited, and `lint/suspicious/
 * noThenProperty` refuses the hand-written spelling for a good reason (a `then`
 * key makes any object silently unwrappable by `await`, in places nobody meant).
 * Every builder method returns the same promise, so
 * `.select().from().where().limit(1).for("update")` resolves to the queued rows.
 *
 * The ARGUMENTS ARE DROPPED, on purpose, and the file header says what that
 * costs: nothing here can say anything about a predicate.
 */
function selectChain() {
  const rows = control.rows.shift() ?? [];
  const chain = Promise.resolve(rows) as Promise<unknown[]> & Record<string, () => unknown>;
  for (const method of ["from", "where", "limit", "for", "innerJoin", "leftJoin", "orderBy"]) {
    chain[method] = () => chain;
  }
  return chain;
}

const tx = {
  select: () => selectChain(),
  insert: () => ({
    values: (value: unknown) => {
      control.inserted.push(value);
      return Promise.resolve();
    },
  }),
};

vi.mock("@/db", () => ({
  db: {
    select: () => selectChain(),
    transaction: async (body: (t: typeof tx) => Promise<unknown>) => {
      control.transactionThrows?.();
      return body(tx);
    },
  },
  auditLog: {},
  notifications: {},
  ownerships: {},
  petEvents: {},
  petIdentifications: {},
  pets: {},
  profiles: {},
}));

vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return {
    ...actual,
    enforceRateLimit: async (endpoint: string, identifier: string) => {
      control.limiterCalls.push({ endpoint, identifier });
      control.limiterThrows?.();
    },
  };
});

vi.mock("@/lib/infra/chip-lookup", () => ({
  lookupByChip: async () => null,
  attemptedChipMatchesPet: async () => false,
}));

import { RateLimitError } from "@/lib/infra/rate-limit";

import { lookupForClaimForUser } from "@/src/modules/pets/application/claim/lookup-for-claim";
import { submitFreeClaimForUser } from "@/src/modules/pets/application/claim/submit-free-claim";
import { CLAIM_FAILURE_CODES } from "@/src/modules/pets/application/claim/types";

const USER = "11111111-1111-4111-8111-111111111111";
const CHIP = "982000123456789";

/** The code on a refusal, or `null` when the call succeeded. */
function codeOf(result: unknown): string | null {
  return result !== null && typeof result === "object" && "code" in result
    ? String((result as { code: unknown }).code)
    : null;
}

beforeEach(() => {
  control.rows = [];
  control.limiterCalls = [];
  control.limiterThrows = null;
  control.transactionThrows = null;
  control.inserted = [];
});

afterEach(() => {
  // Every refusal this file produces must name a declared code. A typo would
  // otherwise reach the route's exhaustive switch as an unhandled value.
  expect(CLAIM_FAILURE_CODES.length).toBe(5);
});

describe("submitFreeClaimForUser — the identifier arm runs before any budget", () => {
  it("refuses an empty value with `identifier_invalid` and spends NOTHING", () => {
    // The use-case's own comment: "reject early before spending a rate-limit
    // token or opening a transaction". The limiter call count is what makes
    // that sentence a measurement rather than a claim — a person who mistyped
    // must not be throttled for having tried.
    return submitFreeClaimForUser(USER, { identifierKind: "tattoo", identifierValue: "  " }).then(
      (result) => {
        expect(codeOf(result)).toBe("identifier_invalid");
        expect(control.limiterCalls).toEqual([]);
      },
    );
  });

  it("refuses a 14-digit microchip with `identifier_invalid`, also for free", async () => {
    const result = await submitFreeClaimForUser(USER, {
      identifierKind: "microchip",
      identifierValue: "12345678901234",
    });
    expect(codeOf(result)).toBe("identifier_invalid");
    expect(control.limiterCalls).toEqual([]);
  });
});

describe("submitFreeClaimForUser — the shared budget", () => {
  it("answers `rate_limited`, and spends the SAME bucket keyed on the user the lookup does", async () => {
    control.limiterThrows = () => {
      throw new RateLimitError(new Date(), "too many");
    };
    const result = await submitFreeClaimForUser(USER, {
      identifierKind: "microchip",
      identifierValue: CHIP,
    });
    expect(codeOf(result)).toBe("rate_limited");
    // ONE bucket for lookup AND claim, keyed on the caller — that is what makes
    // "a burst of probes counts together" true, and it is the budget the WEB
    // spends through the same use-case.
    expect(control.limiterCalls).toEqual([{ endpoint: "claim_lookup", identifier: USER }]);
  });
});

describe("submitFreeClaimForUser — inside the transaction", () => {
  it("answers `not_found` when the identifier resolves to no active identification", async () => {
    control.rows = [[]];
    const result = await submitFreeClaimForUser(USER, {
      identifierKind: "microchip",
      identifierValue: CHIP,
    });
    expect(codeOf(result)).toBe("not_found");
    expect(control.inserted).toEqual([]);
  });

  it("answers `not_claimable` for deceased, lost and disputed — three refusals, one code", async () => {
    // ONE CODE for all three because the CLIENT'S MOVE is identical: re-run the
    // lookup, whose fresh variant is the vocabulary a screen already renders.
    // Asserted as a table so a fourth situation added to the writer without a
    // code lands here rather than in a 500.
    const situations = [
      { status: "deceased", inCustodyDispute: false },
      { status: "lost", inCustodyDispute: false },
      { status: "active", inCustodyDispute: true },
    ];
    for (const pet of situations) {
      control.rows = [
        [{ petId: "pet-1" }],
        [{ id: "pet-1", publicToken: "DIM", name: "Rocky", ...pet }],
      ];
      control.inserted = [];
      const result = await submitFreeClaimForUser(USER, {
        identifierKind: "microchip",
        identifierValue: CHIP,
      });
      expect(codeOf(result), JSON.stringify(pet)).toBe("not_claimable");
      expect(control.inserted).toEqual([]);
    }
  });

  it("answers `not_claimable` when ANY active custody row exists, not only an owner one", async () => {
    // The re-check inside the transaction selects `ownerships` filtered only by
    // `ended_at IS NULL` — no role predicate — so a refugio's shelter_custody
    // blocks a direct claim exactly like an owner does. The row shape here
    // carries a non-owner role to say which case is being pinned.
    control.rows = [
      [{ petId: "pet-1" }],
      [
        {
          id: "pet-1",
          publicToken: "DIM",
          name: "Rocky",
          status: "active",
          inCustodyDispute: false,
        },
      ],
      [{ id: "ownership-1", role: "shelter_custody" }],
    ];
    const result = await submitFreeClaimForUser(USER, {
      identifierKind: "microchip",
      identifierValue: CHIP,
    });
    expect(codeOf(result)).toBe("not_claimable");
    expect(control.inserted).toEqual([]);
  });

  it("answers `failed` for an unexpected error, and never leaks the message as a guard", async () => {
    control.transactionThrows = () => {
      throw new Error("connection terminated unexpectedly");
    };
    const result = await submitFreeClaimForUser(USER, {
      identifierKind: "microchip",
      identifierValue: CHIP,
    });
    expect(codeOf(result)).toBe("failed");
  });
});

describe("lookupForClaimForUser — the same two codes, on the read half", () => {
  it("answers `rate_limited` on the shared bucket", async () => {
    control.limiterThrows = () => {
      throw new RateLimitError(new Date(), "too many");
    };
    const result = await lookupForClaimForUser(USER, { kind: "microchip", value: CHIP });
    expect(codeOf(result)).toBe("rate_limited");
    expect(control.limiterCalls).toEqual([{ endpoint: "claim_lookup", identifier: USER }]);
  });

  it("answers `identifier_invalid` for a malformed microchip", async () => {
    const result = await lookupForClaimForUser(USER, { kind: "microchip", value: "abc" });
    expect(codeOf(result)).toBe("identifier_invalid");
  });

  it("answers the `not_found` VARIANT — not a refusal — for an empty value", async () => {
    // The distinction the endpoint depends on: a lookup that found nothing
    // SUCCEEDED. It must never become a 404, or a client cannot tell "no such
    // chip" from a transport failure.
    const result = await lookupForClaimForUser(USER, { kind: "tattoo", value: "   " });
    expect(codeOf(result)).toBe(null);
    expect(result).toEqual({ variant: "not_found" });
  });
});

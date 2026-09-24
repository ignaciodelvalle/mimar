// `/api/v1/me/pet-claims` — reclamar una mascota over a bearer token.
//
// THE ONE THING THIS FILE EXISTS TO STOP
// ---------------------------------------------------------------------------
// THE PHONE GRANTING WHAT THE BROWSER REFUSES. A claim is the most consequential
// act a citizen can ask for on this surface — it says an animal in the national
// registry is theirs — and there are exactly two ways this door could be looser
// than the web's:
//
//   1. by letting a caller name the ANIMAL instead of proving the identifier,
//      which is the bug `submit-claim-dispute.ts` calls "a national
//      denial-of-rescue button" and which is why the wire shape has no token;
//   2. by drawing `canClaim: true` on an animal somebody already holds.
//
// Both are asserted below, and (1) is asserted at the only place that cannot
// lie about it: what actually reaches the use-case.
//
// THE TWO INSTRUMENTS THIS FILE USES THAT ITS NEAREST SIBLING DID NOT
// ---------------------------------------------------------------------------
// `api-v1-me-appointments-route.test.ts` shipped with two holes that are written
// into the debts table (open-work.md, 2026-08-30), and both are closed here on
// purpose rather than by luck:
//
//   · ITS LIMITER STUB TOOK `(endpoint: string)` AND DROPPED THE IDENTIFIER, so
//     collapsing every bucket onto one shared key left the file green. This one
//     records the PAIR and asserts it, the way `api-v1-me-profile-route.test.ts`
//     does.
//   · ITS DOCUMENTED FAIL-OPEN HAD NO TEST, so flipping `return true` to
//     `return false` in `spendBudget` left the file green. There is a case for
//     it below, named the way the five sibling files name theirs.
//
// Mocked at the use-cases, not at the database: what is pinned is the handler's
// contract with them, and a live version would need a seeded animal with a chip
// on a shared Supabase. `__tests__/pet-claim.test.ts` already drives both
// writers against real Postgres.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  cookieDoorTouched: false,
  limiterThrows: null as null | (() => never),
  limits: [] as Array<{ endpoint: string; identifier: string }>,
  /** The CEILING each call spent, kept apart so `limits` stays comparable. */
  ceilings: [] as unknown[],
  live: null as unknown,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    control.cookieDoorTouched = true;
    throw new Error("/api/v1/me/pet-claims read the COOKIE client — bearer only");
  },
}));

vi.mock("next/headers", () => ({
  cookies: () => {
    control.cookieDoorTouched = true;
    throw new Error("/api/v1/me/pet-claims read cookies() — bearer only");
  },
  headers: () => {
    control.cookieDoorTouched = true;
    throw new Error("/api/v1/me/pet-claims read next/headers headers()");
  },
}));

vi.mock("@/lib/supabase/bearer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/bearer")>();
  return {
    ...actual,
    // THE ONE ROUTE-TEST OF FIFTEEN THAT BUILT A REAL supabase-js CLIENT
    // (open-work.md): unmocked, this module reads NEXT_PUBLIC_SUPABASE_ANON_KEY,
    // the one Supabase variable `__tests__/setup-env.ts` does not force — so in
    // a worktree with no `.env.local` this file reported 20 of 21 red with
    // `Error: supabaseKey is required.`, credential-shaped, on a file that has
    // nothing to do with RLS. Same stub as the fourteen siblings: the handler's
    // whole contract with the client is handing `supabase`/`token` to
    // `requireLiveUser`, itself stubbed below.
    createClientFromBearer: (header: string | null) =>
      header ? { ok: true, supabase: {}, token: "tok" } : { ok: false, reason: "MISSING" },
  };
});

vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return {
    ...actual,
    // BOTH ARGUMENTS. A stub that takes only the endpoint makes every assertion
    // in the file assert that the identifier does not matter — see the header.
    enforceRateLimit: async (endpoint: string, identifier: string, limit: unknown) => {
      control.limits.push({ endpoint, identifier });
      control.ceilings.push(limit);
      control.limiterThrows?.();
    },
  };
});

vi.mock("@/lib/infra/live-user", () => ({
  requireLiveUser: async () => control.live,
}));

const mockLookup = vi.fn();
vi.mock("@/src/modules/pets/application/claim/lookup-for-claim", () => ({
  lookupForClaimForUser: (...args: unknown[]) => mockLookup(...args),
}));

const mockClaim = vi.fn();
vi.mock("@/src/modules/pets/application/claim/submit-free-claim", () => ({
  submitFreeClaimForUser: (...args: unknown[]) => mockClaim(...args),
}));

import { API_V1_AUTHENTICATED_WRITE_IP_LIMIT } from "@/lib/infra/api-v1-limits";
import { RateLimitError } from "@/lib/infra/rate-limit";

import { POST } from "@/app/api/v1/me/pet-claims/route";

const SUBJECT = "0f3f2e4a-2222-4222-8222-abcdefabcdef";
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.fake.signature";
const CALLER_IP = "203.0.113.55";
const CHIP = "982000123456789";

const LOOKUP_BODY = { command: "lookup", identifierKind: "microchip", identifierValue: CHIP };
const CLAIM_BODY = { command: "claim_free", identifierKind: "microchip", identifierValue: CHIP };

function postRequest(body: unknown, authorization: string | null = `Bearer ${TOKEN}`) {
  return new Request("http://localhost:3000/api/v1/me/pet-claims", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-real-ip": CALLER_IP,
      ...(authorization ? { authorization } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
  control.limiterThrows = null;
  control.limits = [];
  control.ceilings = [];
  control.live = { ok: true, user: { id: SUBJECT }, profile: {} };
  mockLookup.mockReset();
  mockClaim.mockReset();
});

afterEach(() => {
  expect(control.cookieDoorTouched).toBe(false);
});

describe("the identifier is the authorization, and no token ever reaches a writer", () => {
  it("passes the caller's chip through and NOTHING a caller-supplied token could ride in on", async () => {
    // THE ASSERTION THIS FILE IS FOR. `submit-claim-dispute.ts` records what a
    // caller-supplied `petToken` in this position cost: `/perdidas` publishes the
    // token of every lost animal in the country with no login, so a
    // token-addressed claim is a claim anybody can aim at any animal. The wire
    // shape carries no token — this checks the DATA that reached the writer, not
    // merely that the schema tolerated the extra key.
    mockClaim.mockResolvedValue({ petToken: "DIM-REAL-TOKN", petName: "Rocky" });

    const response = await POST(postRequest({ ...CLAIM_BODY, petToken: "DIM-EVIL-TOKN" }));

    expect(response.status).toBe(200);
    expect(mockClaim).toHaveBeenCalledTimes(1);
    expect(mockClaim.mock.calls[0]).toEqual([
      SUBJECT,
      { identifierKind: "microchip", identifierValue: CHIP },
    ]);
  });

  it("takes the user id from the GUARD, never from the body", async () => {
    // `app/actions/pet-claim.ts` refuses to export the bare `ForUser` writers as
    // server actions for exactly this reason. This route is a second door onto
    // the same writers, so the same property has to hold.
    mockLookup.mockResolvedValue({ variant: "not_found" });

    await POST(postRequest({ ...LOOKUP_BODY, userId: "99999999-9999-4999-8999-999999999999" }));

    expect(mockLookup.mock.calls[0]?.[0]).toBe(SUBJECT);
  });

  it("answers the CLAIM with the token the WRITER resolved, not the one that was sent", async () => {
    mockClaim.mockResolvedValue({ petToken: "DIM-REAL-TOKN", petName: "Rocky" });

    const response = await POST(postRequest({ ...CLAIM_BODY, petToken: "DIM-EVIL-TOKN" }));

    expect(await bodyOf(response)).toEqual({
      command: "claim_free",
      changed: true,
      petToken: "DIM-REAL-TOKN",
      petName: "Rocky",
    });
  });
});

describe("the lookup ack — what a client may draw", () => {
  it("offers `canClaim` ONLY for a free animal", async () => {
    // The second way this door could be looser than the browser: drawing the
    // claim button over an animal somebody holds. Asserted across every variant
    // so a sixth one cannot default to permissive.
    const cases = [
      { variant: { variant: "free", petToken: "DIM-A", petName: "Rocky" }, canClaim: true },
      {
        variant: {
          variant: "active_owner",
          petToken: "DIM-B",
          petName: "Rocky",
          ownerInitials: "L.F.",
        },
        canClaim: false,
      },
      { variant: { variant: "lost", petToken: "DIM-C", petName: "Rocky" }, canClaim: false },
      { variant: { variant: "deceased", petName: "Rocky" }, canClaim: false },
      { variant: { variant: "not_found" }, canClaim: false },
    ];

    for (const { variant, canClaim } of cases) {
      mockLookup.mockResolvedValue(variant);
      const response = await POST(postRequest(LOOKUP_BODY));
      expect(response.status).toBe(200);
      expect((await bodyOf(response)).canClaim, variant.variant).toBe(canClaim);
    }
  });

  it("hands back a pet token ONLY for `lost`, and never for the animal somebody else holds", async () => {
    // One step tighter than the web's own action, which returns a token for
    // `free` and `active_owner` too. A token opens `/p/{token}`; it travels only
    // where this client has somewhere to go, and that is the avistaje form.
    mockLookup.mockResolvedValue({ variant: "lost", petToken: "DIM-C", petName: "Rocky" });
    expect((await bodyOf(await POST(postRequest(LOOKUP_BODY)))).petToken).toBe("DIM-C");

    mockLookup.mockResolvedValue({
      variant: "active_owner",
      petToken: "DIM-B",
      petName: "Rocky",
      ownerInitials: "L.F.",
    });
    expect((await bodyOf(await POST(postRequest(LOOKUP_BODY)))).petToken).toBe(null);

    mockLookup.mockResolvedValue({ variant: "free", petToken: "DIM-A", petName: "Rocky" });
    expect((await bodyOf(await POST(postRequest(LOOKUP_BODY)))).petToken).toBe(null);
  });

  it("never echoes the chip or the tattoo code back", async () => {
    // An endpoint that returns the canonical identifier is a chip oracle, and
    // this one answers to any account that signed itself up
    // (`confirm-chip-match-vecino.ts` records the same finding). The caller
    // supplied the value, so echoing it is free — which is exactly why it needs
    // an assertion rather than a habit.
    mockLookup.mockResolvedValue({
      variant: "active_owner",
      petToken: "DIM-B",
      petName: "Rocky",
      ownerInitials: "L.F.",
    });

    const raw = await (await POST(postRequest(LOOKUP_BODY))).text();

    expect(raw).not.toContain(CHIP);
  });

  it("answers `not_found` as a 200 VARIANT, never as a 404", async () => {
    // A question that was asked and answered is not a failure. A 404 would make
    // "no such chip" indistinguishable from a route that does not exist, and
    // would put the art. 16 promise in the status line.
    mockLookup.mockResolvedValue({ variant: "not_found" });

    const response = await POST(postRequest(LOOKUP_BODY));

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({
      command: "lookup",
      variant: "not_found",
      petName: null,
      petToken: null,
      ownerInitials: null,
      canClaim: false,
    });
  });
});

describe("the refusals — a typed code, never a matched sentence", () => {
  it("maps every `ClaimFailureCode` to its own status", async () => {
    // The whole reason `ClaimFailureCode` exists: `me/appointments/commands.ts`
    // matches es-AR SENTENCES and states its own failure mode ("a reworded
    // sentence falls through to a 500"). Here a copy edit in the use-case cannot
    // move a status, and this table is what says so.
    const cases = [
      { code: "rate_limited", status: 429, error: "rate_limited" },
      { code: "identifier_invalid", status: 400, error: "invalid_request" },
      { code: "not_found", status: 404, error: "not_found" },
      { code: "not_claimable", status: 409, error: "claim_not_claimable" },
      { code: "failed", status: 500, error: "claim_failed" },
    ];

    for (const { code, status, error } of cases) {
      mockClaim.mockResolvedValue({ error: "una frase en castellano", code });
      const response = await POST(postRequest(CLAIM_BODY));
      expect(response.status, code).toBe(status);
      expect(await bodyOf(response), code).toEqual({ error });
    }
  });

  it("never puts the use-case's es-AR prose on the wire", async () => {
    // §2: the envelope is one key. The prose is written for the web wizard's
    // error paragraph and can name internal state; the app owns its own copy.
    mockClaim.mockResolvedValue({
      error: "Esta mascota ya tiene una custodia activa. Podés iniciar una disputa.",
      code: "not_claimable",
    });

    const raw = await (await POST(postRequest(CLAIM_BODY))).text();

    expect(raw).not.toContain("custodia activa");
  });
});

describe("the envelope", () => {
  it("refuses a body the contract does not accept, without reaching a writer", async () => {
    const response = await POST(postRequest({ command: "dispute", reason: "x".repeat(40) }));

    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toEqual({ error: "invalid_request" });
    expect(mockLookup).not.toHaveBeenCalled();
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("refuses a 14-digit microchip before spending anything on it", async () => {
    const response = await POST(
      postRequest({ command: "claim_free", identifierKind: "microchip", identifierValue: "1234" }),
    );

    expect(response.status).toBe(400);
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("answers 401 with no Authorization header, and spends NO budget on it", async () => {
    // The header regex runs before the limiter on purpose: a client that got the
    // envelope wrong must cost the platform no counter write.
    const response = await POST(postRequest(LOOKUP_BODY, null));

    expect(response.status).toBe(401);
    expect(await bodyOf(response)).toEqual({ error: "auth_required" });
    expect(control.limits).toEqual([]);
  });

  it("sets cache-control: no-store on every answer", async () => {
    mockLookup.mockResolvedValue({ variant: "not_found" });
    const ok = await POST(postRequest(LOOKUP_BODY));
    expect(ok.headers.get("cache-control")).toBe("no-store");

    const refused = await POST(postRequest({ command: "nope" }));
    expect(refused.headers.get("cache-control")).toBe("no-store");
  });
});

describe("the liveness guard — stricter than the web page, on purpose", () => {
  it("refuses a DEACTIVATED account that `/mis-mascotas/reclamar` would serve", async () => {
    // `requireUserOrRedirect` PASSES a deactivated account (`auth-guards.ts`), so
    // the browser's wizard serves one. This door does not, and the direction is
    // the safe one: it grants nothing the browser grants and this refuses. Pinned
    // so the divergence is a decision somebody has to walk past, not a drift.
    control.live = { ok: false, reason: "DEACTIVATED" };

    const response = await POST(postRequest(CLAIM_BODY));

    expect(response.status).toBe(403);
    expect(await bodyOf(response)).toEqual({ error: "account_deactivated" });
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("refuses an ERASED account without reaching a writer", async () => {
    control.live = { ok: false, reason: "ACCOUNT_ERASED" };

    const response = await POST(postRequest(CLAIM_BODY));

    expect(response.status).toBe(403);
    expect(await bodyOf(response)).toEqual({ error: "account_erased" });
    expect(mockClaim).not.toHaveBeenCalled();
  });
});

describe("the rate-limit budget", () => {
  it("spends ONE per-IP bucket, keyed on the caller's ADDRESS and not on anything else", async () => {
    // THE PAIR, not just the endpoint. A stub that dropped the identifier would
    // let all four of a route's buckets collapse onto one shared key and stay
    // green — the defect recorded against the turnos route's own test.
    mockLookup.mockResolvedValue({ variant: "not_found" });

    await POST(postRequest(LOOKUP_BODY));

    expect(control.limits).toEqual([
      { endpoint: "api_v1_me_pet_claims_ip", identifier: CALLER_IP },
    ]);
  });

  it("spends the SAME bucket for both commands, so alternating buys nothing", async () => {
    // The two commands share one per-user budget inside the use-cases
    // (`claim_lookup`) precisely so a burst of probes counts as one. Splitting
    // the per-IP counter would hand a prober two.
    mockLookup.mockResolvedValue({ variant: "not_found" });
    mockClaim.mockResolvedValue({ error: "…", code: "not_found" });

    await POST(postRequest(LOOKUP_BODY));
    await POST(postRequest(CLAIM_BODY));

    expect(control.limits.map((l) => l.endpoint)).toEqual([
      "api_v1_me_pet_claims_ip",
      "api_v1_me_pet_claims_ip",
    ]);
  });

  it("hands the limiter the SHARED family constant, not a number of its own", async () => {
    // The family assertion lives in `api-v1-rate-limit-families.test.ts`, which
    // reads the call site as text. This one reads what the limiter was actually
    // HANDED, which is the half a text parser cannot see: a route that owns its
    // own literal is what `route-local` means, and `route-local` is a fence
    // failure by itself. `toBe` (identity) rather than `toEqual` on purpose —
    // an inline object with the same digits would pass a value comparison and is
    // precisely the thing being refused.
    mockLookup.mockResolvedValue({ variant: "not_found" });

    await POST(postRequest(LOOKUP_BODY));

    expect(control.ceilings).toEqual([API_V1_AUTHENTICATED_WRITE_IP_LIMIT]);
    expect(control.ceilings[0]).toBe(API_V1_AUTHENTICATED_WRITE_IP_LIMIT);
  });

  it("answers 429 without reaching a writer when the bucket is spent", async () => {
    control.limiterThrows = () => {
      throw new RateLimitError(new Date(), "too many");
    };

    const response = await POST(postRequest(CLAIM_BODY));

    expect(response.status).toBe(429);
    expect(await bodyOf(response)).toEqual({ error: "rate_limited" });
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("FAILS OPEN when the limiter itself is broken", async () => {
    // The invariant `spendBudget`'s docblock argues at length, as a measurement.
    // The limiter is itself a DB write; if `rate_limit_buckets` is unavailable,
    // refusing here would stop somebody registering an animal they found to
    // their own name. Flipping that `return true` to `return false` must turn
    // THIS red — which is what the turnos route's test could not do.
    control.limiterThrows = () => {
      throw new Error("rate_limit_buckets is unavailable");
    };
    mockClaim.mockResolvedValue({ petToken: "DIM-REAL-TOKN", petName: "Rocky" });

    const response = await POST(postRequest(CLAIM_BODY));

    expect(response.status).toBe(200);
    expect(mockClaim).toHaveBeenCalledTimes(1);
  });

  it("keeps the AUTHORIZATION boundary closed while the limiter fails open", async () => {
    // The other half of the same sentence, and the one that matters: failing
    // open on the counter must not fail open on who may act. A refused liveness
    // guard is still a refusal with the limiter broken.
    control.limiterThrows = () => {
      throw new Error("rate_limit_buckets is unavailable");
    };
    control.live = { ok: false, reason: "ACCOUNT_ERASED" };

    const response = await POST(postRequest(CLAIM_BODY));

    expect(response.status).toBe(403);
    expect(mockClaim).not.toHaveBeenCalled();
  });
});

// `GET /api/v1/pets/{publicToken}` — the owner face, over bearer auth.
//
// WHAT THIS FILE EXISTS TO STOP (A11-3)
// ---------------------------------------------------------------------------
// This was the only one of 33 `/api/v1` route modules no test imported — the
// mobile app's most-called authenticated endpoint, carrying the surface's core
// anti-oracle rule (`access.kind === "none"` → 404, byte-identical for a pet
// this caller may not read and a pet that does not exist) with nothing
// exercising it directly. Mutating that line to a 403 would have kept
// `pnpm verify` green (neither `check-api-v1-envelope.ts` nor
// `check-authz-guards.ts` matches on `not_found`/`403`/`forbidden`) and kept
// the vitest suite green, turning this endpoint into an existence oracle for
// DIM tokens.
//
// WHAT THIS FILE PROVES, minimum bar from the finding:
//   1. The four `requireLiveUser` refusals map to their documented status and
//      code, and the read never runs first.
//   2. `DbBudgetExceededError` answers 503 with `retry-after`, NEVER 404 — on
//      all three budgets the handler bounds (auth, access, detail).
//   3. The not-held/not-existing pair answers the identical 404.
//
// Mocked at the same three seams `api-v1-pet-libreta-route.test.ts` uses
// (`live-user`, `pet-access`, the reader) plus the rate limiter, which this
// file does not test — every sibling route's limiter behaviour (fail-open,
// 429) is already pinned once per shape and is not this file's job to repeat.

import { beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  live: null as null | (() => unknown),
  access: null as null | (() => unknown),
  detail: null as null | (() => unknown),
}));

vi.mock("@/lib/supabase/bearer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/bearer")>();
  return {
    ...actual,
    createClientFromBearer: (header: string | null) =>
      header ? { ok: true, supabase: {}, token: "tok" } : { ok: false, reason: "MISSING" },
  };
});

vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return { ...actual, enforceRateLimit: async () => {} };
});

vi.mock("@/lib/infra/live-user", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/live-user")>();
  return {
    ...actual,
    requireLiveUser: async () =>
      control.live
        ? control.live()
        : { ok: true, supabase: {}, user: { id: OWNER_ID }, profile: null },
  };
});

vi.mock("@/lib/infra/pet-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/pet-access")>();
  return {
    ...actual,
    resolvePetHolderAccess: async () =>
      control.access ? control.access() : { kind: "owner", pet: petRow(), holderRole: "owner" },
  };
});

vi.mock("@/src/modules/pets/application/read/load-owner-pet-detail", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/src/modules/pets/application/read/load-owner-pet-detail")
    >();
  return {
    ...actual,
    loadOwnerPetDetail: async () => (control.detail ? control.detail() : {}),
  };
});

import { DbBudgetExceededError } from "@/lib/infra/db-budget";

import { GET } from "@/app/api/v1/pets/[publicToken]/route";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "DIM-PAMP-0001";

function petRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    publicToken: TOKEN,
    name: "Pampa",
    status: "active",
    pregnancyStatus: null,
    potentiallyDangerousBreed: false,
    ...overrides,
  };
}

function call(headers: Record<string, string> = { authorization: "Bearer tok" }) {
  return GET(new Request(`https://www.mimar.com.ar/api/v1/pets/${TOKEN}`, { headers }), {
    params: Promise.resolve({ publicToken: TOKEN }),
  });
}

beforeEach(() => {
  control.live = null;
  control.access = null;
  control.detail = null;
});

// ---------------------------------------------------------------------------
// Bearer gate
// ---------------------------------------------------------------------------

describe("GET /api/v1/pets/{token} — the bearer gate", () => {
  it("answers 401 auth_required with no header, before touching the guard", async () => {
    const response = await call({});
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "auth_required" });
  });

  it("answers 401 auth_required for an empty header, without reaching the guard", async () => {
    // `createClientFromBearer` is stubbed to answer `ok:true` for any NON-EMPTY
    // header in this file (see the mock above), so this only pins that an
    // empty string still reads as MISSING rather than reaching `requireLiveUser`.
    // The route's own MISSING-vs-malformed split runs against the REAL
    // `createClientFromBearer` in `api-v1-credential-route.test.ts`.
    control.live = () => {
      throw new Error("requireLiveUser must not run without a parsed bearer");
    };
    const response = await call({ authorization: "" });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "auth_required" });
  });
});

// ---------------------------------------------------------------------------
// The four `requireLiveUser` refusals, plus MAINTENANCE
// ---------------------------------------------------------------------------

describe("GET /api/v1/pets/{token} — the liveness gate", () => {
  it("answers 401 auth_expired on NO_SESSION, and never reads the pet", async () => {
    control.live = () => ({ ok: false, reason: "NO_SESSION" });
    control.access = () => {
      throw new Error("access must not be resolved after a liveness refusal");
    };
    const response = await call();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "auth_expired" });
  });

  it("answers 403 account_erased on ACCOUNT_ERASED, and never reads the pet", async () => {
    control.live = () => ({ ok: false, reason: "ACCOUNT_ERASED" });
    control.access = () => {
      throw new Error("access must not be resolved after a liveness refusal");
    };
    const response = await call();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "account_erased" });
  });

  it("answers 403 account_deactivated on DEACTIVATED, and never reads the pet", async () => {
    control.live = () => ({ ok: false, reason: "DEACTIVATED" });
    control.access = () => {
      throw new Error("access must not be resolved after a liveness refusal");
    };
    const response = await call();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "account_deactivated" });
  });

  it("answers 401 session_shift_expired on SHIFT_EXPIRED, and never reads the pet", async () => {
    control.live = () => ({ ok: false, reason: "SHIFT_EXPIRED" });
    control.access = () => {
      throw new Error("access must not be resolved after a liveness refusal");
    };
    const response = await call();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "session_shift_expired" });
  });

  it("answers 503 temporarily_unavailable with retry-after on MAINTENANCE", async () => {
    // The kill-switch refusal — grouped with the budget cases below rather than
    // with the other four, because it is the one liveness answer that is NOT a
    // 401/403 and carries the same retry-after contract a degraded read does.
    control.live = () => ({ ok: false, reason: "MAINTENANCE" });
    const response = await call();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "temporarily_unavailable" });
    expect(response.headers.get("retry-after")).toBe("5");
  });
});

// ---------------------------------------------------------------------------
// The anti-oracle rule: not-held and not-existing answer the identical 404
// ---------------------------------------------------------------------------

describe("GET /api/v1/pets/{token} — the anti-oracle rule", () => {
  it("answers 404 not_found for a pet this caller may not read", async () => {
    control.access = () => ({ kind: "none" });
    const response = await call();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });
});

// ---------------------------------------------------------------------------
// 503, never 404, on every budget the handler bounds
// ---------------------------------------------------------------------------

describe("GET /api/v1/pets/{token} — a bounded read that fails answers 503, never 404", () => {
  it("answers 503 with retry-after when the AUTH budget is exceeded", async () => {
    control.live = () => {
      throw new DbBudgetExceededError("api-v1-pet-detail-auth", 5000);
    };
    const response = await call();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "temporarily_unavailable" });
    expect(response.headers.get("retry-after")).toBe("5");
  });

  it("answers 503 with retry-after when the ACCESS budget is exceeded", async () => {
    control.access = () => {
      throw new DbBudgetExceededError("api-v1-pet-detail-access", 5000);
    };
    const response = await call();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "temporarily_unavailable" });
    expect(response.headers.get("retry-after")).toBe("5");
  });

  it("answers 503 with retry-after when the DETAIL budget is exceeded", async () => {
    // "Answering 404 to a read failure is the worst lie a public surface can
    // tell" — here it would report an animal as gone to the person responsible
    // for it, indistinguishable from a token that was never real.
    control.detail = () => {
      throw new DbBudgetExceededError("api-v1-pet-detail-load", 8000);
    };
    const response = await call();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "temporarily_unavailable" });
    expect(response.headers.get("retry-after")).toBe("5");
  });

  it("propagates a non-budget failure rather than translating it into any 4xx", async () => {
    // NON-VACUITY for the three cases above: a catch that swallowed every
    // rejection into 503 would make a genuine bug indistinguishable from a
    // bounded give-up.
    control.detail = () => {
      throw new Error("constraint violation nobody expected");
    };
    await expect(call()).rejects.toThrow("constraint violation nobody expected");
  });
});
